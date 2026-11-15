import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { read, repo } from "../../scripts/source-scan.ts";
import { FRIENDS } from "../../shared/friends.ts";

describe("fork assets", () => {
  it("keeps every notification friend identical to the sidebar", () => {
    const res = "app/android/ovis-push/src/main/res/drawable-nodpi";
    const icon = read("app/android/ovis-push/src/main/java/sh/ovis/push/FriendIcon.java");
    for (const friend of FRIENDS) {
      expect(readFileSync(join(repo, `${res}/friend_${friend}.png`)).equals(readFileSync(join(repo, `src/assets/friends/${friend}.png`)))).toBe(true);
      expect(icon).toContain(`R.drawable.friend_${friend}`);
    }
  });
});
