export const builtinToolNames = ["read", "write", "edit", "bash"] as const;
export type BuiltinToolName = (typeof builtinToolNames)[number];
export const builtinTools = [
  { id: "read", name: "读取文件", description: "读取项目中的文本文件和图片。" },
  { id: "write", name: "写入文件", description: "创建文件或覆盖文件内容。" },
  { id: "edit", name: "编辑文件", description: "按指定内容精确替换文件片段。" },
  { id: "bash", name: "执行命令", description: "在项目目录中运行 Shell 命令。" },
] satisfies readonly { id: BuiltinToolName; name: string; description: string }[];
