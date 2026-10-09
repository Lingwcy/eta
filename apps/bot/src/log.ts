export interface BotEvent {
  event: string;
  threadId?: string;
  requestId?: string;
  operationId?: string;
  issueId?: string;
  inboxId?: string;
  taskId?: string;
  deliveryId?: string;
  code?: string;
}
export type BotLog = (event: BotEvent) => void;
