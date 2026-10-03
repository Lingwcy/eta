import type { CommandErrorDto, CommandReply } from "./bridge.ts";

/** Electron otherwise serializes rejected invoke calls as message-only Errors. */
export class DesktopCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(error: CommandErrorDto) {
    super(error.message);
    this.name = "DesktopCommandError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export function unwrapReply<A>(reply: CommandReply<A>): A {
  if (!reply.ok) throw new DesktopCommandError(reply.error);
  return reply.value;
}
