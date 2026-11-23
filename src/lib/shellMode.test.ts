import { describe, expect, it } from "bun:test";

import { retireServiceWorkers } from "./shellMode.ts";

function fakeWorkers(scopes: readonly string[], options: { controlled?: boolean; refuses?: string } = {}) {
  const unregistered: string[] = [];
  const caches = new Set(["ovis-v4-sheep-abc", "ovis-files-v1"]);
  const reloads: number[] = [];
  const workers = {
    controller: options.controlled ? ({} as ServiceWorker) : null,
    getRegistrations: async () => scopes.map((scope) => ({ scope, unregister: async () => { if (scope === options.refuses) return false; unregistered.push(scope); return true; } }) as unknown as ServiceWorkerRegistration),
  };
  const storage = { keys: async () => [...caches], delete: async (name: string) => caches.delete(name) };
  return { workers, storage, unregistered, caches, reloads, reload: () => { reloads.push(1); } };
}

describe("retireServiceWorkers", () => {
  it("unregisters every worker the hosted shell left on this origin, one per PC's scope, and deletes their caches", async () => {
    const fake = fakeWorkers(["https://app.ovis.sh/s/aa/", "https://app.ovis.sh/s/bb/"]);
    await retireServiceWorkers(fake.workers, fake.storage, fake.reload);
    expect(fake.unregistered).toEqual(["https://app.ovis.sh/s/aa/", "https://app.ovis.sh/s/bb/"]);
    expect([...fake.caches]).toEqual([]);
    expect(fake.reloads).toEqual([]);
  });

  it("loads a page a worker served once more, from the app, and only once a worker went", async () => {
    const served = fakeWorkers(["https://app.ovis.sh/s/aa/"], { controlled: true });
    await retireServiceWorkers(served.workers, served.storage, served.reload);
    expect(served.reloads).toEqual([1]);
    const kept = fakeWorkers(["https://app.ovis.sh/s/aa/"], { controlled: true, refuses: "https://app.ovis.sh/s/aa/" });
    await retireServiceWorkers(kept.workers, kept.storage, kept.reload);
    expect(kept.reloads).toEqual([]);
  });

  it("once none is left, keeps the files cache the page writes itself and deletes a worker's cache a late write left", async () => {
    const fake = fakeWorkers([], { controlled: true });
    await retireServiceWorkers(fake.workers, fake.storage, fake.reload);
    expect([...fake.caches]).toEqual(["ovis-files-v1"]);
    expect(fake.reloads).toEqual([]);
    await retireServiceWorkers(fake.workers, fake.storage, fake.reload);
    expect([...fake.caches]).toEqual(["ovis-files-v1"]);
  });

  it("still unregisters where the page has no cache storage", async () => {
    const fake = fakeWorkers(["https://app.ovis.sh/s/aa/"]);
    await retireServiceWorkers(fake.workers, null, fake.reload);
    expect(fake.unregistered).toEqual(["https://app.ovis.sh/s/aa/"]);
  });
});
