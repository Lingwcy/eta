<p align="center">
  <img src="apps/desktop/renderer/public/eta-icon.png" width="96" height="96" alt="Eta 标志" />
</p>
<h1 align="center">Eta</h1>
<p align="center">桌面上的通用 Agent。</p>
<p align="center"><a href="README.md">English</a> · 简体中文</p>

Eta 是一个桌面 Agent，可以处理文件、理解图片，并将自然语言指令转化为实际操作。我们的目标是让一个 Agent 胜任日常任务，从理解代码到整理工作目录。

## 你可以做什么

- **选择模型。** 连接 AI 账户，或使用自己的 API Key。
- **提供上下文。** 在本地项目中工作，为支持视觉的模型附上图片。
- **让它行动。** 读取、写入、编辑文件或执行命令，自由启用所需的工具。
- **继续工作。** 会话自动保存，随时回来接着完成任务。

## 开始使用

1. 在设置中连接一个模型。
2. 新建聊天，选择项目文件夹。
3. 描述任务。通过 `@图片路径` 添加图片，也可以直接粘贴或拖入图片。

在 **设置 → 权限** 中管理图片读取，在 **设置 → 工具函数** 中启用或停用系统工具。外部工具尚未接入。

顶栏可以同时打开聊天、设置和网页。点击 **+** 新建网页标签，在地址栏输入网址或搜索内容。关闭聊天标签会保留历史，已提交的任务继续运行；切换标签会保留各自的草稿和项目选择。使用 **Cmd/Ctrl+W** 关闭标签，**Cmd/Ctrl+Shift+T** 重新打开。

## 本地运行

安装 [Vite+](https://viteplus.dev/guide/)，然后运行：

```sh
vp install
vp run dev
```

构建 macOS 安装包：

```sh
vp run package:mac
```

`.dmg` 文件保存在 `apps/desktop/dist/release/`。
