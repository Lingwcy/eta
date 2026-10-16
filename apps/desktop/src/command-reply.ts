import type { CommandErrorDto, CommandReply } from "./bridge.ts";
import type { MessageReference } from "./shared/i18n/messages.ts";

/** Electron otherwise serializes rejected invoke calls as message-only Errors. */
export class DesktopCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly localization?: MessageReference;
  constructor(error: CommandErrorDto) {
    super(error.message);
    this.name = "DesktopCommandError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.localization = error.localization;
  }
}

export function unwrapReply<A>(reply: CommandReply<A>): A {
  if (!reply.ok) throw new DesktopCommandError(reply.error);
  return reply.value;
}
