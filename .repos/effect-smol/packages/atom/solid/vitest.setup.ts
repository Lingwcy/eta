// oxlint-disable-next-line no-unassigned-import
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vite-plus/test";

afterEach(() => {
  cleanup();
});
