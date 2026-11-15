import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationMetadata } from "../../shared/protocol.ts";
import { contextLeftPercent, formatTokens } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";

/** Ordinary upstream indicator, or an optional touch-accessible context tooltip. */
export function ContextRing({ context, interactive = false }: { context: NonNullable<ConversationMetadata["context"]>; interactive?: boolean }) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (tip === null || !interactive) return;
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
  }, [tip, interactive]);
  const left = contextLeftPercent(context);
  if (left === null || context.window === null) return null;
  const detail = `${t("Context {percent}% left", { percent: left })} · ${t("{used} of {window} tokens", { used: formatTokens(context.used), window: formatTokens(context.window) })}`;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const circle = <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle className="composer-context-track" cx="8" cy="8" r={radius} />
    <circle className="composer-context-used" cx="8" cy="8" r={radius} strokeDasharray={`${circumference * (100 - left) / 100} ${circumference}`} transform="rotate(-90 8 8)" />
  </svg>;
  const className = `composer-context${left <= 20 ? " is-low" : ""}`;
  if (!interactive) return <span className={className} title={detail}>{circle}<span className="visually-hidden">{detail}</span></span>;
  return <>
    <button ref={button} type="button" className={className} aria-label={detail} title={detail} aria-expanded={tip !== null} onClick={() => {
      const rect = button.current?.getBoundingClientRect();
      setTip(tip !== null || !rect ? null : { left: rect.left + rect.width / 2, bottom: window.innerHeight - rect.top + 6 });
    }}>{circle}</button>
    {tip && createPortal(<div ref={bubble} className="composer-context-tip" role="status" style={{ left: tip.left, bottom: tip.bottom }}><span>{detail}</span></div>, document.body)}
  </>;
}
