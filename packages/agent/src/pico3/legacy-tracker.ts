import {
  type Tracker as ChordTracker,
  type Op,
  track as trackChord,
} from "@earendil-works/chord/delta";

/** Temporary compatibility surface for Pico3's flush-based document handling. */
export interface Tracker<T extends object> {
  readonly state: T;
  readonly target: T;
  readonly dirty: boolean;
  flush(): Op[];
  rebase(): void;
}

export function track<T extends object>(initial: T): Tracker<T> {
  return trackChord(initial);
}
