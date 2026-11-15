import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_BUNDLE, selfHostedWranglerToml } from "./build-relay.ts";

type Config = Record<string, unknown> & { env?: unknown; vars?: unknown; routes?: unknown };

test("the wrangler.toml shipped with the Worker bundle deploys it on another account: no relay.ovis.sh, no staging copy, passes off, every binding kept", () => {
  const source = readFileSync(join(import.meta.dir, "..", "relay", "wrangler.toml"), "utf8");
  const production = Bun.TOML.parse(source) as Config;
  const text = selfHostedWranglerToml(source);
  const shipped = Bun.TOML.parse(text) as Config;
  expect(text).not.toContain("relay.ovis.sh");
  expect(shipped["main"]).toBe(WORKER_BUNDLE);
  expect(shipped["workers_dev"]).toBe(true);
  for (const key of ["routes", "env", "vars"]) expect(shipped).not.toHaveProperty(key);
  for (const key of ["name", "compatibility_date", "observability", "durable_objects", "analytics_engine_datasets", "migrations", "ratelimits"]) {
    expect([key, shipped[key]]).toEqual([key, production[key]]);
  }
});
