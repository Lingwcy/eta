import type { AgentLane, ThinkingLevel } from "@eta/agent";

type InputModel = Pick<
  NonNullable<Awaited<ReturnType<AgentLane["getModel"]>>>,
  "id" | "provider" | "name"
>;

export interface ContextIndicatorProps {
  readonly percentage?: number;
  readonly hideText?: boolean;
  readonly className?: string;
  readonly onClick?: () => void;
}

export interface PromptTextareaProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly minRows?: number;
  readonly className?: string;
}

export interface ActionToolbarProps {
  readonly model?: InputModel;
  readonly thinkingLevel?: ThinkingLevel;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly onSubmit: () => void;
  readonly onStop?: () => void;
  readonly canSubmit: boolean;
  readonly isRunning?: boolean;
  readonly isStopping?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

export interface CompositeInputProps extends Omit<ActionToolbarProps, "onSubmit" | "canSubmit"> {
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onChange?: (value: string) => void;
  /** Resolves when the harness admits the prompt. Rejection preserves the draft. */
  readonly onSubmit?: (text: string) => void | Promise<void>;
  readonly placeholder?: string;
}
