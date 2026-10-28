import { desktopPoint } from "./protocol.ts";
import type { ComputerCapture, ComputerInput } from "./protocol.ts";

/** Map the complete gesture before consuming its frame or sending any native event. */
export function mapComputerInput(
  input: Exclude<ComputerInput, { action: "open" }>,
  capture: ComputerCapture,
) {
  const point = (value: { x: number; y: number }) => desktopPoint(value, capture);
  if (input.action === "drag")
    return {
      ...input,
      from: point(input.from),
      to: point(input.to),
      ...(input.path ? { path: input.path.map(point) } : {}),
    };
  return "point" in input && input.point ? { ...input, point: point(input.point) } : input;
}
