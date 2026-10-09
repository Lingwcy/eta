export function sessionId(value: unknown) {
  if (typeof value !== "string" || !value) throw new Error("会话 ID 无效");
  return value;
}
