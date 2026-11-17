import { useContext, useId } from "react";
import { visualizationName, visualizationTitle, type VisualizationReference } from "../../shared/visualization.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { useT } from "../lib/i18n.ts";
import "./Visualization.css";

export function Visualization({ path, title }: VisualizationReference) {
  const t = useT();
  const open = useContext(OpenFileContext);
  const name = visualizationName(path), second = visualizationTitle({ path, title });
  const named = useId();
  return <div className="markdown-visualization">
    <div className="markdown-visualization-text">
      <span id={named} className="markdown-visualization-name">{name}</span>
      {second !== null && <><br hidden /><span className="markdown-visualization-title">{second}</span></>}
    </div>
    {open && <button type="button" className="btn btn-ghost" aria-describedby={named} onClick={() => open(path)}>{t("Open preview")}</button>}
  </div>;
}
