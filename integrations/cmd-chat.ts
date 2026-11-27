import { execFile } from "node:child_process";

interface Hook {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout: number;
}

interface ToolCall {
  readonly toolName: string;
  readonly input: unknown;
}

interface Mod {
  hooks(hooks: {
    onPermissionRequest(event: ToolCall & { description: string | null; isSafetyPrompt: boolean }): Promise<"allow" | "deny" | undefined>;
    beforeToolCall(event: ToolCall, context?: { signal?: AbortSignal }): Promise<{ result: { type: "text"; text: string }[] } | undefined>;
    onSessionEnd(): void;
    onSessionStart(): void;
  }): void;
  on(name: "run_start" | "run_end" | "interrupted" | "run_error", listener: () => void): void;
}

/** The relay prints only an authenticated hub reply. No retries: Command Code blocks its own
 * prompt while the hook runs, so an absent Chat must release the terminal immediately. */
export default function chatMod(cmd: Mod, hook: Hook): (id: string | null) => void {
  let lifetime = new AbortController();
  const ask = (event: unknown, signal: AbortSignal): Promise<unknown> => new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined);
    const child = execFile(hook.command, hook.args, { signal, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error || !stdout) return resolve(undefined);
      try { resolve(JSON.parse(stdout)); } catch { resolve(undefined); }
    });
    child.stdin?.on("error", () => { /* relay already exited; its callback settles the request */ });
    child.stdin?.end(JSON.stringify(event));
  });
  let telling = Promise.resolve();
  const tell = (event: unknown) => {
    telling = telling.then(async () => { await ask(event, AbortSignal.timeout(5_000)); });
  };
  cmd.on("run_start", () => {
    if (lifetime.signal.aborted) lifetime = new AbortController();
    tell({ run: "began" });
  });
  cmd.on("interrupted", () => lifetime.abort());
  cmd.on("run_error", () => lifetime.abort());
  cmd.on("run_end", () => { lifetime.abort(); tell({ run: "ended" }); });
  cmd.hooks({
    onSessionEnd: () => lifetime.abort(),
    onSessionStart: () => { if (lifetime.signal.aborted) lifetime = new AbortController(); },
    async onPermissionRequest({ toolName, input, description, isSafetyPrompt }) {
      if (isSafetyPrompt !== false) return;
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(hook.timeout)]);
      const answer = await ask({ permission: { toolName, input, description } }, signal);
      return !signal.aborted && (answer === "allow" || answer === "deny") ? answer : undefined;
    },
    async beforeToolCall({ toolName, input }, context) {
      if (toolName !== "ask_user_question" || typeof input !== "object" || !input || !("questions" in input)
        || !Array.isArray(input.questions) || !input.questions.length || input.questions.length > 4) return;
      const texts = new Set<string>();
      const answers: string[] = [];
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(hook.timeout), ...context?.signal ? [context.signal] : []]);
      for (const question of input.questions) {
        if (typeof question?.question !== "string" || texts.has(question.question)) return;
        texts.add(question.question);
        const reply = await ask({ question }, signal);
        if (typeof reply !== "object" || !reply || !("answer" in reply) || typeof reply.answer !== "string" || signal.aborted) return;
        answers.push(`${question.question} → ${reply.answer}`);
      }
      return { result: [{ type: "text", text: `${answers.join("\n")}\n\nContinue with the user's answers in mind.` }] };
    },
  });
  let session: string | null = null;
  return (id) => {
    if (id !== null) tell({ session: id });
    else tell({ ended: session });
    session = id;
  };
}
