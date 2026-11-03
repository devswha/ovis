import { useEffect } from "react";
import type { Machine } from "../../shared/machines.ts";
import { setTabLabelLearning, settleTabLabels, subscribeTabLabels } from "./tabLabels.ts";

/** Labels from first messages (#2019): keyed once their pane is seen, gone with their pane, all gone with the setting off. */
export function useTabLabelLearning(machines: readonly Pick<Machine, "id" | "state" | "snapshot">[], enabled: boolean, watching: boolean): void {
  useEffect(() => {
    setTabLabelLearning(enabled, watching);
    const settle = (): void => settleTabLabels(machines);
    settle();
    return subscribeTabLabels(settle);
  }, [machines, enabled, watching]);
}
