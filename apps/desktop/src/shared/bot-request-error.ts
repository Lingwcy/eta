/** Transport failures retain retry policy across the main/preload command boundary. */
export class BotRequestError extends Error {
  readonly code = "BotRequestFailed";

  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.retryable = retryable;
    this.name = "BotRequestError";
  }
}
