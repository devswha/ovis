import "./RelayStepFrame.css";

import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

export interface RelayStepBack { readonly label: string; readonly onClick: () => void }

/**
 * One step of a pairing on a plain page: Back at the top left, a thin bar for how far the pairing is,
 * an optional note of what it waits for, then the step's own content, whose actions sit at the foot.
 */
export function RelayStepFrame({ step, back, note, children }: {
  readonly step: 1 | 2 | 3 | null; readonly back: RelayStepBack | null; readonly note: string | null; readonly children: ReactNode;
}) {
  return (
    <div className="relay-step">
      {note !== null && <div className="relay-step-note" aria-hidden="true"><span>{note}</span><span className="boot-spinner" /></div>}
      <div className="relay-step-top">
        {back && <button type="button" className="relay-step-back" aria-label={back.label} onClick={back.onClick}><ChevronLeft aria-hidden="true" /></button>}
      </div>
      {step !== null && <div className="relay-step-progress" aria-hidden="true" data-step={step}><span /></div>}
      {children}
    </div>
  );
}
