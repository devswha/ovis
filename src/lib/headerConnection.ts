import { useEffect, useState } from "react";

export type HeaderConnection = "reconnecting" | "connected" | null;

export interface ConnectionFacts {
  scope: string;
  reportedBy: string | null;
  connected: boolean;
  connectedBefore: boolean;
  outputStopped: boolean;
}

export interface ConnectionTrack {
  lostOn: string | null;
  recoveredOn: string | null;
  /** the loss has lasted RECONNECTING_SHOWN_AFTER_MS: shorter reconnects are never named, nor their return */
  shown: boolean;
}

export const NO_TRACK: ConnectionTrack = { lostOn: null, recoveredOn: null, shown: false };

export const CONNECTED_SHOWN_MS = 2000;
export const RECONNECTING_SHOWN_AFTER_MS = 1000;

const lost = (facts: ConnectionFacts): boolean => !facts.connected && facts.connectedBefore && !facts.outputStopped;

export function stepConnection(track: ConnectionTrack, facts: ConnectionFacts): ConnectionTrack {
  if (facts.reportedBy !== facts.scope) return NO_TRACK;
  if (lost(facts)) return track.lostOn === facts.scope ? track : { lostOn: facts.scope, recoveredOn: null, shown: false };
  if (facts.connected && track.lostOn === facts.scope) return track.shown ? { lostOn: null, recoveredOn: facts.scope, shown: false } : NO_TRACK;
  if (facts.connected && track.recoveredOn === facts.scope) return track;
  return NO_TRACK;
}

export function headerConnection(facts: ConnectionFacts, track: ConnectionTrack): HeaderConnection {
  if (facts.reportedBy !== facts.scope) return null;
  const shownLoss = track.lostOn === facts.scope && track.shown;
  if (!facts.connected) return lost(facts) && shownLoss ? "reconnecting" : null;
  return track.recoveredOn === facts.scope || shownLoss ? "connected" : null;
}

export function useHeaderConnection(facts: ConnectionFacts): HeaderConnection {
  const [track, setTrack] = useState<ConnectionTrack>(NO_TRACK);
  const isLost = lost(facts);
  useEffect(() => {
    setTrack((previous) => stepConnection(previous, facts));
  }, [isLost, facts.connected, facts.scope, facts.reportedBy]);
  useEffect(() => {
    if (track.lostOn === null || track.shown) return;
    const lostOn = track.lostOn;
    const timer = window.setTimeout(() => setTrack((previous) => previous.lostOn === lostOn ? { ...previous, shown: true } : previous), RECONNECTING_SHOWN_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [track.lostOn, track.shown]);
  useEffect(() => {
    if (track.recoveredOn === null) return;
    const timer = window.setTimeout(() => setTrack((previous) => ({ ...previous, recoveredOn: null })), CONNECTED_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [track.recoveredOn]);
  return headerConnection(facts, track);
}
