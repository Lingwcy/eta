<p align="center">
  <img src="apps/desktop/renderer/public/eta-icon.png" width="96" height="96" alt="Eta 标志" />
</p>
<h1 align="center">Eta</h1>
<p align="center">桌面与云端通用的 Agent。</p>
<p align="center"><a href="README.md">English</a> · 简体中文</p>

Eta 把自然语言指令变成实际成果：理解代码、修改文档、整理工作目录，或按计划周期性执行任务。同一个 Agent，三种用法——桌面应用处理本地工作；自托管的 Bot 在云端全天候运行；手机端随时查看进度、处理审批。

给 Eta 一个项目和一个任务即可开始。会话是持久的：关掉应用、放下手机，或者明天再回来——工作、历史记录和定时计划都原样保留。

![Eta 桌面界面：聊天记录、已完成的工具调用和模型选择器](docs/assets/image.png)

## 快速开始

### 桌面端

从 [GitHub Releases](https://github.com/Lingwcy/eta/releases) 下载安装包，Eta 会自动更新到新版本。

| 平台                  | 安装包                        |
| --------------------- | ----------------------------- |
| macOS — Apple Silicon | `Eta-<version>-mac-arm64.dmg` |
| macOS — Intel         | `Eta-<version>-mac-x64.dmg`   |
| Windows — x64         | `Eta-<version>-win-x64.exe`   |

Windows x64 安装包目前未签名，首次安装可能出现 SmartScreen 提示。Windows 命令执行工具需安装 Git for Windows（含 Git Bash）；当前 Windows 不支持受限沙盒执行。详见[发布说明](docs/release.md)和[沙盒指南](docs/user/sandbox.md)。

连接 AI 账户或填入自己的 API Key，选择项目文件夹，然后描述要做的工作。会话、项目、技能、子智能体和定时任务的用法见[桌面端指南](docs/user/desktop.zh-CN.md)。

### 云端 —— Eta Bot

把 Eta 部署在自己的服务器上，用桌面端或手机端连接同一个 Agent。首次启动前，先把 `apps/bot/config.example.json` 复制为 `apps/bot/config.json` 并填入私有的管理员令牌；项目目录位于 `apps/bot/workspaces`。用 Docker 部署 Bot：

```sh
docker compose -f apps/bot/compose.example.yaml up --build -d
```

然后在桌面端「设置 → 应用 → Bot」中填写服务器地址并连接，导入模型凭证，新建聊天时把执行位置从「此计算机」切换为「云端」。云端任务使用服务器上的文件、模型和技能；关闭桌面端后任务仍继续运行，定时计划照常触发。Bot 还提供 HTTP API，并可接收来自 Discord 的客户问题。完整部署说明见 [apps/bot/README.md](apps/bot/README.md)，使用说明见[连接 Bot](docs/user/bot.md)。

### 手机端

eta-mobile（iOS 与 Android）连接已部署的 Bot：新建会话、实时查看工具执行结果、在手机上处理审批请求。断开连接后，任务在服务器上继续运行。见[手机端指南](docs/user/mobile.md)。

## Eta 能做什么

- **持久会话与项目** —— 会话完整保存历史；每个项目有自己的工作区，可选用 Git worktree 隔离工作；侧边栏可浏览项目的 GitHub PR 与 Issue。
- **子智能体** —— 把工作委派给子会话，实时查看进度，中途发消息调整方向。预设可携带各自的指令、思考等级和模型；编排模式下由主会话统筹、子会话执行。
- **技能** —— 可复用的指令集，Agent 按需加载。用 `$技能名` 调用；个人技能放在 `~/.agents/skills/`，项目技能放在 `.agents/skills/`。
- **定时任务** —— 一次性、间隔、每日或每周计划，绑定在会话上。可在本机运行，也可放在 Bot 上，桌面端关闭后仍按计划在服务器触发。
- **可扩展的审批** —— 超出当前策略的操作在执行前会完整展示要做什么。你可以在桌面端或手机端亲自批准，也可以让自动审查模型先行判断：批准、拒绝，或转交给你决定。

## 权限与沙盒

Eta 内置完整的权限系统。每个会话运行在三档策略之一——**只读**、**工作区沙盒**（默认）或**完全访问**——由原生沙盒后端（macOS 的 Seatbelt、Linux 的 Landlock）对文件工具、命令和子进程强制执行。超出策略的操作必须先获得授权：审批卡片会写明操作、完整参数以及额外的文件或网络范围，授权只对单次调用或单次运行有效。Bot 部署可为所有接入的客户端设定策略上限。沙盒后端不可用时，任务会被阻止并说明原因——Eta 不会自行放宽访问范围。详见[沙盒策略](docs/user/sandbox.md)。

## 仓库结构

本仓库包含 Eta 的各端应用与它们共享的核心。

| 部分               | 说明                                                 |
| ------------------ | ---------------------------------------------------- |
| **apps/desktop**   | macOS 与 Windows 的 Electron 客户端，完整的本地 Agent 体验 |
| **apps/bot**       | 自托管云端服务，通过 HTTP/SSE 托管 Agent，支持 Discord 接入 |
| **apps/mobile**    | iOS 与 Android 手机端，连接已部署的 Bot             |
| **packages/core**  | 共享核心：项目、持久会话、沙盒、定时任务、审批       |
| **packages/agent** | Agent 运行时：工具调用与会话管理                     |

Eta 的 Agent 运行时基于 Earendil Works 的 [Pi](https://github.com/earendil-works/pi) —— 一个极简、可扩展的 Agent 框架。

## 参与开发

开发环境、聚焦检查与安装包构建见 [CONTRIBUTING.md](CONTRIBUTING.md)。维护者按[发布指南](docs/release.md)发布版本。

## 开发命令

```sh
vp install        # 用 Vite+ 工具链安装依赖
vp run dev        # 构建并运行桌面端
vp run @eta/bot#build   # 构建 Bot 服务
vp run package:mac      # 构建 macOS 安装包
vp run package:win      # 构建 Windows 安装包
```

## 许可证

[MIT](LICENSE)。依赖与捆绑资源保留各自的许可证。
