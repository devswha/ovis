import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import type { AgentStatus, ConversationMetadata } from "../../../shared/protocol.ts";
import { AgentMark } from "../../components/AgentMark.tsx";
import { RowMenu } from "../../components/RowMenu.tsx";
import { ThinkingSlider } from "../../components/ThinkingSlider.tsx";
import { contextLeftPercent, formatTokens } from "../../lib/compose.ts";
import { useT } from "../../lib/i18n.ts";
import { modelLabel } from "../../lib/modelName.ts";
import { useSettings } from "../../lib/settings.ts";
import { modelMark } from "./modelMark.ts";

/** Upstream's display-only ring: the optional picker supplies the enclosing button. */
function ContextRing({ context }: { context: NonNullable<ConversationMetadata["context"]> }) {
  const t = useT();
  const left = contextLeftPercent(context);
  if (left === null || context.window === null) return null;
  const label = t("Context {percent}% left", { percent: left });
  const detail = t("{used} of {window} tokens", { used: formatTokens(context.used), window: formatTokens(context.window) });
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return <span className={`composer-context${left <= 20 ? " is-low" : ""}`} title={`${label} · ${detail}`}>
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle className="composer-context-track" cx="8" cy="8" r={radius} />
      <circle className="composer-context-used" cx="8" cy="8" r={radius}
        strokeDasharray={`${circumference * (100 - left) / 100} ${circumference}`} transform="rotate(-90 8 8)" />
    </svg>
    <span className="visually-hidden">{label} · {detail}</span>
  </span>;
}

interface PillOptions {
  metadata?: ConversationMetadata | null;
  agent: string | null;
  role: string;
  connected: boolean;
  sending: boolean;
  isWorking: boolean;
  agentStatus?: AgentStatus;
  onCommand?: (text: string) => boolean;
  onRefused: (note: string) => void;
}

/** Owns optimistic Pi picks and their menu without coupling Composer's input lifecycle to them. */
export function useForkComposer({ metadata, agent, role, connected, sending, isWorking, agentStatus, onCommand, onRefused }: PillOptions) {
  const t = useT();
  const { settings } = useSettings();
  const [modelMenu, setModelMenu] = useState<HTMLElement | null>(null);
  const [picked, setPicked] = useState<{ id: string; level: string | null } | null>(null);
  const models = settings.piModelPicker && agent === "pi" && role !== "observe" && metadata?.models?.length ? metadata.models : undefined;
  const recordedModel = models?.find((entry) => entry.current);
  const pickedModel = picked === null ? undefined : models?.find((entry) => entry.id === picked.id);
  const currentModel = pickedModel ?? recordedModel;
  const effort = picked?.level ?? metadata?.reasoning_effort ?? null;
  const settled = picked !== null && recordedModel?.id === picked.id && (picked.level === null || metadata?.reasoning_effort === picked.level);
  useEffect(() => {
    if (picked === null) return;
    if (settled) return setPicked(null);
    const timer = window.setTimeout(() => setPicked(null), 8000);
    return () => window.clearTimeout(timer);
  }, [picked, settled]);
  const modelId = pickedModel ? pickedModel.id.slice(pickedModel.id.indexOf("/") + 1) : metadata?.model;
  const modelShown = Boolean(modelId || effort);
  const label = modelId ? modelLabel(modelId) : null;
  const model = label && !label.named && currentModel ? { ...label, text: currentModel.name, named: true } : label;
  const switchable = connected && !sending && !isWorking && agentStatus !== "blocked" && onCommand !== undefined;
  const switchTo = (id: string, level: string | null = null): void => {
    setModelMenu(null);
    if (onCommand?.(`/ovis-model ${id}${level ? ` ${level}` : ""}`)) setPicked({ id, level });
    else onRefused(t("Not confirmed. Check the terminal before sending again."));
  };
  const renderPill = (usage: ReactNode): ReactNode => {
    const body = <>
      {modelShown && <span className="composer-model-info" aria-label={t("Model and reasoning")}>
        <span className={`composer-model${model ? model.named ? "" : " is-id" : " is-none"}`} title={modelId ?? t("Model not available")}>{model?.text ?? t("Model —")}</span>
        {model?.named && <span className="composer-model-id visually-hidden">{modelId}</span>}
        <span className={`composer-reasoning${effort ? "" : " visually-hidden"}`} title={effort ? t("Reasoning effort: {effort}", { effort }) : t("Reasoning effort not available")}>
          <span className="composer-reasoning-full visually-hidden">{t("Reasoning {effort}", { effort: effort ?? "—" })}</span>
          {effort && <><span className="composer-reasoning-dot" aria-hidden="true">·</span><span className="composer-reasoning-short" aria-hidden="true">{effort}</span></>}
        </span>
      </span>}
      {metadata?.context && <ContextRing context={metadata.context} />}
      {usage}
    </>;
    return <>
      <span className={`composer-pill${metadata?.model ? "" : " is-bare"}`}>
        {agent && <AgentMark agent={agent} size={14} />}
        {models ? <button type="button" className="composer-pill-menu" aria-haspopup="menu" aria-expanded={modelMenu !== null}
          disabled={!switchable} title={switchable ? t("Switch model") : t("Switch the model once the agent is idle")}
          onClick={(event) => setModelMenu(modelMenu ? null : event.currentTarget)}>
          {body}<ChevronDown className="composer-pill-chevron" aria-hidden="true" />
        </button> : body}
      </span>
      {modelMenu && models && <RowMenu anchor={modelMenu} title={t("Model")} onClose={() => setModelMenu(null)}
        items={models.map((entry) => {
          const mark = modelMark(entry.id);
          return { id: entry.id, label: entry.name, icon: Cpu, glyph: mark ? <AgentMark agent={mark} size={16} /> : undefined, checked: entry.id === currentModel?.id,
            run: () => { if (entry.id !== currentModel?.id) switchTo(entry.id); } };
        })}
        footer={currentModel && currentModel.levels.length > 1 ? <ThinkingSlider levels={currentModel.levels} value={effort} disabled={!switchable}
          onCommit={(level) => switchTo(currentModel.id, level)} /> : undefined} />}
    </>;
  };
  return { modelId, effort, renderPill };
}
