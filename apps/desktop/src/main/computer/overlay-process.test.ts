import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vite-plus/test";
const fake = vi.hoisted(() => ({
  children: [] as FakeChild[],
  spawn: vi.fn(),
  remove: vi.fn(async () => {}),
}));
class FakeChild extends EventEmitter {
  pid = fake.children.length + 100;
  connected = true;
  exitCode = null;
  signalCode = null;
  sent: unknown[] = [];
  stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  send(value: unknown, callback?: (error: Error | null) => void) {
    this.sent.push(value);
    callback?.(null);
  }
  disconnect() {
    this.connected = false;
  }
  kill() {
    return true;
  }
}
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));
vi.mock("node:fs", () => ({ mkdtempSync: () => "/tmp/eta-overlay-test-unused" }));
vi.mock("node:fs/promises", () => ({ rm: fake.remove }));
vi.mock("../i18n.ts", () => ({ mainI18n: { language: "en" } }));
import { createComputerOverlayProcess } from "./overlay-process.ts";
const hosts: ReturnType<typeof createComputerOverlayProcess>[] = [];
function fixture() {
  vi.useFakeTimers();
  fake.spawn.mockImplementation(() => {
    const child = new FakeChild();
    fake.children.push(child);
    return child;
  });
  const stopped: string[] = [],
    host = createComputerOverlayProcess("/runtime", async (id) => {
      stopped.push(id);
    });
  hosts.push(host);
  return { stopped, host };
}
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  fake.children = [];
  vi.clearAllMocks();
});
test("late messages and exit from a retired presentation process cannot stop its replacement", () => {
  const { host, stopped } = fixture();
  host.update({ type: "start", id: "old" });
  const old = fake.children[0]!;
  host.update({ type: "end", id: "old" });
  host.update({ type: "start", id: "new" });
  const current = fake.children[1]!;
  old.emit("message", "ready");
  old.emit("message", "stop");
  old.emit("exit");
  expect(stopped).toEqual([]);
  expect(current.connected).toBe(true);
  expect(old.sent).toEqual([]);
  current.emit("message", "ready");
  expect(current.sent).toMatchObject([{ event: { type: "start", id: "new" } }]);
  current.emit("message", "stop");
  expect(stopped).toEqual(["new"]);
  expect(current.connected).toBe(false);
});
test("startup discards a previous target's pixels and a stuck presentation process stops its own admission", () => {
  const { host, stopped } = fixture();
  host.update({ type: "start", id: "one" });
  host.update({
    type: "frame",
    id: "one",
    image: { type: "image", data: "old", mimeType: "image/png" },
  });
  host.update({
    type: "target",
    id: "one",
    target: { id: "new", app: "test", windowTitle: "new", text: "" },
  });
  host.update({
    type: "frame",
    id: "one",
    image: { type: "image", data: "current", mimeType: "image/png" },
  });
  const child = fake.children[0]!;
  child.emit("message", "ready");
  expect(JSON.stringify(child.sent)).not.toContain('"data":"old"');
  expect(JSON.stringify(child.sent)).toContain('"data":"current"');
  host.update({ type: "end", id: "one" });
  host.update({ type: "start", id: "two" });
  vi.advanceTimersByTime(8000);
  expect(stopped).toEqual(["two"]);
  expect(host.pid()).toBeUndefined();
});
