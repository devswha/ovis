import { createContext } from "react";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";

export const PaneSubmitContext = createContext<PaneSubmitRetention | null>(null);
export const PanePresentedContext = createContext(true);
export const PaneCachedContext = createContext(false);
export const PaneWatchedContext = createContext(false);
/** false for a split tab's pane a phone keeps hidden behind the one it shows: it must not size the shared pty */
export const PaneShownContext = createContext(true);
export const PaneCoveredContext = createContext(false);
export const PaneFollowContext = createContext(false);
export const PanePressContext = createContext<((machineId: string, paneId: string) => void) | null>(null);
