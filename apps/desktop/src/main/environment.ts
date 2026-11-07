import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * 在 core 服务初始化前，将可选的本地 .env 配置补充到主进程环境变量中；
 * 正常开发无需创建这些文件，启动脚本、系统环境和持久化设置已提供常用配置。
 *
 * 相对 root 依次读取 .env、.env.local、apps/desktop/.env、apps/desktop/.env.local。
 * 仅填充尚未定义的变量：进程已有值优先，文件之间先读到的值优先（.local 不覆盖 .env）。
 * 文件不存在时跳过；每次调用都会重新读取，并非内部保证只执行一次。
 * 开发时 root 是仓库根目录；发布时是应用包路径，当前打包流程不携带这些文件。
 *
 * 支持标准 .env 键值格式，不限定变量名；只有加载后读取 process.env 的代码或依赖
 * 才能使用这些值，写入未被读取的变量不会增加应用配置能力。
 * ETA_WEB_PORT 在开发启动脚本中读取，ETA_WORKSPACE 在调用本方法前读取，
 * 因而需在启动进程前设置，不能靠这里的文件改变本次启动的端口或默认工作目录。
 * ETA_WEB_URL 由开发启动脚本自动注入；模型凭据和用户设置主要由
 * userData 下的 credentials.json、settings.json 管理，不是此方法的必填配置。
 */
export async function loadProjectEnvironment(root: string): Promise<void> {
  for (const name of [".env", ".env.local", "apps/desktop/.env", "apps/desktop/.env.local"]) {
    try {
      const values = parseEnv(await readFile(resolve(root, name), "utf8"));
      for (const [key, value] of Object.entries(values)) process.env[key] ??= value;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
