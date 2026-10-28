import type { ComputerAccessibility, ComputerImage, DisplayLayout, Point } from "./protocol.ts";

/** Presentation events never grant control or replace the model's observation/frame. */
export type ComputerPointer = {
  snapshot: string;
  windowId: number;
  point: Point;
  bounds: DisplayLayout["bounds"];
  phase: "move" | "down" | "up";
  visible: boolean;
};
export type ComputerActivity =
  | { type: "start"; id: string }
  | { type: "target"; id: string; target: ComputerAccessibility }
  | { type: "frame"; id: string; image: ComputerImage }
  | { type: "pointer"; id: string; pointer: ComputerPointer }
  | { type: "unavailable"; id: string }
  | { type: "end"; id: string };
