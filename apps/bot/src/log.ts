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
  operation?: string;
  request?: number;
  phase?: string;
  outcome?: "pending" | "completed" | "failed";
  elapsedMs?: number;
  cpuMicros?: number;
  eventLoopUtilization?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  heapLimitBytes?: number;
}
export type BotLog = (event: BotEvent) => void;
