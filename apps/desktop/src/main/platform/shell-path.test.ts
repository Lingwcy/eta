import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@eta/agent/env/node";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { resolveShellPath } from "./shell-path.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function shellFixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-shell-path-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  await mkdir(bin);
  return {
    directory,
    bin,
    environment: {
      HOME: directory,
      ZDOTDIR: directory,
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
  };
}

test.skipIf(process.platform !== "darwin")(
  "coding tools find commands configured by a login and interactive shell after a desktop launch",
  async () => {
    const { directory, bin, environment } = await shellFixture();
    await writeFile(join(directory, ".zprofile"), `export PATH="${bin}:$PATH"\n`);
    await writeFile(
      join(directory, ".zshrc"),
      "printf 'shell startup message\\n'\nexport PATH=\"$HOME/interactive-bin:$PATH\"\n",
    );
    const command = join(bin, "eta-test-command");
    await writeFile(command, "#!/bin/sh\nprintf 'command available'\n");
    await chmod(command, 0o755);
    const path = await resolveShellPath(environment);
    expect(path?.split(":")).toContain(join(directory, "interactive-bin"));
    const env = new NodeExecutionEnv({ cwd: directory, shellEnv: { PATH: path } });
    let output = "";
    try {
      const result = await env.exec(
        "eta-test-command",
        { onOutput: (text) => (output += text) },
        BACKGROUND_CONTEXT,
      );
      expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
      expect(output).toBe("command available");
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "preserves commands supplied by a terminal launcher when shell setup replaces PATH",
  async () => {
    const { directory, bin, environment } = await shellFixture();
    await writeFile(join(directory, ".zshrc"), "export PATH=/usr/bin:/bin\n");
    const path = await resolveShellPath({ ...environment, PATH: `${bin}:/usr/bin:/bin` });
    expect(path).toBe(`/usr/bin:/bin:${bin}`);
  },
);

test.skipIf(process.platform === "win32")(
  "keeps the inherited PATH when the configured shell cannot start",
  async () => {
    const { directory, environment } = await shellFixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await resolveShellPath({ ...environment, SHELL: join(directory, "missing-shell") }),
    ).toBe(environment.PATH);
    expect(warning).toHaveBeenCalledOnce();
  },
);

test.skipIf(process.platform !== "darwin").each(["exit 0", "export PATH=''", "exit 1"])(
  "keeps the inherited PATH when shell configuration cannot report a usable PATH (%s)",
  async (configuration) => {
    const { directory, environment } = await shellFixture();
    await writeFile(join(directory, ".zshrc"), `${configuration}\n`);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveShellPath(environment)).toBe(environment.PATH);
  },
);

test.skipIf(process.platform === "win32")(
  "a stalled shell cannot block startup indefinitely",
  async () => {
    const { directory, environment } = await shellFixture();
    const shell = join(directory, "stalled-shell");
    await writeFile(shell, "#!/bin/sh\nexec /bin/sleep 30\n");
    await chmod(shell, 0o755);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveShellPath({ ...environment, SHELL: shell })).toBe(environment.PATH);
  },
  10000,
);

test("keeps the Windows environment without invoking a Unix shell", async () => {
  expect(await resolveShellPath({ PATH: "C:\\Windows", SHELL: "/missing-shell" }, "win32")).toBe(
    "C:\\Windows",
  );
});
