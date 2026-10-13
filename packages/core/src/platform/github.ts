import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { GitHubIdentity } from "../shared/github.ts";

export interface GitHubResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}
/** A host-provided transport session pins credentials for a query; credentials never enter the client DTO. */
export interface GitHubSession {
  readonly key: string;
  readonly identity: GitHubIdentity;
  request(path: string): Promise<GitHubResponse>;
}
export interface GitHubAdapter {
  session(): Promise<GitHubSession>;
}

const Login = Schema.Struct({ login: Schema.NonEmptyString });
const exec = promisify(execFile);
/** Uses the host's gh login when available, otherwise anonymous HTTPS for public repositories. */
export const defaultGitHubAdapter: GitHubAdapter = {
  async session() {
    const token = await exec("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }).then(
      (result) => result.stdout.trim(),
      () => undefined,
    );
    const request = async (path: string): Promise<GitHubResponse> => {
      if (token) {
        const stdout = await exec("gh", ["api", "--hostname", "github.com", "--include", path], {
          timeout: 15000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, GH_TOKEN: token, GH_HOST: "github.com" },
        }).then(
          (result) => result.stdout,
          (error: unknown) => {
            if (
              error instanceof Error &&
              "stdout" in error &&
              typeof error.stdout === "string" &&
              error.stdout.startsWith("HTTP/")
            )
              return error.stdout;
            throw new Error("GitHub CLI request failed");
          },
        );
        const separator = stdout.match(/\r?\n\r?\n/);
        if (!separator || separator.index === undefined)
          throw new Error("Invalid GitHub CLI response");
        const header = stdout.slice(0, separator.index).split(/\r?\n/);
        const status = Number(header.shift()?.match(/^HTTP\/[\d.]+ (\d+)/)?.[1]);
        const headers: Record<string, string> = {};
        for (const line of header) {
          const split = line.indexOf(":");
          if (split > 0) headers[line.slice(0, split).toLowerCase()] = line.slice(split + 1).trim();
        }
        return {
          status,
          headers,
          body: JSON.parse(stdout.slice(separator.index + separator[0].length)),
        };
      }
      const response = await fetch(new URL(path, "https://api.github.com/"), {
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Eta",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.json(),
      };
    };
    let login: string | undefined;
    if (token) {
      const user = await request("user");
      if (user.status === 200) login = Schema.decodeUnknownSync(Login)(user.body).login;
    }
    return {
      key: token
        ? `${createHash("sha256").update(token).digest("hex")}:${login ?? "unauthenticated"}`
        : "anonymous",
      identity: {
        authenticated: Boolean(login),
        source: token ? "gh" : "anonymous",
        ...(login ? { login } : {}),
      },
      request,
    };
  },
};
