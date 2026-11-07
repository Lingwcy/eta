export type QuotaConnection = { providerId: string; connectionId: string };

export type QuotaWindow = {
  id: string;
  name: string;
  usedPercent?: number;
  remaining?: number;
  total?: number;
  unlimited?: boolean;
  resetsAt?: number;
  windowMinutes?: number;
};

export type SubscriptionQuota = QuotaConnection & {
  status: "ready" | "error";
  windows: QuotaWindow[];
  readAt?: number;
  stale?: boolean;
  error?: "unavailable" | "unauthorized" | "rate-limit";
  retryAt?: number;
};
