import type { DesktopLibrary } from "../../../../src/bridge.ts";

export interface SearchDialogProps {
  library: DesktopLibrary | null;
  archived: boolean;
  busy: boolean;
  canCreate: boolean;
  runningThreadIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onChoose: () => void;
}
