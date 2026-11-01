// Highlights code off the page (src/lib/highlightOffThread.ts): a quadratic input stalls this
// worker, which is ended past its budget, never the tab.
// first: a worker does not run main.tsx, so it fills in what older browsers lack itself
import "./builtins.ts";
import { highlightRuns, type Runs } from "./highlight.ts";
import { serveOffThread } from "./offThread.ts";

serveOffThread<{ source: string; language: string }, Runs>(({ source, language }) => {
  const runs = highlightRuns(source, language);
  return { result: runs, transfer: [runs.lengths.buffer, runs.roles.buffer] };
});
