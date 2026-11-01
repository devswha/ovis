import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { GjcSdkLookupError, lookupExecutionError } from "./gjc-sdk-error.ts";

export interface GjcSdkGenerationObserver {
  generationStatus(sessionId: string, generation: number): Promise<{ readonly status: string }>;
}

type ObserverConstructor = new (options: { agentDir: string; observer: true }) => GjcSdkGenerationObserver;
const observers = new Map<string, Promise<GjcSdkGenerationObserver>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObserverConstructor(value: unknown): value is ObserverConstructor {
  return typeof value === "function";
}

function observerFor(agentDir: string, cliPath?: string): Promise<GjcSdkGenerationObserver> {
  const key = `${agentDir}\0${cliPath ?? ""}`;
  let observer = observers.get(key);
  if (!observer) {
    observer = (async () => {
      const cli = cliPath ?? Bun.which("gjc");
      if (!cli) throw new Error("GJC SDK unavailable");
      // Resolve the installed CLI's supported public SDK, never a guessed private
      // index/endpoint path. This observer is not started or attached to a session.
      const modulePath = Bun.resolveSync("@gajae-code/coding-agent/sdk", dirname(realpathSync(cli)));
      const sdk: unknown = await import(modulePath);
      if (!isRecord(sdk)) throw new Error("GJC generation API unavailable");
      const router = sdk["router"];
      if (!isRecord(router)) throw new Error("GJC generation API unavailable");
      const Observer = router["SessionRouter"];
      if (!isObserverConstructor(Observer)) throw new Error("GJC generation API unavailable");
      return new Observer({ agentDir, observer: true });
    })();
    observers.set(key, observer);
    void observer.catch(() => { if (observers.get(key) === observer) observers.delete(key); });
  }
  return observer;
}

/** A cached broker row is a candidate, never current authority after /new or retirement. */
export async function gjcSdkGenerationCurrent(
  agentDir: string,
  sessionId: string,
  generation: number,
  observer?: GjcSdkGenerationObserver | Promise<GjcSdkGenerationObserver>,
  cliPath?: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(observer ?? observerFor(agentDir, cliPath)).then(async (current) => (await current.generationStatus(sessionId, generation)).status === "current"),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new GjcSdkLookupError("timeout")), 2_000); }),
    ]);
  }
  catch (error) { throw lookupExecutionError(error); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
