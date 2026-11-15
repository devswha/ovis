import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTS_ON } from "./telemetry-notice.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

// The button counts may be on only in a tree whose every disclosure says they are sent: the notice line the app
// shows, the guide, and both privacy pages. A build that turns them on without those words fails here.
describe("button counts and the words that disclose them", () => {
  test("COUNTS_ON only where the notice, the guide and both privacy pages say buttons are counted", () => {
    const said = [
      read("src/components/TelemetryControls.tsx").includes("Button use and other anonymous usage counts are sent to improve Ovis."),
      read("docs/guide.md").includes("a counts message goes out once for that day"),
      read("ovis-site/privacy/index.html").includes("how often the app's buttons were used that day"),
      read("ovis-site/ko/privacy/index.html").includes("그날 앱의 버튼을 얼마나 썼는지"),
    ];
    if (COUNTS_ON) expect(said).toEqual([true, true, true, true]);
    else expect(said).toEqual([false, false, false, false]);
  });
});
