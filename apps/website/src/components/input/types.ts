/**
 * Agent 任务执行模式。
 */
export type ExecutionMode = "auto" | "speed" | "quality";

/**
 * 上下文窗口指示器属性（Token 用量百分比与环形进度）。
 */
export interface ContextIndicatorProps {
  /** 当前上下文消耗百分比（0-100） */
  readonly percentage?: number;
  /** 是否隐藏百分比文本，仅展示环形进度图标 */
  readonly hideText?: boolean;
  /** 自定义类名 */
  readonly className?: string;
  /** 点击回调 */
  readonly onClick?: () => void;
}

/**
 * 自动伸缩的多行 Prompt 输入框属性。
 */
export interface PromptTextareaProps {
  /** 当前输入值 */
  readonly value: string;
  /** 内容变更回调 */
  readonly onChange: (value: string) => void;
  /** 提交触发回调 */
  readonly onSubmit: () => void;
  /** 占位提示文案 */
  readonly placeholder?: string;
  /** 是否禁用 */
  readonly disabled?: boolean;
  /** 最小展示行数 */
  readonly minRows?: number;
  /** 最大展示行数 */
  readonly maxRows?: number;
  /** 自定义类名 */
  readonly className?: string;
}

/**
 * 底部操作工具栏属性。
 */
export interface ActionToolbarProps {
  /** 当前选中的模型名称 */
  readonly modelName?: string;
  /** 思考/推理强度标签（如 "中"、"高"、"Low"） */
  readonly reasoningLevel?: string;
  /** 点击模型区域的回调 */
  readonly onModelClick?: () => void;
  /** 当前上下文消耗百分比 */
  readonly tokenPercentage?: number;
  /** 是否隐藏上下文百分比文字 */
  readonly hideContextText?: boolean;
  /** 点击上下文窗口指示器的回调 */
  readonly onContextClick?: () => void;
  /** 执行模式（auto / speed / quality） */
  readonly executionMode: ExecutionMode;
  /** 切换执行模式的回调 */
  readonly onExecutionModeChange: (mode: ExecutionMode) => void;
  /** 是否正在语音录音 */
  readonly isListening: boolean;
  /** 切换录音状态的回调 */
  readonly onToggleListening: () => void;
  /** 点击加号添加附件的回调 */
  readonly onPlusClick?: () => void;
  /** 提交消息回调 */
  readonly onSubmit: () => void;
  /** 当前是否允许提交（文本非空且未在提交中） */
  readonly canSubmit: boolean;
  /** 是否正在提交处理中 */
  readonly isSubmitting?: boolean;
  /** 自定义类名 */
  readonly className?: string;
}

/**
 * 复合输入组件根属性。
 */
export interface CompositeInputProps {
  /** 非受控默认输入值 */
  readonly defaultValue?: string;
  /** 内容变更回调 */
  readonly onChange?: (value: string) => void;
  /** 提交消息时的回调函数，附带模型与模式等元数据 */
  readonly onSubmit?: (
    text: string,
    meta: {
      model: string;
      mode: ExecutionMode;
      reasoningLevel?: string;
    },
  ) => void;
  /** 占位提示文案 */
  readonly placeholder?: string;
  /** 上下文消耗百分比 */
  readonly tokenPercentage?: number;
  /** 是否隐藏上下文百分比文本 */
  readonly hideContextText?: boolean;
  /** 点击上下文窗口指示器的回调 */
  readonly onContextClick?: () => void;
  /** 当前选中的模型名称 */
  readonly modelName?: string;
  /** 思考/推理强度标签（如 "中"） */
  readonly reasoningLevel?: string;
  /** 点击模型触发区域的回调 */
  readonly onModelClick?: () => void;
  /** 执行模式 */
  readonly executionMode?: ExecutionMode;
  /** 执行模式变更回调 */
  readonly onExecutionModeChange?: (mode: ExecutionMode) => void;
  /** 是否处于语音录音状态 */
  readonly isListening?: boolean;
  /** 切换语音录音状态的回调 */
  readonly onToggleListening?: () => void;
  /** 点击加号添加附件的回调 */
  readonly onPlusClick?: () => void;
  /** 是否禁用输入 */
  readonly disabled?: boolean;
  /** 是否处于提交中状态 */
  readonly isSubmitting?: boolean;
  /** 自定义类名 */
  readonly className?: string;
}
