/**
 * 复合输入组件模块导出出口
 */
import { CompositeInput } from "./composite-input";

export { CompositeInput };
export default CompositeInput;

// 子组件导出
export { ContextIndicator } from "./context-indicator";
export { PromptTextarea } from "./prompt-textarea";
export { ActionToolbar } from "./action-toolbar";

// 类型导出
export type {
  ExecutionMode,
  ContextIndicatorProps,
  PromptTextareaProps,
  ActionToolbarProps,
  CompositeInputProps,
} from "./types";
