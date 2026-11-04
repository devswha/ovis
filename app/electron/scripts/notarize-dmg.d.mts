export declare const NOTARY_ENV: readonly string[];
export type Run = (file: string, args: string[]) => Promise<string>;
export declare function notarizeDmg(dmg: string, options?: { env?: Record<string, string | undefined>; run?: Run; log?: (line: string) => void }): Promise<"notarized" | "skipped">;
export default function artifactBuildCompleted(context: { file: string }): Promise<void>;
