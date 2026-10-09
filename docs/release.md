## 版号规则

vx.x.xxx
eg. v0.0.1
v0.0.2
v0.1.9
每次发版基于前一次版号 + 1

## 发布版本

更新 `package.json` 和 `apps/desktop/package.json` 的版本号，提交并推送后，推送与版本号一致的正式版 tag：

```sh
git tag -a v0.0.3 -m "Eta v0.0.3"
git push origin v0.0.3
```

Desktop release 工作流会测试 tag 对应的源码，构建 macOS Apple Silicon、Intel 安装包和 Windows x64 安装包，并在同一个 Release 发布两个 DMG、Windows EXE 与 SHA-256 校验文件。macOS 更新使用 ZIP 和 `latest-mac.yml`，Windows 更新使用 EXE、blockmap 和 `latest.yml`；所有平台的构建成功、更新文件与校验值验证通过后才正式发布。中文更新说明按 Conventional Commit 分类，包含上一个已发布版本之后的提交；未发布的 tag 不会截断更新记录。上传失败会保留草稿，重跑工作流即可继续；已正式发布的版本在重跑时会保留。
tag 发版默认使用 ad-hoc 签名。将仓库变量 `ETA_SIGNED_RELEASE` 设为 `1`，并配置工作流使用的 Apple 签名 secrets，即可启用 Developer ID 签名与公证。手动工作流仍支持从分支构建安装包，不发布 Release。

Windows 构建在 `windows-latest` runner 上执行，默认未签名，首次安装可能出现 SmartScreen 提示。Windows ARM64 安装包暂未提供。Windows 用户使用命令执行工具前需安装 Git for Windows（含 Git Bash）。

本地在 Windows 上运行 `vp run package:win` 构建 x64 安装包，产物位于 `apps/desktop/dist/release/`。手动运行 Desktop release 工作流也会构建 Windows 安装包，可从工作流 artifacts 下载；`signed` 选项仅控制 macOS 的签名与公证。
