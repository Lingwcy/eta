import { expect, test, vi } from "vite-plus/test";
import { macProxyEnvironment, proxyEnvironment } from "../../src/platform/sandbox/proxy.ts";

const configuration = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 1
  HTTPSProxy : ::1
  HTTPSPort : 7891
  SOCKSEnable : 1
  SOCKSProxy : localhost
  SOCKSPort : 7892
  ExceptionsList : <array> {
    0 : localhost
    1 : *.local
    2 : 127.0.0.1
  }
}`;

test("system static HTTP, HTTPS and SOCKS proxies become CLI proxy settings with bypass rules", async () => {
  const system = vi.fn(async () => configuration);
  expect(await proxyEnvironment({}, "darwin", system)).toEqual({
    http_proxy: "http://127.0.0.1:7890",
    HTTP_PROXY: "http://127.0.0.1:7890",
    https_proxy: "http://[::1]:7891",
    HTTPS_PROXY: "http://[::1]:7891",
    all_proxy: "socks5h://localhost:7892",
    ALL_PROXY: "socks5h://localhost:7892",
    no_proxy: "localhost,.local,127.0.0.1",
    NO_PROXY: "localhost,.local,127.0.0.1",
  });
  expect(system).toHaveBeenCalledOnce();
});

test.each(["darwin", "linux", "win32"] as const)(
  "%s inherits explicit proxies without unrelated host secrets or system routing",
  async (platform) => {
    const system = vi.fn(async () => configuration);
    expect(
      await proxyEnvironment(
        {
          http_proxy: "http://user:password@127.0.0.1:8080",
          HTTP_PROXY: "http://ignored:80",
          HTTPS_PROXY: "http://127.0.0.1:8081",
          ALL_PROXY: "socks5h://127.0.0.1:1080",
          NO_PROXY: "localhost,example.test",
          GH_TOKEN: "host-secret",
        },
        platform,
        system,
      ),
    ).toEqual({
      http_proxy: "http://user:password@127.0.0.1:8080",
      HTTP_PROXY: "http://user:password@127.0.0.1:8080",
      https_proxy: "http://127.0.0.1:8081",
      HTTPS_PROXY: "http://127.0.0.1:8081",
      all_proxy: "socks5h://127.0.0.1:1080",
      ALL_PROXY: "socks5h://127.0.0.1:1080",
      no_proxy: "localhost,example.test",
      NO_PROXY: "localhost,example.test",
    });
    expect(system).not.toHaveBeenCalled();
  },
);

test("an explicit empty proxy disables system discovery and an explicit bypass overrides system bypass", async () => {
  const system = vi.fn(async () => configuration);
  expect(await proxyEnvironment({ http_proxy: "" }, "darwin", system)).toEqual({
    http_proxy: "",
    HTTP_PROXY: "",
  });
  expect(system).not.toHaveBeenCalled();
  expect(await proxyEnvironment({ NO_PROXY: "private.test" }, "darwin", system)).toMatchObject({
    http_proxy: "http://127.0.0.1:7890",
    no_proxy: "private.test",
    NO_PROXY: "private.test",
  });
});

test("unavailable system configuration and PAC-only configurations do not block sandbox startup", async () => {
  expect(
    await proxyEnvironment({}, "darwin", async () => {
      throw new Error("unavailable");
    }),
  ).toEqual({});
  expect(
    macProxyEnvironment(
      "ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : https://example.test/proxy.pac",
    ),
  ).toEqual({});
  expect(macProxyEnvironment("HTTPEnable : 0\nHTTPProxy : localhost\nHTTPPort : 8080")).toEqual({});
});

test.each(["0", "65536", "not-a-port", "1.5"])("malformed system port %s is ignored", (port) => {
  expect(macProxyEnvironment("HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : " + port)).toEqual(
    {},
  );
});
