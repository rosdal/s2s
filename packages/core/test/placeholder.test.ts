import { expect, test } from "vitest";

test("core package loads", async () => {
  const mod = await import("../src/index.js");
  expect(mod).toBeTypeOf("object");
});
