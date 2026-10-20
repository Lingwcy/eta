import { expect, test } from "vite-plus/test";
import { chooseCategory } from "./settings-category.ts";

const known = new Set(["accounts", "skills", "storage"]);

test("a known category is kept and anything else falls back", () => {
  expect(chooseCategory("skills", known, "accounts")).toBe("skills");
  expect(chooseCategory("removed-page", known, "accounts")).toBe("accounts");
  expect(chooseCategory(undefined, known, "accounts")).toBe("accounts");
  expect(chooseCategory("", known, "accounts")).toBe("accounts");
});
