import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore, type CoreClient } from "../src/client.ts";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-schedule-request-"));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "test", models: [{ id: "one" }] }).provider);
  const open = async () => {
    const core = await createCore({
      dataRoot: join(directory, "data"),
      home: directory,
      models,
      settings: {
        read: Effect.succeed({
          defaultProvider: "test",
          defaultModel: "one",
          defaultThinkingLevel: "off",
        }),
        subscribe: () => () => {},
      },
      environment: { userAgent: "eta-core-test", shutdown: "preserve" },
    });
    clients.push(core);
    return core;
  };
  const core = await open();
  const project = await core.registerProject(cwd);
  const workspace = (await core.workspaces(project.id))[0]!;
  const thread = await core.createThread(workspace.id);
  return { core, open, threadId: thread.id };
}
const ids = ["toString", "constructor", "__proto__"];
const cases = (["write", "propose", "decide", "run"] as const).flatMap((action) =>
  ids.map((requestId) => ({ action, requestId })),
);

test("missing schedule requests do not resolve inherited object properties", async () => {
  const { core } = await fixture();
  for (const requestId of ids) expect(await core.scheduleRequest({ requestId })).toBeUndefined();
});

test.each(cases)(
  "schedule $action accepts and durably replays request ID $requestId",
  async ({ action, requestId }) => {
    const { core, open, threadId } = await fixture();
    const change = {
      action: "create" as const,
      name: "Review",
      prompt: "Review repository",
      rule: { type: "once" as const, at: Date.now() + 3_600_000 },
    };
    const create = { threadId, name: change.name, prompt: change.prompt, rule: change.rule };
    let invoke: (client: CoreClient) => ReturnType<CoreClient["createSchedule"]>;
    if (action === "write") {
      invoke = (client) => client.createSchedule({ ...create, requestId });
    } else if (action === "propose") {
      invoke = (client) =>
        client.proposeScheduleChange({
          threadId,
          requestId,
          sourceIdentity: "fixture:proposal",
          change,
        });
    } else if (action === "decide") {
      const proposal = await core.proposeScheduleChange({
        threadId,
        requestId: "seed-proposal",
        sourceIdentity: "fixture:proposal",
        change,
      });
      const pending = (await core.listScheduleProposals({ threadId })).find(
        (value) => value.id === proposal.proposalId,
      )!;
      invoke = (client) =>
        client.approveScheduleProposal({
          requestId,
          proposalId: pending.id,
          contentFingerprint: pending.contentFingerprint,
        });
    } else {
      const schedule = await core.createSchedule({ ...create, requestId: "seed-schedule" });
      invoke = (client) =>
        client.runScheduleNow({ requestId, scheduleId: schedule.scheduleId!, expectedRevision: 1 });
    }
    const receipt = await invoke(core);
    expect(receipt).toMatchObject({ state: "applied", requestId });
    expect(await core.scheduleRequest({ requestId })).toEqual(receipt);
    expect(await invoke(core)).toEqual(receipt);
    const before = await core.scheduleSnapshot();
    await core.close();
    const reopened = await open();
    expect(await reopened.scheduleRequest({ requestId })).toEqual(receipt);
    expect(await invoke(reopened)).toEqual(receipt);
    expect(await reopened.scheduleSnapshot()).toEqual(before);
    await expect(
      reopened.createSchedule({ ...create, name: "Different input", requestId }),
    ).rejects.toMatchObject({ code: "InvalidInput" });
  },
);
