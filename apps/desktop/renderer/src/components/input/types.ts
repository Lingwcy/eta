import type { ThinkingLevel } from "../../../../src/agent/protocol.ts";
import type { AgentModel } from "../../../../src/agent/protocol.ts";

export type InputModel = Pick<AgentModel, "id" | "provider" | "name">;

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
  readonly models?: readonly InputModel[];
  readonly onModelChange?: (model: InputModel, thinkingLevel: ThinkingLevel) => void;
  readonly thinkingLevel?: ThinkingLevel;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly onSubmit: () => void;
  readonly onStop?: () => void;
  readonly onSettings?: () => void;
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
  readonly submitDisabled?: boolean;
  readonly placeholder?: string;
}
