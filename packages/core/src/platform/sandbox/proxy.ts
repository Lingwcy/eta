import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const proxyKeys = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

/** Static macOS proxies work for command-line tools too; PAC scripts need a local proxy endpoint. */
export function macProxyEnvironment(configuration: string): NodeJS.ProcessEnv {
  const value = (key: string) =>
    configuration.match(new RegExp("^\\s*" + key + "\\s*:\\s*(.*?)\\s*$", "m"))?.[1];
  const result: NodeJS.ProcessEnv = {};
  for (const [kind, key, scheme] of [
    ["HTTP", "http_proxy", "http"],
    ["HTTPS", "https_proxy", "http"],
    ["SOCKS", "all_proxy", "socks5h"],
  ] as const) {
    if (value(kind + "Enable") !== "1") continue;
    const host = value(kind + "Proxy");
    const port = Number(value(kind + "Port"));
    if (!host || /[/?#@\s]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      continue;
    try {
      const url = new URL(
        scheme +
          "://" +
          (host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host) +
          ":" +
          port,
      );
      if (
        url.username ||
        url.password ||
        (url.pathname !== "" && url.pathname !== "/") ||
        url.search ||
        url.hash
      )
        continue;
      result[key] = url.origin === "null" ? scheme + "://" + url.host : url.origin;
    } catch {
      // Ignore malformed system entries without preventing sandbox startup.
    }
  }
  const exceptions = configuration.match(/ExceptionsList\s*:\s*<array>\s*{([^}]*?)}/)?.[1];
  const bypass = exceptions?.split("\n").flatMap((line) => {
    const host = line.match(/^\s*\d+\s*:\s*(\S+)\s*$/)?.[1];
    return host ? [host.startsWith("*.") ? host.slice(1) : host] : [];
  });
  if (bypass?.length) result.no_proxy = bypass.join(",");
  return result;
}

/** Safe projection for both the host-to-worker and worker-to-command boundaries. */
export function inheritedProxyEnvironment(environment: NodeJS.ProcessEnv) {
  const result: Record<string, string> = {};
  for (const key of proxyKeys) {
    const value = environment[key] ?? environment[key.toUpperCase()];
    if (value !== undefined) result[key] = result[key.toUpperCase()] = value;
  }
  return result;
}

/** Copy only proxy settings, never unrelated host tokens. Explicit environment settings take precedence. */
export async function proxyEnvironment(
  environment = process.env,
  platform = process.platform,
  system = async () =>
    (await run("/usr/sbin/scutil", ["--proxy"], { timeout: 2000, maxBuffer: 65536 })).stdout,
): Promise<NodeJS.ProcessEnv> {
  const result = inheritedProxyEnvironment(environment);
  // Never mix a caller's proxy routing with unrelated system endpoints or bypass rules.
  if (platform === "darwin" && !proxyKeys.slice(0, 3).some((key) => result[key] !== undefined)) {
    try {
      const defaults = macProxyEnvironment(await system());
      for (const key of proxyKeys)
        if (result[key] === undefined && defaults[key] !== undefined)
          result[key] = result[key.toUpperCase()] = defaults[key];
    } catch {
      // System proxy discovery is best effort; native network restrictions remain authoritative.
    }
  }
  return result;
}
