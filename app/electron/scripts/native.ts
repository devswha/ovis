import { join } from "node:path";
import type { ArtifactOptions } from "../../../scripts/server-artifact.ts";
import { installedBinaryVouched } from "../../../server/native-binary.ts";

export function installedHelpers(bin: string): Pick<ArtifactOptions, "ptySidecar" | "acpKeeper"> {
  const helpers: Pick<ArtifactOptions, "ptySidecar" | "acpKeeper"> = {};
  for (const [option, name] of [["ptySidecar", "ovis-pty-sidecar"], ["acpKeeper", "ovis-acp-keeper"]] as const) {
    const binary = join(bin, name);
    if (installedBinaryVouched(binary)) helpers[option] = { binary, record: `${binary}.json` };
  }
  return helpers;
}
