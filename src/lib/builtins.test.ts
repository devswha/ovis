import { describe, expect, it } from "bun:test";

// the module fills in only what is missing: each built-in is taken away first, as an old Safari
// lacks it, and Bun's own put back afterwards so later test files see the real ones
const typed = Object.getPrototypeOf(Int8Array.prototype) as object;
const owners: [object, string][] = [[Promise, "withResolvers"], [Object, "hasOwn"], [Array.prototype, "at"], [String.prototype, "at"], [typed, "at"],
  [AbortSignal, "timeout"], [AbortSignal, "any"]];
const native = owners.map(([owner, name]) => [owner, name, Object.getOwnPropertyDescriptor(owner, name)] as const);
for (const [owner, name] of owners) delete (owner as Record<string, unknown>)[name];
// Bun's randomUUID cannot be deleted: a crypto with getRandomValues alone stands in, as on plain http
const host = globalThis as { crypto: Crypto };
const nativeCrypto = host.crypto;
const plainCrypto = { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) } as Crypto;
Object.defineProperty(globalThis, "crypto", { value: plainCrypto, configurable: true, writable: true });
await import("./builtins.ts");
const filled = { withResolvers: Promise.withResolvers, hasOwn: Object.hasOwn, arrayAt: Array.prototype.at, stringAt: String.prototype.at, typedAt: Int8Array.prototype.at,
  timeout: AbortSignal.timeout, any: AbortSignal.any, randomUUID: plainCrypto.randomUUID.bind(plainCrypto) };
Object.defineProperty(globalThis, "crypto", { value: nativeCrypto, configurable: true, writable: true });
for (const [owner, name, descriptor] of native) {
  delete (owner as Record<string, unknown>)[name];
  if (descriptor) Object.defineProperty(owner, name, descriptor);
}

describe("builtins for browsers older than the app's calls", () => {
  it("fills every built-in in, not left to the host's own", () => {
    expect(filled.withResolvers).not.toBe(Promise.withResolvers);
    expect(filled.any).not.toBe(AbortSignal.any);
  });

  it("Promise.withResolvers settles the promise it returns", async () => {
    const yes = filled.withResolvers.call(Promise) as ReturnType<typeof Promise.withResolvers<number>>;
    yes.resolve(3);
    expect(await yes.promise).toBe(3);
    const no = filled.withResolvers.call(Promise) as ReturnType<typeof Promise.withResolvers<number>>;
    no.reject(new Error("refused"));
    await expect(no.promise).rejects.toThrow("refused");
  });

  it("Object.hasOwn sees own keys only, on any object", () => {
    expect(filled.hasOwn({ a: 1 }, "a")).toBe(true);
    expect(filled.hasOwn({ a: 1 }, "toString")).toBe(false);
    expect(filled.hasOwn(Object.create(null) as object, "a")).toBe(false);
  });

  it(".at() counts back from the end and answers undefined past either end", () => {
    expect(filled.arrayAt.call([1, 2, 3], -1)).toBe(3);
    expect(filled.arrayAt.call([1, 2, 3], 0)).toBe(1);
    expect(filled.arrayAt.call([1, 2, 3], 3)).toBeUndefined();
    expect(filled.arrayAt.call([1, 2, 3], -4)).toBeUndefined();
    expect(filled.arrayAt.call([1, 2, 3], 1.7)).toBe(2);
    expect(filled.stringAt.call("abc", -2)).toBe("b");
    expect(filled.typedAt.call(new Uint8Array([5, 6]), -1)).toBe(6);
  });

  it("AbortSignal.any aborts with the first reason given, or at once when one already has", () => {
    const first = new AbortController(), second = new AbortController();
    const joined = filled.any([first.signal, second.signal]);
    expect(joined.aborted).toBe(false);
    second.abort("second");
    first.abort("first");
    expect(joined.aborted).toBe(true);
    expect(joined.reason).toBe("second");
    expect(filled.any([AbortSignal.abort("done")]).reason).toBe("done");
  });

  it("AbortSignal.timeout aborts with a TimeoutError", async () => {
    const signal = filled.timeout(1);
    const reason = await new Promise<unknown>((resolve) => signal.addEventListener("abort", () => resolve(signal.reason)));
    expect((reason as DOMException).name).toBe("TimeoutError");
  });

  it("crypto.randomUUID answers a version 4 UUID", () => {
    const id = filled.randomUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(filled.randomUUID()).not.toBe(id);
  });
});
