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

macOS release 工作流会测试 tag 对应的源码，构建 Apple Silicon 和 Intel 安装包，并发布两个 DMG 与 SHA-256 校验文件。中文更新说明按 Conventional Commit 分类，包含上一个已发布版本之后的提交；未发布的 tag 不会截断更新记录。上传失败会保留草稿，重跑工作流即可继续；已正式发布的版本在重跑时会保留。
tag 发版默认使用 ad-hoc 签名。将仓库变量 `ETA_SIGNED_RELEASE` 设为 `1`，并配置工作流使用的 Apple 签名 secrets，即可启用 Developer ID 签名与公证。手动工作流仍支持从分支构建安装包，不发布 Release。
