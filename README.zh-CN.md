<p align="center">
  <img src="apps/desktop/renderer/public/eta-icon.png" width="96" height="96" alt="Eta 标志" />
</p>
<h1 align="center">Eta</h1>
<p align="center">桌面上的通用 Agent。</p>
<p align="center"><a href="README.md">English</a> · 简体中文</p>

用自然语言让 Eta 帮你处理文件：理解代码、修改文档，或整理工作目录。连接 AI 账户或填入自己的 API Key，选好项目文件夹就能开始；会话会保存，随时回来接着做。

![Eta 桌面界面：聊天记录、已完成的工具调用和模型选择器](docs/assets/image.png)

## 安装

从 [GitHub Releases](https://github.com/Lingwcy/eta/releases) 下载安装包。

| 平台                  | 安装包                        |
| --------------------- | ----------------------------- |
| macOS — Apple Silicon | `Eta-<version>-mac-arm64.dmg` |
| macOS — Intel         | `Eta-<version>-mac-x64.dmg`   |
| Windows — x64         | `Eta-<version>-win-x64.exe`   |

Windows 上执行命令需要安装含 Git Bash 的 [Git for Windows](https://gitforwindows.org/)。从源码运行或自行打包，请看[贡献指南（English）](CONTRIBUTING.md)。

## 用 Eta 完成工作

| 你想做什么                             | 使用指南                                                      |
| -------------------------------------- | ------------------------------------------------------------- |
| 继续已有聊天、管理项目或备份会话       | [聊天与本地数据](docs/user/desktop.zh-CN.md#聊天与本地数据)   |
| 用 `$技能名` 为 agent 提供可复用的指令 | [技能](docs/user/desktop.zh-CN.md#技能)                       |
| 委派任务并跟进子会话                   | [子智能体](docs/user/desktop.zh-CN.md#子智能体)               |
| 控制文件、命令和网络访问               | [沙盒策略](docs/user/sandbox.md)                              |
| 在远端 Eta Bot 上执行任务              | [连接 Bot](docs/user/bot.md) · [部署 Bot](apps/bot/README.md) |

## 使用前须知

- agent 可以修改文件、执行命令。新会话默认使用工作区沙盒；只想查看文件时，可选择只读模式。Windows 的受限模式会阻止本地任务，执行任务需要完全访问；选择前请先阅读[沙盒策略](docs/user/sandbox.md)。
- 在**设置 → 工具函数**中启用或停用系统工具，在**设置 → 权限**中管理图片读取。外部工具尚未接入。
- 安装包可能触发系统安全提示：macOS 版本默认采用 ad-hoc 签名，除非发布时启用了 Developer ID 签名与公证；Windows 安装包目前未签名。
- 本地与 Bot 的文件和会话历史不会自动同步。

## 参与开发

[贡献指南（English）](CONTRIBUTING.md)包含开发环境配置、针对性检查和安装包构建方法。维护者发布版本时请参考[发布指南](docs/release.md)。

## 许可

采用 [MIT 许可证](LICENSE)。依赖和内置资源仍适用各自的许可证。
