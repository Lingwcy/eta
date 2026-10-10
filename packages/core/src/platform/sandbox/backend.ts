import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, relative } from "node:path";
import type { SandboxPolicy, SandboxStatus } from "../../shared/sandbox.ts";

export interface SandboxLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  status: SandboxStatus;
  cleanup(): Promise<void>;
  verify?(pid: number): Promise<void>;
}
const run = promisify(execFile);
let sourceCleanup: Promise<string> | undefined;
let sourceLauncher: Promise<string> | undefined;
async function linuxLauncher(worker: string) {
  const packaged = join(dirname(worker), "sandbox-launcher");
  if (await executable(packaged)) return packaged;
  if (!worker.endsWith(".ts")) return undefined;
  sourceLauncher ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "eta-sandbox-native-"));
    const output = join(directory, "sandbox-launcher");
    await run("cc", [
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(dirname(worker), "linux-launcher.c"),
      "-o",
      output,
    ]);
    return output;
  })();
  return sourceLauncher;
}
async function macCleanupHelper(worker: string) {
  const packaged = join(dirname(worker), "sandbox-cleanup");
  if (await executable(packaged)) return packaged;
  if (!worker.endsWith(".ts")) throw new Error("沙盒进程回收程序缺失，请重新安装 Eta");
  sourceCleanup ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "eta-sandbox-native-"));
    const output = join(directory, "sandbox-cleanup");
    await run("/usr/bin/clang", [
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(dirname(worker), "mac-cleanup.c"),
      "-o",
      output,
    ]);
    return output;
  })();
  return sourceCleanup;
}

export function sanitizedEnvironment(scratch: string): NodeJS.ProcessEnv {
  const keys = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "SystemRoot", "WINDIR", "PATHEXT"];
  return {
    ...Object.fromEntries(
      keys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    ),
    HOME: scratch,
    USERPROFILE: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    ELECTRON_RUN_AS_NODE: "1",
  };
}

async function executable(path: string) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function sandboxStatus(policy: SandboxPolicy): Promise<SandboxStatus> {
  if (policy.mode === "danger-full-access")
    return { mode: policy.mode, backend: "none", available: true };
  if (process.platform === "darwin" && (await executable("/usr/bin/sandbox-exec")))
    return { mode: policy.mode, backend: "seatbelt", available: true };
  if (process.platform === "linux" && (await findBubblewrap()))
    return { mode: policy.mode, backend: "bubblewrap", available: true };
  return {
    mode: policy.mode,
    backend: "unavailable",
    available: false,
    reason:
      process.platform === "win32"
        ? "此版本尚未提供 Windows 原生沙盒，受限执行已阻止。"
        : "沙盒后端不可用，请安装 bubblewrap 或修复系统沙盒。",
  };
}

async function findBubblewrap() {
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
    const path = resolve(directory, "bwrap");
    if (await executable(path)) return path;
  }
  return undefined;
}

const quote = (path: string) => JSON.stringify(path);
export function seatbeltProfile(
  readable: readonly string[],
  writable: readonly string[],
  denied: readonly string[],
  network: boolean,
  immutable: readonly string[] = [],
) {
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(deny process-info-setcontrol)",
    "(allow sysctl-read)",
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    ...(network
      ? [
          '(allow network-bind (local ip "*:*"))',
          '(allow network-inbound (local ip "*:*"))',
          '(allow network-outbound (remote ip "*:*"))',
          '(allow mach-lookup (global-name "com.apple.system.config.network_change") (global-name "com.apple.mDNSResponder") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SecurityServer") (global-name "com.apple.trustd.agent"))',
        ]
      : []),
    "(allow file-read-metadata)",
    "(deny file-write*)",
    ...writable.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    '(allow file-write* (literal "/dev/null"))',
    // dyld opens the root directory during startup; grant that directory, never its subtree.
    `(allow file-read-data ${readable.map((path) => `(subpath ${quote(path)})`).join(" ")} (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))`,
    ...denied.map(
      (path) => `(deny file-read-data file-read-metadata file-write* (subpath ${quote(path)}))`,
    ),
    ...immutable.map((path) => `(deny file-write* (subpath ${quote(path)}))`),
  ].join("\n");
}

async function existingRoots(paths: readonly string[]) {
  const roots: string[] = [];
  for (const path of paths) {
    try {
      roots.push(await realpath(path));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return [...new Set(roots)];
}

export async function canonicalRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalRoot(parent), basename(absolute));
  }
}

async function packageManifests(worker: string) {
  const paths: string[] = [];
  for (let directory = dirname(worker); ; directory = dirname(directory)) {
    paths.push(join(directory, "package.json"));
    if (dirname(directory) === directory) break;
  }
  return existingRoots(paths);
}

/** Builds a native sandbox launch; a missing backend never produces an unrestricted command. */
export async function prepareSandboxLaunch(
  policy: SandboxPolicy,
  workerPath: string,
  runtimeRoots: readonly string[] = [],
): Promise<SandboxLaunch> {
  const networkAccess = policy.networkAccess ?? policy.mode === "workspace-write";
  const launcher =
    process.platform === "linux" && policy.mode !== "danger-full-access"
      ? await linuxLauncher(workerPath)
      : undefined;
  const status: SandboxStatus =
    process.platform === "linux" && policy.mode !== "danger-full-access" && launcher
      ? { mode: policy.mode, backend: "landlock", available: true }
      : await sandboxStatus(policy);
  if (!status.available) throw new Error(status.reason);
  const workspace = await realpath(policy.workspaceRoot);
  const worker = await realpath(workerPath);
  const runtime = await realpath(process.execPath);
  const scratch = await realpath(
    policy.scratchRoot ?? (await mkdtemp(join(tmpdir(), "eta-sandbox-"))),
  );
  const cleanup = () =>
    policy.scratchRoot ? Promise.resolve() : rm(scratch, { recursive: true, force: true });
  try {
    const platformRoots =
      process.platform === "darwin"
        ? [
            "/System",
            "/usr",
            "/bin",
            "/sbin",
            "/Library",
            "/private/var/db/dyld",
            "/private/preboot",
            "/opt/homebrew/bin",
            "/opt/homebrew/lib",
            "/opt/homebrew/Cellar",
            "/opt/homebrew/opt",
            "/private/etc/ssl",
            "/private/etc/hosts",
            "/private/etc/resolv.conf",
          ]
        : [
            "/usr",
            "/bin",
            "/sbin",
            "/lib",
            "/lib64",
            "/etc/ld.so.cache",
            "/etc/ld.so.conf",
            "/etc/ld.so.conf.d",
            "/etc/nsswitch.conf",
            "/etc/hosts",
            "/etc/resolv.conf",
            "/etc/ssl",
          ];
    const dependencies = await existingRoots([
      ...(await packageManifests(worker)),
      ...(process.platform === "darwin" ? [join(dirname(runtime), "../Frameworks")] : []),
    ]);
    const immutable = [dirname(worker), dirname(runtime), ...dependencies];
    const readable = await existingRoots([
      workspace,
      scratch,
      dirname(worker),
      dirname(runtime),
      ...dependencies,
      ...platformRoots,
      ...runtimeRoots,
      ...(policy.readableRoots ?? []),
      ...(policy.writableRoots ?? []),
    ]);
    const writable = [
      scratch,
      ...(await Promise.all((policy.writableRoots ?? []).map(canonicalRoot))),
      ...(policy.mode === "workspace-write" ? [workspace] : []),
    ];
    const deniedPaths = [
      ...[".ssh", ".aws", ".azure", ".gnupg", ".codex"].map((path) => join(homedir(), path)),
      ...(policy.deniedRoots ?? []),
    ];
    const denied = [
      ...new Set([
        ...deniedPaths.map((path) => resolve(path)),
        ...(await Promise.all(deniedPaths.map(canonicalRoot))),
      ]),
    ];
    const nodeArgs = [
      ...(worker.endsWith(".ts") ? ["--import", join(dirname(worker), "source-loader.ts")] : []),
      worker,
    ];
    const env = sanitizedEnvironment(scratch);
    if (status.backend === "none") {
      env.HOME = homedir();
      env.USERPROFILE = homedir();
    }
    if (status.backend === "none")
      return { command: runtime, args: nodeArgs, cwd: workspace, env, status, cleanup };
    if (status.backend === "seatbelt") {
      const helper = await macCleanupHelper(worker);
      const markerRoot = await realpath(await mkdtemp(join(tmpdir(), "eta-sandbox-identity-")));
      const marker = join(markerRoot, "readable");
      const sentinel = join(markerRoot, "denied");
      await writeFile(marker, "");
      await writeFile(sentinel, "");
      return {
        command: "/usr/bin/sandbox-exec",
        args: [
          "-p",
          seatbeltProfile(
            [...readable, markerRoot],
            writable,
            [...denied, sentinel],
            networkAccess,
            [...immutable, markerRoot, dirname(helper)],
          ),
          runtime,
          ...nodeArgs,
        ],
        cwd: workspace,
        env,
        status,
        verify: async (pid) => {
          await run(helper, ["--verify", String(pid), marker, sentinel]);
        },
        cleanup: async () => {
          // The marker survives the worker: double-forked or reparented descendants retain its policy.
          try {
            await run(helper, [marker, sentinel]);
          } finally {
            await cleanup();
            await rm(markerRoot, { recursive: true, force: true });
          }
        },
      };
    }
    if (status.backend === "landlock") {
      const contains = (root: string, path: string) => {
        const suffix = relative(root, path);
        return (
          suffix === "" || (!suffix.startsWith("../") && suffix !== ".." && !isAbsolute(suffix))
        );
      };
      // Landlock has additive path grants. Reject roots that would include protected data instead of
      // weakening exclusions; deployments keep application data and binaries outside project roots.
      if (
        denied.some((protectedRoot) =>
          readable.some((root) => contains(root, protectedRoot) || contains(protectedRoot, root)),
        ) ||
        immutable.some((path) =>
          writable.some((root) => contains(root, path) || contains(path, root)),
        )
      )
        throw new Error("Landlock 沙盒要求项目目录与应用数据、凭证目录和执行程序分离");
      return {
        command: launcher!,
        args: [
          ...readable.flatMap((root) => ["--read", root]),
          ...writable.flatMap((root) => ["--write", root]),
          "--read",
          "/dev/urandom",
          "--read",
          "/dev/random",
          "--write",
          "/dev/null",
          ...(networkAccess ? ["--network"] : []),
          "--",
          runtime,
          ...nodeArgs,
        ],
        cwd: workspace,
        env,
        status,
        cleanup,
      };
    }
    const bwrap = await findBubblewrap();
    if (!bwrap) throw new Error("bubblewrap is unavailable");
    if (networkAccess)
      throw new Error("bubblewrap 后备沙盒不支持联网授权，请安装原生 sandbox-launcher");
    const args = [
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      ...(networkAccess ? [] : ["--unshare-net"]),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
    ];
    for (const root of readable) args.push("--ro-bind", root, root);
    for (const root of writable) args.push("--bind", root, root);
    for (const root of immutable) args.push("--ro-bind", root, root);
    // Mount existing protected paths last so overlapping workspace grants cannot expose them.
    for (const root of await existingRoots(denied)) {
      if (!isAbsolute(root)) throw new Error("Sandbox paths must be absolute");
      const { stat } = await import("node:fs/promises");
      args.push(
        ...((await stat(root)).isDirectory()
          ? ["--tmpfs", root]
          : ["--ro-bind", "/dev/null", root]),
      );
    }
    args.push("--chdir", workspace, "--", runtime, ...nodeArgs);
    return { command: bwrap, args, cwd: workspace, env, status, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
