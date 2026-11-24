import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

it("direct bridge owners await Seen persistence during shutdown", () => {
  expect(source("remote-entry.ts")).toMatch(/await server\.stop\(\)/);
  expect(source("herdr-core/machine-entry.ts")).toMatch(/await server\.stop\(\)/);
  expect(source("herdr-core/machine-bridge.ts")).toMatch(/child\.exited\.then/);
});
