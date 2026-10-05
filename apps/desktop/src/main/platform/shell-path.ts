import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { delimiter } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const marker = "\0eta-shell-path\0";

/** Desktop launches inherit a minimal PATH; recover shell setup once before opening runtimes. */
export async function resolveShellPath(environment = process.env, platform = process.platform) {
  if (platform === "win32") return environment.PATH;
  try {
    const { stdout } = await execute(
      environment.SHELL || userInfo().shell || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
      ["-ilc", "printf '\\0eta-shell-path\\0%s\\0' \"$PATH\""],
      {
        env: environment,
        cwd: environment.HOME,
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
    const start = stdout.indexOf(marker);
    const end = stdout.indexOf("\0", start + marker.length);
    if (start < 0 || end < 0) throw new Error("Login shell did not report its PATH");
    const shellPath = stdout.slice(start + marker.length, end);
    if (!shellPath) throw new Error("Login shell reported an empty PATH");
    // Retain paths supplied by a terminal or development launcher as well as shell setup.
    return [
      ...new Set([...shellPath.split(delimiter), ...(environment.PATH?.split(delimiter) ?? [])]),
    ].join(delimiter);
  } catch (error) {
    console.warn("Unable to load login shell PATH; using the inherited PATH", error);
    return environment.PATH;
  }
}
