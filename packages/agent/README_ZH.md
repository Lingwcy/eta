# @earendil-works/pi-durable

> **实验性项目。** 不同版本之间的 API 可能发生变化，恕不另行通知。

一个支持持久化执行的智能体运行框架（Harness）。对话、模型轮次、工具调用以及你自己的状态，都会先提交到存储，再对外展示。如果进程在某个轮次中途终止，重新打开存储即可从中断处继续工作。

模型访问基于 [`@earendil-works/pi-ai`](../ai/README.md)，文档状态基于 `@earendil-works/chord`。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [核心概念](#核心概念)
- [持久化与恢复](#持久化与恢复)
- [扩展](#扩展)
- [工具](#工具)
- [系统提示词](#系统提示词)
- [每个对话的智能体配置](#每个对话的智能体配置)
- [设置](#设置)
- [执行环境](#执行环境)
- [重新加载](#重新加载)
- [观察对话](#观察对话)
- [忙碌中的对话](#忙碌中的对话)
- [重置与交接](#重置与交接)
- [上下文压缩](#上下文压缩)
- [智能体事件（实验性）](#智能体事件实验性)
- [钩子](#钩子)
- [更多对话与分支](#更多对话与分支)
- [中止与子智能体](#中止与子智能体)
- [子任务](#子任务)
- [任务图](#任务图)
- [自定义状态](#自定义状态)
- [用量与费用](#用量与费用)
- [存储](#存储)
- [示例](#示例)
- [设计文档](#设计文档)

## 安装

```bash
npm install @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

## 快速开始

```typescript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const models = createModels();
models.setProvider(openaiProvider()); // 读取 OPENAI_API_KEY

const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry: createRegistry() },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "openai", modelId: "gpt-6-sol" } },
});

const submission = await root.submit(
  { type: "input", content: "What is the capital of France?" },
  context,
);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
  const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  console.log(answer?.model?.[0]);
}
await harness.close(context);
```

上面的代码完成了以下操作：

- `Harness.open()` 在存储后端上打开一个会话（Session）。`MemoryStorage` 将所有内容保存在内存中。
- `root()` 返回根对话，首次使用时按照给定的智能体配置创建它。对话是由不可变条目组成的记录。
- `submit()` 持久化接收输入，并返回一个 `Submission`。内置的生成任务调用模型，再追加回答。
- 输入得到回答（`done`）或失败（`unanswered`，附带原因）后，`wait()` 返回。

每个异步调用都接收一个携带取消信号的 Chord `Context`。`BACKGROUND_CONTEXT` 永远不会取消。取消等待只会取消本次等待，不会取消实际工作。

## 核心概念

- **Harness（运行框架）**：一个已打开的存储实例，以及在其上运行智能体的机制。所有变更都经过同一条原子提交序列，提交写入存储后才会对外展示。
- **Conversation（对话）**：对话记录。`root()` 在首次使用时创建根对话；你可以创建更多对话，也可以创建分支。`Conversation` 句柄不持有状态；比较句柄时应使用 `id`。
- **Entry（条目）**：一条不可变的对话记录，例如用户消息（`pi.user`）、模型响应（`pi.assistant`）、工具结果（`pi.tool-result`）、系统提示词变更（`pi.system`）、重置（`pi.reset`）或自定义类型。模型只能看到最近一次重置之后的条目。
- **Commit（提交）**：一次原子写入。`conversation.commit((tx) => ...)` 可以同时追加条目、修改文档和创建任务；这些操作要么全部存储，要么全部不存储。
- **Document（文档）**：与对话记录一同存储、通过提交修改的有类型 JSON 状态。内置文档保存每个对话的智能体配置（`pi.agent`）、正在运行的生成任务和工具（`pi.live`）、排队中的提交（`pi.inbox`）以及用量与费用（`pi.usage`）。
- **Task（任务）**：持久化状态机，每一步都保存检查点，因此进程重启后可以从最后一个检查点继续。每个任务都有归属方：所属对话或另一个任务。Harness 通过内置任务生成回答：`pi.generation` 调用模型，并拥有对应工具调用的 `pi.tool` 任务，等待它们完成后，将本次运行交给下一个生成任务。
- **Submission（提交项）**：交给对话的内容，可以是用户输入，也可以是待写入的条目；你可以等待其完成。
- **Turn 与 run（轮次与运行）**：一个轮次包含一次模型响应及其工具调用；一次运行包含从输入到最终回答的所有轮次。运行尚未结束时，对话处于忙碌状态。
- **Extension（扩展）**：一个具名集合，包含工具、系统提示词段落、钩子、包装器和任务。
- **Registry（注册表）**：当前进程安装的扩展集合。Harness 运行期间可以修改它；新工作使用更新后的状态。
- **Agent（智能体）**：对话运行时使用的配置，包括模型、思考等级、选中的扩展、工具、指令和工作目录。每个对话以名称形式将其存入 `pi.agent`，每次使用时再通过注册表解析。

一次输入得到回答的条目与任务流程如下：

```text
submit(input) → pi.user
  pi.generation → pi.system (仅在提示词或工具发生变化时), pi.assistant （工具调用）
    pi.tool × n → pi.tool-result × n   （归属于生成任务，由生成任务等待它们）
  pi.generation → pi.assistant （回答）→ 提交项完成
```

## 持久化与恢复

使用 SQLite 或 JSONL 存储，可以在重启后保留对话：

```typescript
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const harness = await Harness.open(
  await openNodeSqliteStorage("./session.sqlite"),
  { models, registry },
  context,
);
const root = await harness.root(context); // 与上次相同的根对话
harness.resume(); // 继续上一个进程未完成的运行
```

因崩溃或关闭而中断的工作会保持待处理状态。`resume()` 会启动任务调度器；提交或等待也会启动它。使用相同 `requestId` 重试提交时，会返回已有提交项，避免重复提交：

```typescript
const submission = await root.submit(
  { type: "input", content: "Hello", requestId: "greeting-1" },
  context,
);
// 重启后：相同的请求 ID 会找到同一个提交项。
const again = await root.submit(
  { type: "input", content: "Hello", requestId: "greeting-1" },
  context,
);
// again.id === submission.id
```

`harness.submission(id)` 可以根据 ID 重新取得提交项，例如在重启后继续等待它。

## 扩展

除内置任务外，Harness 执行的代码都来自具名扩展，这些扩展安装在当前进程管理的注册表中：

```typescript
import {
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  section,
  ToolTask,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const Coding = defineExtension({
  name: "coding",
  sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined),
    }),
  ],
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Coding);
```

扩展可以提供 `tools`、`sections`、`hooks`、`wraps`（按名称装饰工具或段落）以及 `tasks`。默认情况下，每个对话都会按照安装顺序选择所有已安装的扩展。注册表本身不会被存储；对话只存储扩展名称。

## 工具

`@earendil-works/pi-durable/tools` 提供 `read`、`write`、`edit` 和 `bash`，以及包含这四个工具的 `CodingTools` 扩展。它们只通过调用的执行环境访问文件和进程（参见[执行环境](#执行环境)）。目前尚不支持读取图片。

使用 TypeBox schema 定义自己的工具。`defineTool()` 根据 `parameters` 推导 `args` 的类型，Harness 会在调用 `execute()` 前验证参数。`api.output()` 流式输出运行中的内容；如果 `execute()` 返回值没有 `content`，这些输出就会成为结果：

```typescript
import { Type } from "@earendil-works/pi-ai";

const count = defineTool({
  name: "count",
  description: "Count from 1 to n",
  parameters: Type.Object({ n: Type.Number() }),
  execute: async (args, api) => {
    for (let i = 1; i <= args.n; i++) api.output(`${i}\n`);
    return {};
  },
});
registry.install(defineExtension({ name: "count", tools: [count] }));
```

每次调用都作为独立的持久化任务运行。调用意图会在执行 `execute()` 前提交。如果进程在调用中途终止，只有声明了 `replay: "safe"` 的工具才会在重新打开存储时再次执行；否则，模型会收到一个 `interrupted` 错误结果，其中包含截至中断时已提交的输出。`execute()` 抛出异常也会向模型返回错误结果。结果还可以返回 `usage`，计入对话的[用量](#用量与费用)。也可以返回 `control: { terminate: true }`：当本轮所有结果都请求终止时，本次运行会结束，不再请求模型。

如果两个扩展都被选中，后安装扩展中的同名工具会替换先安装的工具，`wrapTool()` 则装饰最终生效的工具：

```typescript
const Venv = defineExtension({
  name: "venv",
  tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
});
const Timing = defineExtension({
  name: "timing",
  wraps: [
    wrapTool(createBashTool(), (bash) => ({
      ...bash,
      execute: (args, api, ctx) => timed(() => bash.execute(args, api, ctx)),
    })),
  ],
});
```

## 系统提示词

系统提示词由所选扩展的段落构成，在每次请求前按顺序渲染。段落可以访问解析后的智能体配置、为本次请求构建的执行环境，以及已提交的文档：

```typescript
section("cwd", (input) => input.env?.cwd); // 渲染为 <cwd>\n...\n</cwd>；返回 undefined 时省略该段落
```

对话的 `instructions` 最后渲染，段落名为 `instructions`。段落和工具的变更会以带有位置的系统条目存入对话记录。只有发生变化的内容才会再次发送，从而维持 provider 的提示词缓存。如果某个段落每次都返回不同的内容，例如当前时间，就会破坏这一效果。

## 每个对话的智能体配置

每个对话都在自己的 `pi.agent` 文档中保存运行配置。`configure()` 在一次提交中修改配置；未设置的字段沿用宿主默认值：

```typescript
await root.configure(
  {
    model: { provider: "openai", modelId: "gpt-6-sol" },
    thinkingLevel: "high",
    extensions: { remove: [Coding] }, // 修改宿主默认配置；传入数组则按顺序仅选择数组中的扩展
    tools: [readTool, bashTool], // 数组仅提供其中的工具；{ remove: [...] } 移除部分工具
    instructions: "Only read; never edit files.",
    cwd: "/work/repo",
  },
  context,
);
await root.configure({ tools: null }, context); // null 清除字段，使其恢复为宿主默认值
const agent = await root.agent(context); // 解析后的配置：model、extensions、tools、sections、cwd
```

扩展和工具以对象形式传入，以名称形式存储，因此名称可以在对应代码不再存在时继续保留：卸载扩展后，选择它的对话会暂时不再获得该扩展，直到重新安装。`createConversation()`、`fork()` 和 `root()` 的 `agent` 参数也接受同样的配置变更。由任务拥有的对话（例如子智能体的对话）初始时会复制归属任务所在对话的智能体配置。分支使用父对话在分支起点条目处的智能体配置。请求的模型、提示词和可用工具在准备请求时就已确定；配置变更从下一次请求起生效。工具调用和钩子使用其任务阶段解析出的智能体配置，而执行环境每次都根据当前 `cwd` 构建，因此修改 `cwd` 或扩展可能影响模型已经发起的调用。

## 设置

所有对话共享的运行策略通过 `settings` 传入。每次使用时都会读取它，且不会存储，因此可以通过 getter 实时获取设置，例如从设置文件读取：

```typescript
const harness = await Harness.open(
  storage,
  {
    models,
    registry,
    settings: {
      extensions: [CodingTools, Coding], // 默认选择；省略时选择所有已安装的扩展
      stream: { timeoutMs: 120_000 },
      retry: { maxRetries: 3 },
      compaction: { reserveTokens: 16384 },
      toolExecution: "parallel",
      get followUpMode() {
        return userSettings.followUpMode;
      },
    },
  },
  context,
);
```

## 执行环境

`env` 为每次工具调用、段落渲染以及 `runtime.env()` 构建执行环境。它接收对话 ID、智能体的 `cwd`，以及读取已提交状态的能力，因此同一个函数就能为每个对话提供独立目录或容器：

```typescript
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const harness = await Harness.open(
  storage,
  {
    models,
    registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
  },
  context,
);
```

`env` 抛出的异常会成为调用的错误结果。如果没有执行环境，内置工具会返回错误结果。每次调用创建新的环境对象也没有问题：`edit` 和 `write` 根据环境的 `id` 与文件路径，对同一文件的修改进行串行化。自定义 `ExecutionEnv` 应设置 `id`，确保相同 ID 在相同路径下看到相同文件，例如为每个容器分配一个 ID。

## 重新加载

安装与已有扩展同名的扩展，会一步完成原位替换：

```typescript
registry.install(await loadCodingExtension()); // 同名 "coding"：替换已安装的扩展
```

`registry.uninstall(extension)` 会移除已安装的同名扩展，无论传入的是哪个对象。

已经开始的工作继续使用开始时取得的代码：运行中的工具调用会使用旧实现完成；每个任务阶段在开始时从注册表解析一次钩子和智能体配置。下一个阶段、请求或调用使用新代码。重启后，需要重新安装相同的扩展；扩展安装后，其 `tasks` 中待处理的任务才会恢复。

## 观察对话

UI 所需的一切都来自已提交状态。`viewState()` 返回对话的结构化视图，它是一个只读 Chord 状态，每次涉及它的提交完成后都会更新：

```typescript
const view = await root.viewState(context);
view.subscribe((value) => {
  // value.entries：当前有效的对话记录
  // value.docs["pi.live"]：运行中的生成任务（流式部分内容、重试、延迟）与工具调用（输出、详情）
  // value.docs["pi.inbox"], value.docs["pi.usage"], value.docs["pi.agent"]
  render(value);
});
// 之后：view.dispose();
```

`watch()` 提供相同的视图，并附带每次提交的精确 Chord 操作；回调会依次执行：

```typescript
const watch = await root.watch(context);
render(watch.value); // 接入时的状态
watch.start(async (value, ops) => {
  await send(ops); // 例如发送给远程客户端，由其应用这些操作
});
// 之后：await watch.stop();
```

处理较慢的 watch 最多保留 100 个尚未交付的帧。超过这一数量后，会用一个包含完整最新视图的帧替换待处理帧。较晚加入或重新连接的客户端从当前视图开始，不会重放历史内容。

部分回答和工具输出的提交间隔最多为 100 毫秒，因此崩溃最多会丢失这一时间窗口内的内容。

## 忙碌中的对话

一次运行正在处理输入时，对话处于忙碌状态。向忙碌的对话提交内容，会将提交项排入该对话的收件箱，即视图中的 `docs["pi.inbox"]`：

```typescript
await root.submit({ type: "input", content: "Also run the tests" }, context); // 后续输入（默认）
await root.submit({ type: "input", content: "Use pnpm, not npm", whenBusy: "steer" }, context);
await root.submit({ type: "input", content: "Only if idle", whenBusy: "reject" }, context); // 抛出 ConversationBusy
await root.submit(
  { type: "write", entry: { kind: "app.note", data: "user opened a file" } },
  context,
);
```

- **引导输入（Steers）**：在当前工具轮次结束后加入，参与正在进行的工作。
- **后续输入（Follow-ups）**：在本次运行给出回答后加入，并启动下一次运行。
- **写入（Writes）**：追加条目，不向模型发起请求。
- `await submission.abort(context)` 撤回排队中的提交项。
- [设置](#设置)中的 `steeringMode: "all"` 和 `followUpMode: "all"` 会一次加入所有排队项，而不是每轮加入一个。

如果运行失败，排队项会留在收件箱中，直到下一次提交按从旧到新的顺序将其加入。

## 重置与交接

`reset()` 开始一个新的上下文。模型不再看到旧条目，但它们仍保留在存储中：

```typescript
await root.reset(undefined, context); // 从空上下文开始
await root.reset("We were fixing the flaky login test. Continue.", context); // 从交接说明开始
```

对话忙碌时，重置会像写入一样排队。如果在工具轮次期间应用重置，当前运行会结束。工具也可以通过 `control: { handoff: "..." }` 请求相同操作。

## 上下文压缩

上下文压缩会减少模型看到的内容：它总结较早的条目，并追加一个 `pi.compaction` 条目，保存摘要并指向压缩后保留的第一个条目。较早的条目仍保留在存储中。

```typescript
const id = await root.compact("Keep the failing test names", context); // 手动压缩，可附带指令
const { outcome } = (await harness.waitForTask(id, context)).state;
if (outcome.status === "completed" && outcome.result.submissionId !== undefined) {
  const placed = await (await harness.submission(outcome.result.submissionId, context))!.wait(
    context,
  );
  console.log(placed.status); // "done"，或原因为 "stale" 的 "unanswered"
}
```

生成摘要时，对话可以继续工作。对话空闲时会立即应用摘要，否则会在下一个轮次边界应用。Esc（`abort()`）会取消手动压缩。

生成任务也会自行压缩上下文，由[设置](#设置)控制：

```typescript
settings: {
	compaction: {
		enabled: true, // 自动压缩；手动 compact() 始终可用
		reserveTokens: 16384, // 超过 contextWindow - reserveTokens 时，下一次请求等待压缩完成
		keepRecentTokens: 20000, // 最近上下文中原样保留的 token 数量，近似值
		backgroundTokens: 32768, // 距离上述阈值还有这么多 token 时启动后台压缩；0 表示禁用
	},
}
```

如果 provider 因上下文过长而拒绝请求，生成任务会压缩上下文并重试一次。如果摘要的截断点位于当前上下文起点之前，应用时其状态会变为 `stale`；因此多个压缩任务同时进行时，截断位置最靠后的摘要会保持生效。摘要生成的费用计入 `pi.usage`。`CompactionTask` 上的 `beforeCompact` 钩子可以拒绝压缩，也可以提供自己的摘要。

正在运行的压缩任务列在 `docs["pi.live"].compactions` 中，包含原因、尝试次数和重试退避信息。智能体事件增加了 `compaction_start` 和 `compaction_end`，快照中增加了 `compactions` 字段。

## 智能体事件（实验性）

如果使用方希望接收编程智能体风格的事件（`message_start`、`message_update`、`tool_execution_start` 等），可以使用以下方式代替结构化状态：

```typescript
import { watchEvents } from "@earendil-works/pi-durable";

const stream = await watchEvents(harness, root.id, context);
initialize(stream.snapshot); // 条目、运行、进行中的生成任务、工具、压缩任务、收件箱、智能体配置、用量
stream.start(async (events) => {
  for (const event of events) console.log(JSON.stringify(event));
});
```

事件由提交派生，每次提交对应一批事件，在快照基础上应用。消息和工具更新携带增量：追加的文本与思考内容、追加的工具调用参数文本，以及输出的裁剪与追加。如果使用方落后超过 100 批，则会收到一个新的 `snapshot` 事件。一次完整运行的事件流可参见 `test/examples/19-json.ts`。

## 钩子

钩子允许扩展在选择了该扩展的对话中，观察或调整内置任务：

```typescript
import { GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";

const Guard = defineExtension({
  name: "guard",
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) => (call.name === "bash" ? { block: "bash is disabled here" } : undefined),
    }),
    hook(GenerationTask, {
      onYield: (answer) => (needsMoreWork(answer) ? { continue: "Keep going." } : undefined),
    }),
  ],
});
```

- **生成任务**：`beforeRequest`（替换一次请求中的消息）、`afterResponse`、`onYield`（通过另一条用户消息继续运行）以及 `afterTools`（一轮工具全部完成后执行）。
- **工具**：`beforeTool`（阻止调用或改写参数）以及 `afterTool`（替换结果）。

如果只想在部分对话中启用某个钩子，就只在这些对话中选择对应扩展，例如 `configure({ extensions: { add: [Guard] } })`。

## 更多对话与分支

```typescript
const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const fork = await root.fork(entryId, { ownership: { kind: "ownerless" } }, context);
```

分支可以看到父对话截至 `entryId` 的条目，然后独立继续。它保留父对话在该条目处的智能体配置。创建对话和创建分支都接受 `agent` 与 `init`，在创建时的提交中应用。

## 中止与子智能体

`await root.abort(context)` 会停止对话：撤回排队中的输入（保留排队中的写入），中止当前工作的所有任务，并在对话空闲后返回。

对话可以由任务**拥有**。子智能体工具在 `api.commit()` 中通过 `ownership: { kind: "task", taskId: api.taskId }` 创建子对话，再通过 `api.conversation(id)` 驱动它：

```typescript
const Subagent: Extension = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description: "Delegate a self-contained task to a subagent and get its answer back.",
      parameters: Type.Object({ task: Type.String() }),
      replay: "safe", // 崩溃后重新执行时会找到同一个子对话和提交项
      execute: async (args, api, context) => {
        const child = await api.commit(async (tx) => {
          // 归属索引记录了子对话，因此重新执行时会复用它。
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          // 初始时复制当前对话的智能体配置：model、extensions、tools、cwd。
          const created = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId },
          });
          // 使用更便宜的模型，并禁止它创建自己的子智能体。
          await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } });
          return created.id;
        }, context);
        await api.details({ conversationId: child }, context); // 让 UI 可以接入子对话
        const request = {
          type: "input",
          content: args.task,
          requestId: `subagent:${api.taskId}`,
        } as const;
        const settled = await (
          await (await api.conversation(child, context))!.submit(request, context)
        ).wait(context);
        return { content: [{ type: "text", text: settled.status }] };
      },
    }),
  ],
});
```

有归属的工作由其归属方管理：

- 中止调用会中止子对话。调用失败也会如此：例如 `execute()` 抛出异常，或崩溃中断了一个不具备安全重放能力的调用。
- 只有子对话空闲后，父对话才会空闲。
- 使用 `{ background: true }` 创建的任务形成一个边界：它拥有的工作不会随父级中止而停止，也不会让父级保持忙碌。`root.abort(context, { background: true })` 则会一并中止它。

示例以产品代码展示了这两种模式：

- [`22-subagent-foreground.ts`](test/examples/22-subagent-foreground.ts)：上面的工具，返回子对话的回答。UI 通过调用的 `details` 找到子对话，并在调用下方缩进打印子对话事件。
- [`23-subagent-background.ts`](test/examples/23-subagent-background.ts)：通过一个 `subagent` 工具管理持久化子智能体，支持创建、发送消息（引导或后续输入）、等待、停止和列出。每个子对话由一个后台锚定任务拥有，因此父对话的 Esc 和等待空闲都不会影响它。每条消息由一个后台报告任务负责投递，收到回答后将其作为后续输入发回父对话；请求 ID 可以避免重启后重复发送消息或报告。

## 子任务

任务可以通过 `ownership: { kind: "task", taskId }` 创建并拥有子任务，再通过提交 `waiting` 状态等待它们：

```typescript
pay: async (task, runtime, context) => {
	await runtime.commit(async (tx) => {
		const payments = [];
		for (const card of task.input.cards) {
			payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
		}
		// 所有付款完成后从 `decide` 恢复；首个失败会中止其余付款。
		return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
	}, context);
},
decide: async (task, runtime, context) => {
	const outcomes = await runtime.outcomes(task.state.checkpoint.payments, context);
	// ……提交结账流程自身的结果
},
```

- **等待**：任务等待期间不执行代码。使用 `allSettled` 时，`on` 中的所有任务完成后才会恢复；使用 `failFast` 时，第一个失败的子任务还会中止其余子任务。配合 `allSettled`，`on` 也可以指定其他任务。
- **完成**：如果任务自身完成时，它拥有的工作仍在运行，则会进入 `completing`：结果已经确定，但只有这些工作结束后，任务才会进入终态，`waitForTask()` 才会返回。如果结果是失败或中止，会先中止这些工作。
- **中止**：中止自下而上执行。中止任务时，先中止它拥有的工作，等这些工作结束后，才启动自身的中止处理程序，从而让每个任务撤销自己的影响。

[`24-child-tasks.ts`](test/examples/24-child-tasks.ts) 运行一个包含四笔付款的结账流程，展示银行卡被拒、取消结账，以及付款过程中重启的情况。

## 任务图

`harness.taskGraph(context)` 将 Session 中所有活跃任务以一个 Chord 状态展示，适用于任务面板或调试。每个节点包含归属边（`owner` 任务；如果直接归属于对话则没有）、状态、是否为 `background` 或已被标记中止，以及它拥有的对话。`harness.watchTaskGraph(context)` 以 watch 形式提供相同的值，用法类似对话的 `watch()`。

```typescript
const graph = await harness.taskGraph(context);
graph.subscribe((value) => {
  for (const node of Object.values(value.tasks)) {
    const status =
      node.state.status === "waiting"
        ? `waiting on ${node.state.on.join(", ")}`
        : node.state.status;
    console.log(
      `${node.id} ${node.kind} ${status}`,
      node.owner ?? `conversation ${node.conversationId}`,
    );
  }
});
```

任务在创建它的提交中出现，在使它进入终态的提交中移除。图中展示的是已提交的状态：`pending`、`running`、`waiting`（包含 `on` 和 `policy`）以及 `completing`（包含已确定结果的状态）。重启后，原先处于 `running` 的任务会显示为 `pending`，直到再次执行。待处理任务是否因缺少定义而受阻，不属于任务图的内容；`harness.inspect()` 会报告这一情况。任务图只列出活跃任务：子智能体的归属任务进入终态后，其对话中后续创建的任务会成为顶层节点，而对话的 `ConversationRecord.owner`（也位于视图的 `conversation` 中）仍将它关联到父级。[`24-child-tasks.ts`](test/examples/24-child-tasks.ts) 会在付款运行期间打印结账流程的任务树。

## 自定义状态

文档是有类型的 JSON 对象，与条目一同提交。定义一个文档，再在提交中修改它：

```typescript
import { defineDoc } from "@earendil-works/pi-durable";

const Todos = defineDoc<{ items: string[] }>({
  kind: "app.todos",
  version: 1,
  scope: "conversation",
  history: "latest", // 也可设为 "rewindable"，通过 snapshotAsOf() 读取历史值
  fork: "initial", // 分支的初始状态："initial"、"current" 或 "asOf"
  initial: () => ({ items: [] }),
});

await root.commit(async (tx) => {
  (await tx.doc(Todos, root.id)).items.push("write docs");
}, context);
console.log(await harness.snapshot(Todos, root.id, context));
```

`harness.watchDoc()` 和 `harness.documentState()` 可以像上面的视图一样观察单个文档。`HarnessOptions.conversationCreated(tx, conversation)` 在每个创建对话或分支的提交中执行，包括工具直接调用的 `tx.createConversation()`，因此每个对话都能获得你的文档；`createConversation()`、`fork()` 和 `root()` 中的 `init` 则在同一次提交中写入每次调用特有的数据。扩展的工具、段落和钩子通过 `api` 或 `input.read` 读取自己的文档，文档不存在时使用默认值（参见 [`11-extension-state.ts`](test/examples/11-extension-state.ts)）。

## 用量与费用

每个对话在 `docs["pi.usage"]` 中保存 token 用量与费用总计：模型响应按 `provider/model` 统计，报告用量的工具结果按工具名称统计。失败和中止的尝试也会计入。整个 Session 的统计可以这样获取：

```typescript
const usage = await harness.usage(context); // { models: { "openai/gpt-6-sol": Usage }, tools: {...} }
```

## 存储

| 后端   | 导入方式                                                                                           | 说明                                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Memory | 从包根目录导入 `MemoryStorage`                                                                     | 不持久化任何内容。                                                                                                             |
| SQLite | 从 `@earendil-works/pi-durable/storage/sqlite/node` 导入 `openNodeSqliteStorage(file)`             | 使用单个数据库文件。采用 WAL 模式，设置 `synchronous = NORMAL`：提交可以在进程崩溃后保留；断电或主机故障时，最新提交可能丢失。 |
| JSONL  | 从 `@earendil-works/pi-durable/storage/jsonl/node` 导入 `openNodeJsonlStorage(directory, context)` | 在一个目录中使用只追加的文件。传入 `{ fsync: true }`，可在写入每个提交标记前将数据刷入磁盘。                                   |

同一时间只能有一个进程拥有一个存储实例；没有跨进程锁。可移植的 SQLite 和 JSONL 核心（`/storage/sqlite`、`/storage/jsonl`）不依赖 Node API；只要提供异步的 `SqliteDatabase` 接口封装，或来自 `@earendil-works/pi-durable/env` 的 `FileSystem`，就可以在 Bun 或 Cloudflare Durable Objects 等环境中运行。

SQLite 适配器实现基于 Promise 的 `exec`、`run`、`get`、`all`、`transaction` 和 `close`。`run`、`get` 和 `all` 接收 SQL 文本及按位置绑定的参数；适配器可以按 SQL 文本缓存预编译语句。事务回调会收到一个事务句柄；事务中的所有工作必须使用该句柄，回调结束时句柄失效。适配器必须将无关操作和其他事务排队，直到当前事务结束，因此在回调内部直接调用 `database` 本身会导致调用永远无法完成：

```typescript
await database.transaction(async (transaction) => {
  await transaction.exec("CREATE TABLE example (value TEXT)");
  await transaction.run("INSERT INTO example (value) VALUES (?)", "stored atomically");
});
```

自定义后端可以使用任意兼容 Vitest 或 Jest 的测试运行器，执行共享的一致性测试套件：

```typescript
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";

registerStorageConformance({ describe, expect, it }, "My Storage", async (use) => {
  const storage = await openMyStorage();
  try {
    await use(storage);
  } finally {
    await closeMyStorage(storage);
  }
});
```

包根入口会加载 TypeBox，因为工具任务使用 pi-ai 的 `validateToolArguments()` 验证参数。未打包时，这会带来约 23 MB 的峰值常驻内存（RSS）开销；经过 tree shaking 的打包产物中约为 4 MB。

## 示例

可运行的示例位于 [`test/examples`](test/examples)。在本包目录下，可以这样运行其中一个：

```bash
node --conditions=source --experimental-strip-types test/examples/14-chat.ts
```

| 示例                                                                        | 展示内容                                                                                  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [14-chat](test/examples/14-chat.ts)                                         | 一次问答                                                                                  |
| [16-real-model](test/examples/16-real-model.ts)                             | 流式接收 OpenAI 的回答                                                                    |
| [17-coding-tools](test/examples/17-coding-tools.ts)                         | 在 JSONL 存储上运行一个使用工具的轮次                                                     |
| [18-print](test/examples/18-print.ts)                                       | 打印模式：提交提示词，打印回答                                                            |
| [19-json](test/examples/19-json.ts)                                         | JSON 模式：在 SQLite、JSONL 或内存存储上输出智能体事件或原始视图操作                      |
| [20-inbox](test/examples/20-inbox.ts)                                       | 忙碌期间的引导输入、后续输入、写入和撤回                                                  |
| [21-late-join](test/examples/21-late-join.ts)                               | 在运行中途接入视图和事件流                                                                |
| [22-subagent-foreground](test/examples/22-subagent-foreground.ts)           | 支持安全重放的子智能体工具，子对话归属于调用，并在调用下展示子对话事件                    |
| [23-subagent-background](test/examples/23-subagent-background.ts)           | 持久化子智能体：创建、引导、停止、列出、回传回答，以及重启安全性                          |
| [24-child-tasks](test/examples/24-child-tasks.ts)                           | 拥有并等待四笔付款的结账流程：failFast、中止、重启                                        |
| [25-compaction](test/examples/25-compaction.ts)                             | 长对话的后台压缩、手动压缩，以及上下文超限后的压缩                                        |
| [26-coding-agent](test/examples/26-coding-agent.ts)                         | CodingTools、从设置对象读取实时设置，以及跟随对话目录的执行环境                           |
| [27-plan-mode](test/examples/27-plan-mode.ts)                               | 将只读计划模式实现为带有独立文档的扩展，通过 `configure()` 切换                           |
| [28-reviewer](test/examples/28-reviewer.ts)                                 | 拥有独立模型、扩展、工具、目录和审查循环的审查者对话                                      |
| [29-sandbox-per-conversation](test/examples/29-sandbox-per-conversation.ts) | 为每个对话提供独立环境，并从应用文档中查找                                                |
| [30-tool-override](test/examples/30-tool-override.ts)                       | 为部分对话提供同名 bash 工具，并通过包装器为最终生效的 bash 计时                          |
| [31-reload-and-restart](test/examples/31-reload-and-restart.ts)             | 在调用中途重新加载扩展，并在重启后保留已存储的配置                                        |
| [00](test/examples/00-conversation.ts)–[13](test/examples/13-recovery.ts)   | 底层机制：Session、文档、分支、watch、Harness、智能体配置、重新加载、扩展状态、任务与恢复 |

调用 OpenAI 的示例需要 `OPENAI_API_KEY`；其他情况下，大多数示例使用模拟 provider。

## 设计文档

- [`docs/spec.md`](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)：规范性说明
- [`docs/pico-v5-handoff.md`](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/pico-v5-handoff.md)：实现计划
- [`docs/pico-v5-chord-usage.md`](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/pico-v5-chord-usage.md)：本包如何使用 Chord

基准测试：`npm run bench:storage`、`npm run bench:storage:memory` 和 `npm run bench:tool-output`。

## 许可证

MIT
