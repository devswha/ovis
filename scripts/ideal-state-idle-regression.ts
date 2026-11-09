import assert from "node:assert/strict";
import { startDemo, type Demo } from "./ideal-state-behaviour-harness.ts";
import { probeIdleState } from "./ideal-state-idle.ts";

const demo = await startDemo();
try {
  const idle = await probeIdleState(demo);
  console.log(`${idle.status} IS-018 clean: ${idle.value}`);
  assert.equal(idle.status, "PASS", idle.value);
  const dangerDemo: Demo = {
    ...demo,
    async open(options) {
      const visit = await demo.open(options);
      try {
        await visit.page.evaluate(() => {
          const block = document.createElement("div");
          block.className = "reviewer-danger";
          block.style.cssText = "position:fixed;top:50px;left:50px;width:44px;height:44px;background:var(--status-blocked);z-index:99999";
          document.body.append(block);
        });
        const measured = await visit.page.locator(".reviewer-danger").evaluate((block) => ({
          background: getComputedStyle(block).backgroundColor,
          width: block.getBoundingClientRect().width,
          height: block.getBoundingClientRect().height,
        }));
        console.log("INJECTED", measured);
        assert.equal(measured.width, 44);
        assert.equal(measured.height, 44);
        return visit;
      } catch (error) {
        await visit.context.close();
        throw error;
      }
    },
  };
  const danger = await probeIdleState(dangerDemo);
  console.log(`${danger.status} IS-018 injected: ${danger.value}`);
  assert.equal(danger.status, "FAIL", danger.value);
  assert.equal(danger.value, "all agents idle: 0 running animations [], 1 danger elements [div.reviewer-danger]");
} finally {
  await demo.close();
}
