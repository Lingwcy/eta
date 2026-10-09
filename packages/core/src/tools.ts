export const builtinToolNames = ["read", "write", "edit", "bash"] as const;
export type BuiltinToolName = (typeof builtinToolNames)[number];
