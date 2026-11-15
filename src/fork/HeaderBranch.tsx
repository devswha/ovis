/**
 * The pane's branch as a dim line under its title in the header, no icon, on every screen.
 * A name cut short is whole in a bubble under it on a
 * tap; a press anywhere else, a resize or a scroll closes it.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../lib/i18n.ts";

export function HeaderBranch({ branch }: { branch: string }) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (tip === null) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (button.current?.contains(target) || bubble.current?.contains(target));
    const press = (event: PointerEvent) => { if (!inside(event.target)) setTip(null); };
    const close = () => setTip(null);
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [tip]);
  useEffect(() => setTip(null), [branch]);
  const toggle = (): void => {
    const rect = button.current?.getBoundingClientRect();
    setTip(tip !== null || !rect ? null : { left: rect.left, top: rect.bottom + 6 });
  };
  return (
    <>
      <button ref={button} type="button" className="context-branch" title={branch} aria-expanded={tip !== null} onClick={toggle}>
        <span className="visually-hidden">{t("Branch")}: </span>
        <span className="context-branch-text">{branch}</span>
      </button>
      {tip && createPortal(
        <div ref={bubble} className="context-branch-tip" role="status" style={{ left: tip.left, top: tip.top }}>{branch}</div>,
        document.body,
      )}
    </>
  );
}
