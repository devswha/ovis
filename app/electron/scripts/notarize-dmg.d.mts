export declare const NOTARY_ENV: readonly string[];
export declare const STAPLE_WAITS: readonly number[];
export type Run = (file: string, args: string[]) => Promise<string>;
export type Options = { env?: Record<string, string | undefined>; run?: Run; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> };
export declare const run: Run;
export declare function isNetworkFailure(error: unknown): boolean;
export declare function notarizeApp(app: string, options?: Options): Promise<"notarized" | "skipped">;
export declare function notarizeDmg(dmg: string, options?: Options): Promise<"notarized" | "skipped">;
export default function artifactBuildCompleted(context: { file: string }): Promise<void>;
