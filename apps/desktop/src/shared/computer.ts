export type ComputerStatus =
  | { status: "unsupported" }
  | { status: "unavailable"; message: string }
  | { status: "ready" | "permissions"; screen: boolean; accessibility: boolean };
export type ComputerPermission = "screen" | "accessibility";
