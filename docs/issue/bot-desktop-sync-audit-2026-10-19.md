# Bot / Desktop 同步与交互审查

审查日期：2026-10-19。源码基线：`7541fde7920c1199b1cfe77d731646989f7a03b8`。

范围为 Desktop renderer、preload、main 的 Bot 适配器、Bot HTTP / Controller 和 Core observation。未连接线上 Bot，未运行浏览器或桌面操作，未修改产品行为。截图中的实际 502 来源和真实发送耗时尚无线上日志或性能采样证明；下面区分受控复现和由源码支持的影响。

## 已复现的问题

### BDS-01 / P1：漏掉一次完成快照，会永久保留发送锁（已解决，[#204](https://github.com/Lingwcy/eta/pull/204) 已合并）

位置：`apps/desktop/renderer/src/agent/client.ts:153`。

已合并的修复：Desktop 现在会按原始 operationId 核对持久化执行记录，仅在确认 completed / failed / aborted 后释放尚未被快照确认的发送回执。实时确认会取消后备查询；查询失败会重试；会话关闭或回执被替换后，旧查询不能更改新状态。现有较新的会话快照保持不变。回归覆盖见 `apps/desktop/renderer/src/agent/client.test.ts`，本地 IPC 与真实 Bot HTTP 集成分别见 `apps/desktop/src/main/runtime-integration.test.ts` 和 `apps/bot/src/desktop.test.ts`。以下保留原审查基线的问题说明。

发送回执只在当前 `operation.id` 或 `lastResult.operationId` 与它相等时解除。若消息已经被接收，断线期间该次执行完成，随后定时任务或另一个客户端又完成一轮，重连快照只保留后一轮的 `lastResult`。旧回执不会再被确认。

复现：提交得到 `run`，下一份收到的快照包含已保存输入、没有运行任务、`lastResult` 为 `later-scheduled-run`。连接显示 connected，但 admission 仍为 `run`，下一条消息被拒绝。此测试验证丢帧后的客户端状态，不声称线上已经发生同一交错。

建议：重连时按原始 operation / request identity 查询持久化回执，收敛到该次执行的实际状态。不能把“当前已空闲”直接当成该次提交成功，也不能只等一个可能永远不会重现的最新结果字段。

### BDS-02 / P1：服务端已接收、客户端没收到回包时，重发可能执行两次（已解决：[#215](https://github.com/Lingwcy/eta/pull/215) / [#250](https://github.com/Lingwcy/eta/pull/250) / [#261](https://github.com/Lingwcy/eta/pull/261) 已合并）

位置：`apps/desktop/src/preload.ts:117`、`apps/desktop/src/main/bot.ts:409`、`apps/bot/src/store.ts:25`。

后续核对：#215 的身份复用依赖 renderer 识别 `DesktopCommandError`，但旧 preload 在自身 realm 解码后抛出 Error，不能依赖 contextBridge 保留其自定义字段或原型。补丁参照首次读取的 `openThreadReply`，新增可选 `submitReply`，以 DTO 跨越边界，在 renderer 本地解码；既有会话和 DraftThread 均使用该路径，旧桥仍支持 submit fallback。真实 preload + BotStore SQLite 的受控回归模拟 message-only 错误复制与 DTO 序列化：前者重复准入，后者保留图文请求身份、仅准入一次；确定性拒绝不复用，成功后同文本发送创建新身份。修复前 4 项控制失败，修复后 preload / client / draft 定向 63 项通过。这不是原生 Electron 或线上重复执行复现。

继续修复：`submitReply` 调用自身抛出 / 拒绝、未交付 DTO 时，不能由此判定 main 未接收。共享提交适配器现在将其标为未知准入结果，仅让显式重试复用同一图文 requestId；收到确定性失败 DTO 的分支在该 catch 之外，仍按服务端结果处理，不自动重发。真实 preload + BotStore 的 4 个新增控制覆盖现有会话 / 草稿、准入之前拒绝 / 回执持久化之后丢失回复，修复前均丢失身份；修复后三文件 67/67 通过，准入后丢回复也只执行一次，并保留确定性拒绝换身份、成功后相同内容作为新发送的控制。未做原生 Electron、主进程崩溃或应用重启后的身份持久化验证。以下保留原审查基线。

preload 每次 submit 都生成新 requestId。HTTP 超时或连接中断后，客户端释放提交锁并保留输入；用户重发会产生新的持久化请求。服务端已有的幂等机制因 requestId 改变而失效。

复现：使用实际 BotStore，第一次先持久化执行结果，再模拟回包丢失；第二次发送相同文本，产生不同 requestId，执行计数为 2。测试覆盖 DesktopBot 默认生成键的路径；实际 preload 也有明确的逐次随机键生成。真实 Controller 如果第一轮仍忙可能返回 Busy；第一轮已结束时仍存在重复执行风险。

建议：让一条待发消息在发送、超时核对和重试之间持有同一个 requestId；将“是否已接收未知”与“确认未接收”分开。先核对服务端回执，再决定重发。

### BDS-03 / P1：实时连接半断开时，客户端可能一直显示旧状态（已解决，[#212](https://github.com/Lingwcy/eta/pull/212) 已合并）

修复：Bot 的 thread / schedules SSE 每 15 秒发送独立 heartbeat，单个在途心跳写入避免慢读堆积，观察结束时停表。Desktop 每次观察连接有 45 秒首完整帧 / 后续帧期限，超时取消该次请求和 reader，沿既有 2 秒退避重连；新连接的首快照核对当前权威状态，原 operation 回执仍按 BDS-01 的持久化查询收敛。正常无模型输出时由 heartbeat 证明存活；等待消费者处理不计入传输期限。退订、关闭、断开和切换 Bot 取消期限，旧 fetch 即使迟到也不能发布到替代连接。

验证：新增 4 个 Desktop 与 2 个真实 Bot 路由回归在旧实现失败；修复后，Desktop main/bot.test.ts 50 项整文件通过（含 schedule 静默重连控制）；Bot 两个 heartbeat 路由、两项背压 / cleanup helper 和两项压缩回归通过。扩大运行 Bot HTTP / heartbeat / compression 共 40 项时 36 通过、4 项既有 native tool / recovery / sandbox 用例超时或未在轮询期完成，原因未在本次修复中确认，不宣称该组全绿。未做浏览器、原生 Electron 或线上网络验证。旧版不发送 heartbeat 的 Bot 仍可连接，但静默超过 45 秒将周期重连，升级服务端后才有闲置保活。

PR #212 的 CI 曾在退避 2 秒后立即检查调度通知而失败。受控复现将旧 reader 的取消清理和新 `/v1/schedules` 响应分别挂住：退避结束时已建立第二条流、已开始读取新修订，但发布尚未完成，原立即断言确定失败。释放响应后有界等待实际通知，再核对修订；旧取消清理仍未结束也不阻塞重连。测试仅推进 timeout，不推进周期轮询，避免轮询掩盖 SSE 恢复。此处修复测试的完成条件，未修改产品传输逻辑；Desktop `main/bot.test.ts` 50/50 通过。以下保留原审查基线。

位置：`apps/desktop/src/main/bot.ts:559`、`apps/bot/src/http.ts:449`。

SSE 使用没有 deadline 的 AbortController，fetch 建连和 reader.read 都没有应用层超时；Bot thread SSE 路由没有周期心跳。重连仅在读取报错或 EOF 后发生。目录轮询成功也不会核对这条实时流是否仍有进展。

复现：返回保持开启但始终无字节的 HTTP body，推进虚拟时间 5 分钟；没有错误回调、没有重连、signal 未中止，Bot 状态仍为 connected。测试未模拟 OS TCP 探测时间，结论是代码没有自己的存活性保证。

建议：建立服务端心跳及客户端首帧 / 心跳 deadline，超期后重建观察连接并核对持久化状态。不能仅按“多久没有模型输出”判断断线，正常长工具调用也可能没有内容变化。

### BDS-04 / P2：目录轮询的一次错误，会禁用健康聊天；恢复后又清空已显示历史（已解决，[#203](https://github.com/Lingwcy/eta/pull/203) 已合并）

当前行为分别判断目录状态与已显示的健康会话观察；仅目录轮询失败不会禁用健康聊天或销毁其快照。对应回归见 `renderer/src/agent/directory-health.test.ts`。以下保留原审查基线。

位置：`apps/desktop/renderer/src/agent/use-desktop-controller.ts:43`、`apps/desktop/renderer/src/agent/use-thread-agent.ts:19`。

Bot library 每 5 秒轮询，一次失败就令 remote.status 变为 error。composer 由全局状态禁用，即使该会话 SSE 仍正常。全局状态 error → connected 时，每个已挂载云端会话都会递增 version，销毁原 client 和订阅，再从空 observation 打开全量历史。

复现：真实 React hook 已显示一条历史，在只改变 library 状态后，输入被禁用；恢复 connected 并挂住新的 openThread 后，原历史变为 undefined，loading 为 true。没有模拟会话流本身失败。

影响：一次目录失败被放大为多个聊天的重新加载；长历史或弱网络下，恢复本身又带来明显等待。这条路径与截图“toast + 正在载入会话记录”的组合相符，但不能据此确认截图唯一根因。

建议：分别维护目录刷新与会话观察健康状态；恢复时保留已显示快照，只重建确实失效的观察连接。

### BDS-05 / P2：新会话首条消息串行等待过多，而且停止无效（部分解决：[#218](https://github.com/Lingwcy/eta/pull/218) 重复配置、[#221](https://github.com/Lingwcy/eta/pull/221) 创建期停止、[#248](https://github.com/Lingwcy/eta/pull/248) 目录刷新等待均已合并；阶段状态提示未做）

当前状态：[#218](https://github.com/Lingwcy/eta/pull/218) 已让创建携带的配置避免再次 configure / sandbox，[#221](https://github.com/Lingwcy/eta/pull/221) 已在创建完成后立即绑定实际 thread，创建前不再显示无效停止操作。此次继续移除 `DesktopBot.create` 对目录刷新完成的等待：持久化创建回执先返回，首条 submit 可直接发送；后台刷新等旧轮询结束后补读最新目录，失败仍通过既有目录状态报告，不改变创建 / 发送回执。原连接关闭、断开、切换 Bot 或更新凭证后，排队的补读不能重新启动；过期创建回复不会被映射到替代连接。

受控回归分别挂住 `/v1/library` 与 `/v1/status`，旧实现均无法发送首条消息，修复后无需放行目录请求即可收到发送回执与 onCreated；放行后仍更新并发布目录。另覆盖后台失败 / 恢复、旧轮询之后补读、关闭 / 断开 / 切换 / 更新凭证和创建失败。`main/bot.test.ts`、`draft-thread.test.ts`、`draft-stop.test.ts` 定向 78/78 通过，真实 Bot 的 `src/desktop.test.ts` 7/7 通过。创建回执不再保证目录已发布：离线缓存回归先等待目录通知（在持久化写入之后），目录归属回归等待该记录实际出现，保留原离线 / 归属断言。以下保留原审查基线；准备 / 创建阶段的明确状态提示仍未实现，也未测量线上延迟或目录扫描占比。

位置：`apps/desktop/renderer/src/agent/draft-thread.ts:83`、`apps/desktop/src/main/bot.ts:361`、`apps/desktop/renderer/src/agent/use-desktop-controller.ts:273`。

受控请求轨迹为：

```text
POST /v1/threads（已带模型、thinking、sandbox 配置）
GET /v1/library + GET /v1/status（并行，但必须等这一组）
POST /v1/threads/:id/configure
POST /v1/threads/:id/sandbox
POST /v1/threads/:id/messages
```

创建已经接受 configuration，DraftThread 随后仍再次设置模型和沙盒。configure 和 sandbox 的响应还包含完整会话快照，客户端分别允许等待 120 秒。这里记录的是请求依赖和超时设置，未测量实际线上耗时。

另一个真实 hook 复现挂住 createThread：composer.isRunning 为 true，thinking 为 null，transcript 没有快照；onStop 不调用 bridge.stop。原因是直到整个 draft.submit 完成才把 threadId 绑定到 tab，停止却只操作当前 ThreadAgentClient。UI 按 isRunning 切换成停止按钮，因此等待期间存在没有作用的操作。

建议：创建时一次提交最终配置，删除成功创建后的重复配置；目录刷新退出关键发送路径。在准备、创建和待接收阶段明确显示状态；创建后尽早绑定实际 thread identity，并按阶段提供真实取消语义。

### BDS-06 / P2：普通发送前，服务端重复构造 3 次完整会话快照（核心问题已解决，[#211](https://github.com/Lingwcy/eta/pull/211) 已合并；管理接口扫描已修复待合并，工作区路径仍实时扫描）

修复：Core 公开已有 `ThreadService.get` 的轻量元数据读取；Controller 的 HTTP、直接发送、停止、子智能体与调度鉴权使用该读取，不再为鉴权打开运行时 / 投影历史。准入前仍重新核对工作区归属；真正 GET 会话时仍构造一次完整快照。真实 HTTP 回归确认 admission 前 openThread 从 3 次降至 0，幂等重放不打开历史，越权请求在读取历史前拒绝；收据查询期间撤销工作区后不能继续准入。8 项新增回归通过，其中 7 项在旧实现下失败。原过期清理测试改为在真实 authorize 边界持有控制门，不再依赖第 2 次完整快照。该快照修复没有修改目录扫描频率，也没有生产规模耗时基准；不声称整条发送路径已完成性能优化。

目录扫描后续：`GET /v1/status`、`POST /v1/credentials/import` 和 `POST /v1/credentials/remove` 不使用项目目录，将这三个管理接口放在项目发现中间件之前，避免每次管理调用扫描目录，亦不等待已在进行的扫描。全局认证、shutdown 检查和 48 MiB 限制仍在这些接口之前；工作区 / 会话 / 调度相关请求仍在项目发现之后，未缓存或延长授权有效期。4 项新增真实 Bot HTTP 控制覆盖四次连续管理请求从 4 次 refresh 降为 0、挂住目录扫描时仍返回状态、项目根目录不可用时仍可管理且错误输入 / 未授权 / 大请求仍拒绝、shutdown 后仍拒绝；其中 3 项修复前失败。`src/http.test.ts` 48/48、`src/desktop.test.ts` 7/7、`src/compression.test.ts` 2/2 通过。工作区相关请求的扫描合并 / 增量发现仍是后续项，未声称生产速度提升或整个扫描开销已解决。以下保留原审查基线。

重复根解析后续（已修复，待 PR 合并）：单次 `BotProjects.scan` 的目录、已登记项目和工作区检查复用同一个已解析根路径，避免逐项重新解析根。8 个正常项目的真实文件系统 / Core fixture 中，初次扫描的根路径 realpath 调用由 17 次降至 2 次；缓存仅限本次扫描，下一次仍重新解析。别名先在临时映射中构建，发布任一映射前再验证根未变化；受控切换根目录的符号链接时，本次刷新拒绝并同时撤销两张旧归属映射，不能沿用旧根的授权；下次刷新正常采用新根。`projects.test.ts` 4/4 和现有 `http.test.ts` 44/44 通过，新增中的 3 项修复前失败，另有缺失工作区历史、内部别名、越界及悬空链接兼容控制。未改变按请求扫描策略或引入跨请求授权缓存，未测量线上延迟，也不声称所有目录 I/O 已减少为常数；缺失路径回溯仍可能需要解析父目录。

位置：`apps/bot/src/http.ts:419`、`apps/bot/src/controller.ts:49`、`apps/bot/src/controller.ts:157`、`packages/core/src/service/observation/index.ts:93`。

HTTP messages 路由 authorize 一次，Controller.submit authorize 一次，claim 又 authorize 一次。authorize 调用 Core.openThread，而该操作构造完整 observation，包含历史投影、持久化 submission 扫描、子智能体及权限状态读取和 JSON 深拷贝。

复现：真实 createBotApplication、HTTP messages 路由和 Core，记录 core.openThread / core.submit 调用，确认 admission 前 openThread 恰好调用 3 次，submit 调用 1 次。此实验确认次数，未对长会话做耗时基准。

额外负担：每个 `/v1/*` 请求还先执行 BotProjects.refresh；非重叠刷新会扫描目录。这是源码确认的放大因素，尚未测量它在生产中的占比。

建议：鉴权和准入读取轻量元数据；需要展示时才构造历史快照。保留提交时的权限与归属验证，避免为减少次数引入过期授权。

### BDS-07 / P2：自动恢复后，失败 toast 仍然留在屏幕上（旧通知未关闭已解决，[#210](https://github.com/Lingwcy/eta/pull/210) 已合并）

当前 `ToastNotice` 在 message 清空或替换时关闭对应 toast，实 DOM 回归见 `renderer/src/components/ui/toast-notice.test.ts`。原建议中的延迟通知、恢复中状态与标题分级未实现，不视为已完成。以下保留原审查基线。

位置：`apps/desktop/renderer/src/components/ui/toast.tsx:101`、`apps/desktop/src/main/bot.ts:612`。

实时流错误立即被上报，底层每两秒自动重连。ToastNotice 的 message 清空分支只清 shown.current，没有关闭已经创建的 toast；默认 toast 生命周期为 8 秒。

复现：渲染真实 ToastProvider / ToastNotice，先显示 502，再把 message 设为 null，原错误文字仍在 DOM 中。因此连接恢复、输入重新可用和“操作未完成”提示可以同时存在。若是自动恢复的会话连接错误，这个标题还把连接状态表述成了某个用户操作失败。

建议：瞬时连接故障先进入“正在恢复”的连接状态；达到阈值或无法自动恢复时再给出可操作错误。若 toast 表示当前连接故障，恢复时应关闭或更新对应通知；具体写入失败仍需按回执核对结果。

### BDS-08 / P2：首次打开聊天的 502，没有同等的自动重试（已解决，[#206](https://github.com/Lingwcy/eta/pull/206) 已合并）

修复：首次只读 open 请求遇到明确可重试错误时，按 1 秒 / 2 秒退避，最多尝试 3 次；耗尽后仍保留原手动重试路径。Bot 网络 / 超时及 HTTP 408、429、5xx 错误携带可重试策略，经 IPC reply DTO 传入 renderer，避免依赖 contextBridge 保留 Error 自定义属性。认证、权限及不存在等不可重试错误直接显示；dispose、替换 connect 和过期回调不会重启旧连接。`client.test.ts`、`main/bot.test.ts`、`main/ipc.test.ts` 和 `preload.test.ts` 定向测试 119/119 通过，覆盖客户端退避 / 生命周期、真实 Bot HTTP 502 经 IPC DTO 后重试成功、错误分类、响应体网络中断与 preload DTO 入口。lint 在本机工具内部崩溃，桌面类型检查超时，未视为通过；未做原生 Electron 或线上 Bot 验证。

位置：`apps/desktop/renderer/src/agent/client.ts:43`。

connect 先等待 openThread，成功后才建立 SSE。若首次 GET 失败，就只留下 error，没有重试循环。Bot directory 一直 connected 时，也不会触发全局 error → connected 的重建逻辑。

复现：openThread 返回一次 502，推进虚拟时间 30 秒；总调用数仍为 1，没有建立订阅。真实 UI 有手动重新载入入口，因此不是完全无法恢复，但相同错误有时自动好、有时必须手动重试，行为不一致。

建议：对可恢复的首次读取失败做有界重试，保留手动重试并区分认证 / 权限 / 不存在等不可重试错误。

### BDS-09 / P2：后台运行标记把临时断线当作任务结束（已解决，[#205](https://github.com/Lingwcy/eta/pull/205) 已合并）

修复：`ThreadActivity` 不再把 error 事件当成执行终态，保留运行标记和原订阅，让底层连接继续自动恢复。只有后续权威快照确认无活动、需要恢复或已故障时才清除；dispose 仍释放订阅。`thread-activity.test.ts` 的 11 项定向测试通过，涵盖连续断线、恢复后继续运行 / 完成、同步错误、故障 / recovery 快照及过期回调。新增回归中的 3 项在修复前失败。未做原生桌面或线上 Bot 验证。

位置：`apps/desktop/renderer/src/agent/thread-activity.ts:38`。

onEvent 仅在“snapshot 且仍有活动”时保留 watch；其他事件包含 transport error，都会删除运行标记并退订。退订又取消了本可自动重连的底层流。

复现：watch 后 running set 含 thread，发送一条 502 error，running set 立即清空。若聊天仍挂载，后续收到快照可能重新建立活动 watch；若聊天已关闭，后台运行状态则缺少这条观察恢复路径。

建议：将观察不确定与确认执行终态分开，只在权威终态清除运行标记；临时连接失败保留观察恢复能力。

## 验证记录与边界

- `vp install` 成功，锁文件无需更新。
- Desktop 定向运行四个文件：`bot-sync-audit.test.ts`、`client.test.ts`、`draft-thread.test.ts`、`main/bot.test.ts`，59/59 通过。其中 9 个 audit case 验证上述现存问题及首条消息的额外交互问题。
- Bot 定向运行真实 HTTP / Core 的 `sync-audit.test.ts`，1/1 通过。
- 共 60 个不同测试，其中 10 个是本次受控复现。audit case 的通过表示问题可复现，不表示产品缺陷已修复。
- 未运行全仓检查，未做浏览器 / computer-use 验证，未触发真实代理执行或远程写入。
- 覆盖链路：renderer → preload → main → Bot HTTP / Controller → Core；同时检查打开、发送、停止、自动恢复及后台活动观察。没有新增 UI 入口，没有修改用户文档。

临时测试已从产品测试目录移出，避免把错误行为作为长期正确契约。复现源码存于：

- [Desktop 复现](/Users/wcy/.codex/visualizations/2026/10/19/01a152f6-3315-74e3-8e51-98fb8a5288ba/bot-desktop-sync-audit/desktop-repro.test.ts)
- [Bot 复现](/Users/wcy/.codex/visualizations/2026/10/19/01a152f6-3315-74e3-8e51-98fb8a5288ba/bot-desktop-sync-audit/server-repro.test.ts)

要重跑，分别复制回 `apps/desktop/renderer/src/agent/bot-sync-audit.test.ts` 和 `apps/bot/src/sync-audit.test.ts`，在对应 app 目录执行 `vp test run <测试路径>`。

## 仍需线上证据回答的问题

1. 截图中的 502 是哪个请求返回的：library、thread open、events 还是 messages？响应来自哪一层？当前审查的 Bot 错误映射本身未返回 502。
2. 实际慢发送的耗时主要落在网络、目录扫描、重复 snapshot、工具 / 技能准备还是持久化？目前不能给出生产耗时占比。
3. 是否存在某些线程特别明显的历史大小、receipt 数量、子智能体数量或定时运行密度？本次验证了放大路径，没有建立生产规模的阈值。

修复建议先处理 BDS-01/02/03 的执行正确性，再并行收敛 BDS-04/07/08 的连接恢复体验和 BDS-05/06 的发送路径，最后补齐 BDS-09 的后台状态语义。
