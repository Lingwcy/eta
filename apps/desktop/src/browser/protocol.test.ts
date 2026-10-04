import { expect, test } from "vite-plus/test";
import { browserAddress, desktopShortcut } from "./protocol.ts";

test("addresses support domains, local servers, full URLs and search queries", () => {
  expect(browserAddress(" example.com/path?q=1 ")).toBe("https://example.com/path?q=1");
  expect(browserAddress("localhost:5173/page")).toBe("http://localhost:5173/page");
  expect(browserAddress("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
  expect(browserAddress("https://example.com/#fragment")).toBe("https://example.com/#fragment");
  expect(browserAddress("Eta 标签栏")).toBe(
    "https://duckduckgo.com/?q=Eta%20%E6%A0%87%E7%AD%BE%E6%A0%8F",
  );
});

test.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "file:///etc/passwd",
  "ftp://example.com",
  "",
])("unsupported address %s cannot enter guest contents", (url) =>
  expect(() => browserAddress(url)).toThrow(),
);

test("browser shortcuts work with both platform modifiers and preserve ordinary typing", () => {
  expect(desktopShortcut({ key: "t", meta: true })).toBe("new-browser");
  expect(desktopShortcut({ key: "T", control: true, shift: true })).toBe("reopen-tab");
  expect(desktopShortcut({ key: "Tab", control: true, shift: true })).toBe("previous-tab");
  expect(desktopShortcut({ key: "w", control: true })).toBe("close-tab");
  expect(desktopShortcut({ key: "9", meta: true })).toEqual({ select: 8 });
  expect(desktopShortcut({ key: "l", meta: true })).toBe("focus-address");
  expect(desktopShortcut({ key: "t" })).toBeUndefined();
  expect(desktopShortcut({ key: "t", control: true, alt: true })).toBeUndefined();
});
