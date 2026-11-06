import { afterEach, describe, expect, test } from "bun:test";

import { downloadLeavesApp, shareFile } from "./saveImage.ts";

const saved = new Map(["navigator", "Capacitor"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function environment(navigator: Record<string, unknown>, platform?: string): void {
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
  if (platform === undefined) Reflect.deleteProperty(globalThis, "Capacitor");
  else Object.defineProperty(globalThis, "Capacitor", { value: { isNativePlatform: () => true, getPlatform: () => platform }, configurable: true, writable: true });
}

describe("downloadLeavesApp", () => {
  test("is true in a home-screen web app and in the iOS app", () => {
    environment({ standalone: true });
    expect(downloadLeavesApp()).toBe(true);
    environment({}, "ios");
    expect(downloadLeavesApp()).toBe(true);
  });

  test("is false in a browser tab and in the Android app", () => {
    environment({ standalone: false });
    expect(downloadLeavesApp()).toBe(false);
    environment({});
    expect(downloadLeavesApp()).toBe(false);
    environment({}, "android");
    expect(downloadLeavesApp()).toBe(false);
  });
});

describe("shareFile", () => {
  const file = new File(["png"], "shot.png", { type: "image/png" });

  test("hands the file itself to the share sheet", async () => {
    const shared: ShareData[] = [];
    environment({ canShare: () => true, share: async (data: ShareData) => { shared.push(data); } });
    expect(await shareFile(file)).toBe("shared");
    expect(shared).toEqual([{ files: [file] }]);
  });

  test("a dismissed sheet is a cancel, not a failure", async () => {
    environment({ canShare: () => true, share: () => Promise.reject(new DOMException("dismissed", "AbortError")) });
    expect(await shareFile(file)).toBe("cancelled");
  });

  test("fails without a share sheet that takes files, or when it refuses", async () => {
    environment({});
    expect(await shareFile(file)).toBe("failed");
    environment({ canShare: () => false, share: async () => {} });
    expect(await shareFile(file)).toBe("failed");
    environment({ canShare: () => true, share: () => Promise.reject(new DOMException("no gesture", "NotAllowedError")) });
    expect(await shareFile(file)).toBe("failed");
  });
});
