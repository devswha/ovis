import type { PaneView } from "./actions.ts";
import type { DefaultView } from "./settings.ts";

export function defaultLens(hasAgent: boolean | null, defaultView: DefaultView, coarse: boolean): PaneView {
  if (defaultView === "chat") return hasAgent !== false ? "chat" : "terminal";
  if (defaultView === "terminal") return "terminal";
  return hasAgent !== false && coarse ? "chat" : "terminal";
}

export class PaneLenses {
  private readonly settled = new Map<string, PaneView>();
  constructor(private readonly defaultView: DefaultView) {}

  of(key: string, hasAgent: boolean | null, coarse: boolean): PaneView {
    const settled = this.settled.get(key);
    if (settled !== undefined) return settled;
    const lens = defaultLens(hasAgent, this.defaultView, coarse);
    if (hasAgent !== null) this.settled.set(key, lens);
    return lens;
  }

  peek(key: string, hasAgent: boolean | null, coarse: boolean): PaneView {
    return this.settled.get(key) ?? defaultLens(hasAgent, this.defaultView, coarse);
  }

  startedAgent(key: string, coarse: boolean): void {
    this.settled.set(key, defaultLens(true, this.defaultView, coarse));
  }
}
