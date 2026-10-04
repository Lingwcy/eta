import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Arguments remain separate from executable paths, including paths containing spaces. */
export async function openWithApplication(
  file: string,
  application: string,
  platform = process.platform,
) {
  if (platform === "darwin") {
    await execute("/usr/bin/open", ["-a", application, file]);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(application, [file], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
