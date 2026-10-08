import type { ImageAttachment } from "../../../../src/images/types.ts";
import type { InputMode, QueuedInput, ThinkingLevel } from "../../../../src/agent/protocol.ts";
import type { AgentModel } from "../../../../src/agent/protocol.ts";
import type { AuthProvider } from "../../../../src/authentication.ts";
import type { ReactNode } from "react";

export type InputModel = Pick<AgentModel, "id" | "provider" | "name" | "thinkingLevels"> &
  Pick<AgentModel, "input" | "inputLimits">;

export type InputProvider = Pick<AuthProvider, "id" | "name">;

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
  readonly skillsControl?: ReactNode;
  readonly inputMode?: InputMode;
  readonly onInputModeChange?: (mode: InputMode) => void;
  readonly model?: InputModel;
  readonly models?: readonly InputModel[];
  readonly providers?: readonly InputProvider[];
  readonly onModelChange?: (model: InputModel, thinkingLevel: ThinkingLevel) => void;
  readonly thinkingLevel?: ThinkingLevel;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly onSubmit: () => void;
  readonly onStop?: () => void;
  readonly onAttach?: () => void;
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
  readonly cwd?: string;
  readonly onSubmit?: (
    text: string,
    images?: readonly ImageAttachment[],
    whenBusy?: InputMode,
  ) => void | Promise<void>;
  readonly queuedInputs?: readonly QueuedInput[];
  readonly onWithdrawInput?: (submissionId: string) => Promise<void>;
  readonly submitDisabled?: boolean;
  readonly placeholder?: string;
}
