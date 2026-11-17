import { createContext } from "react";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";

export const PaneSubmitContext = createContext<PaneSubmitRetention | null>(null);
export const PanePresentedContext = createContext(true);
export const PaneCachedContext = createContext(false);
export const PaneWatchedContext = createContext(false);
export const PaneShownContext = createContext(true);
export const PaneCoveredContext = createContext(false);
export const PaneFollowContext = createContext(false);
export const PanePressContext = createContext<((machineId: string, paneId: string) => void) | null>(null);
