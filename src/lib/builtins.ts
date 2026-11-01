/**
 * The built-ins the app calls that are newer than the browsers it is built for (vite.config.ts
 * targets Safari 14), filled in where the browser lacks them (#2513). Imported first by main.tsx,
 * before any module that may call one as it loads, and by the app's own workers, which main.tsx
 * does not reach. The diff package's worker is its own entry and is not covered: it needs Safari 15.4. A real module, not an inline script: the
 * Content-Security-Policy allows only the app's own files.
 */

const define = (owner: object, name: string, value: unknown): void => {
  if (name in owner) return;
  Object.defineProperty(owner, name, { value, writable: true, configurable: true, enumerable: false });
};

// Safari 17.4
define(Promise, "withResolvers", function withResolvers<T>(this: PromiseConstructor) {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new this<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
});

// Safari 15.4
define(Object, "hasOwn", (target: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(Object(target), key));

// Safari 15.4: arrays, strings and typed arrays
function at(this: ArrayLike<unknown>, index: number): unknown {
  const length = this.length;
  const whole = Math.trunc(index) || 0;
  const position = whole < 0 ? length + whole : whole;
  return position < 0 || position >= length ? undefined : this[position];
}
define(Array.prototype, "at", at);
define(String.prototype, "at", function (this: string, index: number) { return at.call(String(this), index); });
define(Object.getPrototypeOf(Int8Array.prototype) as object, "at", at);

if (typeof AbortSignal !== "undefined") {
  // Safari 16
  define(AbortSignal, "timeout", (ms: number): AbortSignal => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return controller.signal;
  });
  // Safari 17.4
  define(AbortSignal, "any", (signals: Iterable<AbortSignal>): AbortSignal => {
    const controller = new AbortController();
    const all = [...signals];
    const done = all.find((signal) => signal.aborted);
    if (done) {
      controller.abort(done.reason);
      return controller.signal;
    }
    const end = (event: Event): void => {
      for (const signal of all) signal.removeEventListener("abort", end);
      controller.abort((event.target as AbortSignal).reason);
    };
    for (const signal of all) signal.addEventListener("abort", end);
    return controller.signal;
  });
}

// Safari 15.4, and never on a plain-http address (not a secure context); getRandomValues is
if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
  define(crypto, "randomUUID", (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
}

export {};
