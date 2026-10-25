import type { CoreEnvironment } from "@eta/core/service/environment";
import type { ComputerPermission, ComputerStatus } from "../../shared/computer.ts";

export type DesktopComputer = NonNullable<CoreEnvironment["computer"]> & {
  status(): ComputerStatus;
  openPermissions(permission: ComputerPermission): Promise<void>;
};
