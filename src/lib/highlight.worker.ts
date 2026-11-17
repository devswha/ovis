import { highlightRuns, type Runs } from "./highlight.ts";
import { serveOffThread } from "./offThread.ts";

serveOffThread<{ source: string; language: string }, Runs>(({ source, language }) => {
  const runs = highlightRuns(source, language);
  return { result: runs, transfer: [runs.lengths.buffer, runs.roles.buffer] };
});
