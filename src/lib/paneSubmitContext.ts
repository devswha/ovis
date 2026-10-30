import { createContext } from "react";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";

/** A retained terminal keeps its live submit/queue lease, not its off-screen composer or chat poll. */
export const PaneSubmitContext = createContext<PaneSubmitRetention | null>(null);
export const PanePresentedContext = createContext(true);
/** A recent off-tab pane keeps its screen; away/alongside-herdr policy still releases its attach. */
export const PaneCachedContext = createContext(false);
/** false for a split tab's pane a phone keeps hidden behind the one it shows: it must not size the shared pty */
export const PaneShownContext = createContext(true);
/** true in the split half that is not active while both halves draw one tab: the active half sizes the
 *  pty, and this half draws its screen at that grid instead of taking it (lib/split.ts) */
export const PaneFollowContext = createContext(false);
