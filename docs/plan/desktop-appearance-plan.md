# Eta 桌面浅色与暗色模式方案

状态：2026-11-08 已完成源码实现、定向自动化验证与隔离打包运行时验证；真实 GUI 检查未执行；维护者已明确免除 PR 截图要求，并要求直接创建 PR，由维护者自行审核合入。维护者追加约束：UI 仅允许在设置 → 外观新增一栏“视觉模式”；其他位置只适配主题颜色，不能增加、删除、重排控件或改变布局、密度和交互。浅色保持原有颜色，表中建议色系以此兼容要求为先。维护者最新确认：参考图只用于说明功能，不复刻其缩略窗口设计。视觉模式采用 Eta 已有的紧凑图标＋文字分段选择器，其他布局、密度和交互保持不变。

## 1. 视觉方向与范围

两套实际视觉风格，三个偏好选项：**跟随系统 / 浅色 / 暗色**。跟随系统只是解析策略，不是第三套色系。默认跟随系统，既有设置没有主题字段时也采用此默认。选择保存为本机 Desktop 偏好，不属于 project、thread、provider 或远端 Bot 配置。

- 浅色：雾灰外壳、白色内容与弹层，柔和灰色 hover；保留 Eta 现有轻量桌面感。
- 暗色：炭灰外壳、略亮的内容与弹层，避免纯黑底配纯白字；用明度、细边界区分层级，不堆叠厚重阴影。
- 焦点、链接等交互强调使用蓝色；模式选择沿用现有分段控件的中性色选中底，不使用参考图的蓝色外框。现有橙色 accent 仅作为少量特定动作色，不另设主题或让所有主要按钮变蓝。
- 字号、间距、圆角、侧栏宽度和已批准控件形态不变。不新增主题管理页、全局主题工具条、命令面板项目或快捷键。
- 范围为 Electron main、preload、React renderer，含独立 thread 窗口和应用内浏览器外壳。不修改网页本身、用户截图、图片、provider 品牌色；Mobile 和 Website 本轮不变。

## 2. 色系与语义 token

以下为实施基线，最终须通过对比度及获授权的真实窗口验收；颜色按用途引用，不能把整个 neutral 色阶简单反转。

| 语义             | 浅色                  | 暗色                  | 用途                            |
| ---------------- | --------------------- | --------------------- | ------------------------------- |
| shell            | `#e9e9e9`             | `#191a1c`             | 标题栏、侧栏、窗口初始背景      |
| surface          | `#ffffff`             | `#222326`             | 主内容、设置页、编辑区域        |
| surface-raised   | `#ffffff`             | `#2b2d31`             | 菜单、对话框、Tooltip 等浮层    |
| surface-subtle   | `#f5f5f5`             | `#292b2f`             | 代码容器、低强调背景            |
| surface-hover    | `#ebebeb`             | `#35373c`             | 行与 ghost 按钮 hover           |
| surface-selected | `#dedfe1`             | `#3c3f45`             | 中性选中行                      |
| text-primary     | `#292b2e`             | `#eceef1`             | 正文和标题                      |
| text-secondary   | `#5e6269`             | `#b1b5bd`             | 次要说明                        |
| text-muted       | `#6b7078`             | `#9a9fa9`             | 占位、辅助文字（不是 disabled） |
| border           | `#e2e3e6`             | `#3b3e44`             | 非必要的表面分隔                |
| border-control   | `#898e98`             | `#777d88`             | 必须可辨识的输入/控件边界       |
| focus / link     | `#0866e6`             | `#6ca7ff`             | 聚焦、链接                      |
| accent-fill      | `#0866e6`             | `#2563eb`             | 需要白色文字的蓝色背景          |
| accent-subtle    | `#eaf2ff`             | `#223551`             | 轻量蓝色信息底                  |
| solid / on-solid | `#262626` / `#ffffff` | `#eceef1` / `#202124` | 现有主按钮，保持中性            |
| selection        | `#cce0ff`             | `#304d76`             | 文字选区                        |

状态色成组提供 foreground + subtle background + border：成功绿、警告琥珀、错误红、信息蓝。暗色状态不能直接沿用浅色浅底；Git added/deleted 与 Diff 使用独立语义，不能仅凭红绿表达，保留符号、标签和状态图标。品牌 logo 和内容图片不使用反色滤镜。

- 普通文本目标 WCAG AA 4.5:1，大字和必要非文本控件 3:1。低对比装饰分隔线不代表必要控件边界；占位和辅助文字按普通文本验收。透明色按实际合成背景计算，不以原始色值推测可读性。
- `text-white` 等固定对比色只用于确定的实色背景；黑白图片、品牌区域不机械替换。
- Tooltip、菜单、Dialog、Toast 经 portal 挂在 body，主题属性必须放在 `html`，不能只放在 App 容器。

## 3. 设置交互

位置：现有 **设置 → 外观**，只新增一栏“视觉模式”，不新增分区或调整其他设置。右侧复用现有 `SegmentedControl`：显示器＋“跟随系统”、太阳＋“浅色”、月亮＋“暗色”，图标与文字并排。

- 不绘制窗口缩略图、半明半暗截图或蓝色角标，不使用三张独立预览卡。三项共用一个低强调中性底，选中项以现有控件的表面底色、浅阴影和清晰文字区分；保持紧凑行高。
- 使用具有可访问名称的 radio group；可见文字直接提供选项名称，装饰图标不参与朗读。键盘方向键切换、Tab 进出、Space 选择，键盘 focus 与选中偏好分离，沿用现有控件的选中与聚焦语义。
- 保存使用现有 Settings 更新与错误通知，不新增说明段落、保存按钮或弹窗。写入期间防止重复提交；失败保留旧偏好并允许重试。
- 跟随系统时即使实际显示暗色，选中项仍是“跟随系统”。显式浅色和暗色不受系统切换影响。随时可以回到系统模式。
- 中英文本地化随现有语言设置更新。

## 4. 现状与需要统一的边界

源码调查：

- [style.css](../../apps/desktop/renderer/src/style.css) 当前仅导入 Tailwind，没有全局主题变量。大量组件直接用 neutral、白底和任意十六进制值；因此只加 `.dark` 不会形成完整暗色。
- [windows.ts](../../apps/desktop/src/main/windows.ts) 固定浅灰背景，Windows 标题栏按钮也是固定浅色。独立 thread 窗口走同一创建函数，需要同步覆盖。
- [appearance-settings.tsx](../../apps/desktop/renderer/src/components/settings/appearance-settings.tsx) 只有语言和思考动画，主题字段尚不存在。
- [code-block.tsx](../../apps/desktop/renderer/src/components/chat/code-block.tsx) 固定 `pierre-light`；[diff-preview.tsx](../../apps/desktop/renderer/src/components/diff/diff-preview.tsx) 独立使用 system，二者必须改为应用解析后的主题。
- [TaskList](../../apps/desktop/renderer/src/components/task-list/index.tsx) 有局部 dark fallback，需归入统一 token，避免与全局主题产生第三套颜色。
- 当前 settings 已有校验、串行写入和重启读取；通过既有设置命令扩展，而不是另写一个 localStorage 偏好。

## 5. 状态与运行逻辑

### 5.1 唯一偏好与解析

在共享 appearance 契约定义 `ThemePreference = "system" | "light" | "dark"`、`ResolvedTheme = "light" | "dark"` 和纯解析函数：

```ts
resolveTheme(preference, systemDark) =
  preference === "system" ? (systemDark ? "dark" : "light") : preference;
```

SettingsSchema 增加可选 `theme` 枚举；缺省为 system，不为迁移重写旧文件。IPC patch schema 同步接受同一枚举。未知值、null 被拒绝，拒绝写入时不得改变磁盘旧状态。只持久化偏好，不持久化实际解析值。

main 持有当前已提交的偏好，监听 Electron `nativeTheme.updated`，生成 `{ preference, resolved, revision }`。只在内容变化时递增 revision 并向所有 Eta 主/独立 thread 窗口广播；不是每个 token 或 library refresh 都更新 DOM。原生外观随该偏好设置 `nativeTheme.themeSource`，系统模式的解析不被此前显式模式锁住。不要把整台桌面的网页强制成 Eta 主题。

### 5.2 从启动到运行

1. 启动先读取已校验本地设置，再创建第一个窗口，使用实际主题设置 BrowserWindow 背景和 Windows titleBarOverlay 的底色/符号色。
2. main 给每个窗口提供最小初始 appearance snapshot；preload 将其作为只读同步启动值暴露给 renderer。可使用 BrowserWindow 的 `additionalArguments` 传递非敏感枚举与 revision；必须验证并支持现有 sandbox/contextIsolation，不开放任意文件读取或关闭隔离。
3. renderer 在 React、locale 与 library 异步初始化前应用 `html[data-theme]` 与 CSS `color-scheme`。仅初始化后渲染应用；首帧背景与窗口底色保持一致，不先画浅色再补暗色。
4. renderer 先订阅 appearance 事件，再读取当前 snapshot 补齐创建到订阅之间的更新；只接收不旧于当前 revision 的状态，旧读取不可覆盖新广播。关闭/重载解绑订阅。
5. 用户选择模式 → 现有 settings 命令 → 服务校验并成功持久化 → main 发布新 snapshot → 原生窗口与所有 renderer 同步。以提交成功为准，不在每个控件维护第二份乐观主题。
6. 系统模式遇到 OS 外观变化时重新解析并广播，不写 settings；显式模式保持不变。全部窗口关闭但应用驻留时仍保留监听，新窗口获取最新状态；退出统一 dispose。
7. 系统主题事件和设置写入不得用无序 library 异步读取互相覆盖。主题发布绑定已提交值及当前协调器生命周期；保存失败不发布新偏好，已关闭窗口跳过。

不依赖远端 Bot 的 library 来决定本机外观；远端连接、project 切换和 thread 新建均不重置主题。

### 5.3 CSS 与组件

- 使用 CSS 自定义属性在 `:root` / `[data-theme="dark"]` 定义语义颜色，Tailwind v4 `@theme inline` 仅映射到这些变量。
- 按用途将现有颜色迁移为 `bg-surface`、`text-foreground`、`border-border` 等类；不覆盖 Tailwind 的 neutral 色阶实现全局反转，不写 blanket filter，不在每个组件各写一套 dark 条件。
- UI 基础组件拥有颜色与状态，通过现有 variant / size 使用；feature 组件只负责自身视觉或布局。视觉模式直接组合现有分段控件与图标文字，不修改共享控件外观或新增主题专用 variant。
- 检查 normal / hover / pressed / selected / disabled / focus-visible、placeholder、输入光标、滚动条、文字选区、遮罩和阴影；透明层需在两种背景实测。
- 不增加全局颜色过渡，避免整页闪动或持续重绘；切换一次性更新变量。

### 5.4 代码、Diff 与动态内容

- 代码高亮使用对应的 pierre-light / pierre-dark；高亮结果身份包含 code、language、resolved theme。主题变化后不展示旧主题 token，过渡时用可读纯文本；迟到旧结果不得覆盖当前主题。
- Diff 显式传实际 light / dark，不能继续单独跟随系统。保持 FileDiff、虚拟列表、滚动和折叠状态，不以 theme 作为整棵组件树 key。
- 任务列表、思考提示与 loading 状态消费同一语义变量；不新增循环动画。主题切换不重开会话、不刷新历史、不重发消息或查询。
- 应用内浏览器只改变地址栏、标签页及空白/错误/loading 外壳；网页不注入主题 CSS 或反色；网站若自行跟随宿主 `prefers-color-scheme`，仍可能响应 Electron 的原生主题。透明 computer overlay 不计入不透明主窗口背景更新。

## 6. 实施顺序

1. **契约与协调器**：共享枚举/解析，设置读写与 IPC，main 初始状态、系统监听和生命周期，多窗口广播。
2. **启动与 CSS 基础**：同步启动快照、preload/bridge、renderer 订阅，窗口底色和标题栏；建立 token，迁移共享 UI。
3. **完整表面迁移**：外壳/侧栏/标签栏、聊天/输入/工具/任务、设置/认证、Git/Diff/Inspector、菜单/Dialog/Toast，以及浏览器外壳。加入图标文字分段式模式选择与本地化。
4. **代码与验收**：高亮和 Diff 受控主题，持久化重启/失败/多窗口/竞态测试，对比度检查、定向 lint/typecheck/build。获维护者许可后实际 GUI 验证并附浅/暗截图到 PR，不将 PR 专用图片提交入仓库。

每个阶段都必须有正向和反向路径。上线前不得把仅 shell 可切换的中间状态当作完整主题交付。

## 7. 验证矩阵与交付标准

| 范围          | 最小证明                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- |
| 解析          | 三种偏好 × 两种系统外观；system → explicit → system                                             |
| 持久化        | 真实 service 写入/关闭/重读；旧设置无字段；未知枚举/null 拒绝后磁盘不变                         |
| 事件/生命周期 | OS 改变、相同值去重、多窗口、新窗口、驻留重开、关闭后不发布；订阅前后补读与迟到旧值             |
| 设置交互      | 真实 DOM 打开外观、键盘选择、已保存状态、失败重试、语言切换；不以静态 markup 断言代替           |
| 高亮          | 应用浅色/系统暗色、应用暗色/系统浅色，切换时旧高亮迟到、未知语言/大代码纯文本回退               |
| Diff          | 显式主题与应用一致，切换不丢当前文件与滚动位置，不重复查询 patch                                |
| 所有视觉入口  | Settings、现有命令/快捷键打开的同一弹层、右键/嵌套菜单、hover/focus、空/加载/错误态             |
| 窗口与平台    | Electron main/preload/renderer，主/独立 thread 窗口；macOS/Windows 原生外壳分别记录实际验证范围 |
| 性能          | 无全局 key 重挂载、无轮询、无切换动画、无新增持续重绘；聊天草稿和运行中 thread 不受影响         |

只执行改动范围的 `vp test run <files>`、定向 lint、Desktop 类型检查和必要 renderer/electron 构建，不跑 repo-wide check 或递归全量测试。GUI 与真实系统外观的验证需明确授权，受控 DOM 测试不等于原生平台验收。

## 8. 本轮实际交付与剩余项

- UI 结构仅在现有设置 → 外观添加一栏“视觉模式”，以现有分段控件承载三个图标＋可见文字选项；已移除早期接近参考图的缩略窗口、蓝色外框与角标，以及专用预览 CSS。没有添加分区、入口、快捷键，其他页面只迁移颜色类。浅色沿用原有 Tailwind 色值与固定十六进制值，品牌头像保留白色承载面；模型选择器原有单色标记仅在暗色下调整反差。
- 使用共享语义 token 和 CSS `light-dark()`；在 renderer 初始化前，由原生主题提供首帧配色，再由 `html[data-theme]` 固定实际主题。同步启动快照的解析放在 preload-only 模块，避免共享块破坏 sandbox。
- main 直接订阅成功提交的 settings 快照，不以异步 library 重读决定主题；新/已有/独立 thread 窗口统一同步，透明 overlay 不被涂成不透明背景。
- 定向验证：46 个测试文件、436 项全部通过，覆盖受影响组件及相关 IPC、持久化、系统解析、多窗口、订阅排序、保存失败重试、代码高亮迟到和 Diff 主题/滚动保留。已有 schedules 测试输出 React act 警告，但全部通过；未用重试或延时掩盖失败。
- Desktop 类型检查、改动文件 lint、renderer 与 Electron 构建通过；隔离 staged-runtime 验证通过，包括新增的实际 preload Electron-only require 检查。原生 helper 编译输出现有 Swift x86_64 compatibility archive 警告，但构建成功。
- 还未启动浏览器或使用 computer-use。首屏是否无闪白、实际多窗口/弹层观感、macOS/Windows 原生外壳尚未通过真实 GUI 验收；自动化测试不代替这些证据。
- 维护者已明确确认“直接提 PR，不用截图，我亲自合入”，因此按此次授权免除截图并直接创建 PR，不宣称已做真实 GUI 验证。计划文件已针对默认忽略规则显式加入版本管理。

文档仅增加中英用户指南中的模式使用说明；没有新增内部架构手册。
