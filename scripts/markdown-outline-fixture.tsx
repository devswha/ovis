import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { FileViewer } from "../src/components/FileViewer.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";

/** The real viewer over one Markdown file: as the popup, or docked beside a stand-in pane (`?docked`). */
const docked = new URLSearchParams(location.search).has("docked");
const viewer = <FileViewer path="guide.md" paneId={null} docked={docked} onClose={() => document.getElementById("root")!.replaceChildren()} />;
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider>
  {docked ? <div style={{ display: "flex", height: "100vh" }}><main style={{ flex: 1 }} />{viewer}</div> : viewer}
</SettingsProvider></React.StrictMode>);
