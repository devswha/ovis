# Harness contract (draft, H0)

The contract for Ovis's harness layer: what it says about machines, harnesses and sessions, the
harness tool Ovis hands to agents it starts, and the safety rules around both. It is a draft for the
owner to decide on. No code implements it yet.

- Source: the direction plan `ovis-direction-1123` (`PLAN.ko.md`, revision 2), chapters 11 and 12
  and step H0 of 4.7. ACP background is in its chapters 10 and 13.
- Code cited at `origin/main` 9deae046d (2026-11-23).
- Marks: **(read)** seen in the code or docs at that commit, **(plan)** taken from the plan,
  **(proposal)** this draft's own suggestion, **(unverified)** nobody has checked it.
- Revised the same day on the owner's direction (2026-11-23, relayed by Dori): Ovis drives the
  harness an agent asks for as the ACP client, with every approval going to a person. See
  [the goal](#decisions-for-the-owner) and [where ACP stands](#what-ovis-is-in-this-contract).
- Not in this draft: the M15 result table that H0's exit asks for. M15 is a measurement (does the
  Ovis path report turn end, the turn's last answer and a pending approval better than `hc wait` and
  `hc read`?). It has not run. If it fails, the harness tool keeps only the view and safety verbs and
  leaves send, wait and result to hc (plan, M15).

## Decisions for the owner

**The goal (owner, 2026-11-23).** With Ovis installed, an agent such as Claude Code or omo uses
other harnesses, Gemini CLI or agy (Antigravity) first, freely over ACP:

- The calling agent calls one tool Ovis gave it (ask another harness, or hand it a task).
- Ovis is the ACP client. It starts that harness, sends the task and returns the answer.
- The harness's conversation shows in Ovis's screens, under the agent that asked.
- Every permission request (`session/request_permission`) goes to a person as Ovis's approval card,
  never to the calling agent. An ask whose harness requests nothing, a read-only question, ends with
  no card.
- The calling agent never becomes the ACP client itself and never receives an approval request.
- Scope: this PC first.

H0 is done when these four are decided. Everything below is written for the recommended answer;
another answer changes the parts named in the last column.

| # | Question | Options | Recommendation | What it changes here |
|---|---|---|---|---|
| D18 | Does Ovis own a common harness-layer interface? | (a) No: human screens and hc only. (b) This contract in writing (H0), then read-only commands for people (H1). (c) Also the harness tool handed to agents (H2, H3). | (c), for the goal above and on this PC only: this contract (H0), then the harness tool with ACP drive on this PC (H2), with the read-only human commands (H1) beside it. Another machine comes later (H3). Ovis still never decides or hands out work (D22): it runs the one ask the calling agent made. | (a) drops this document. (b) builds only [the human commands](#commands-and-the-code-they-use). (c) adds the `ovis agent` rows, the ACP drive path and [the safety rules](#safety-rules-g1g12). |
| D19 | What may an agent do through the harness tool? | (a) View only: list, state, transcript. (b) + start and send on this PC, where the user turned it on. (c) + start on another machine. (d) + answer approvals. | (b) on this PC, which the goal needs. While the tool is off (the default, G10) an agent may do nothing; once the user turns it on for this PC, an agent may start a harness here and send it a task with no card for the start. The harness's own permission requests still go to a person as cards; an ask that needs none ends without one. (c) later, through a person's card every time. (d) never: only a person approves, and the calling agent never holds the ACP connection. Machine commands (`exec`, `file`) stay hc's and Ovis does not open them. | Sets the `scope` values in [the schema](#schema-draft) and rules G2, G3 and G8. |
| D21 | What shape is the contract? | (a) One schema that generates the types, with the commands' `--json` output as the stable surface. (b) TypeScript types only. | (a). It survives a Rust port of the inside unchanged (plan 11.3). | (b) drops the schema file and the generated types; the tables still apply. |
| D23 | Default limits of the harness tool | Depth (may a child start children?), children per parent, time and cost per child. | Depth 1 (settable up to 3), 4 running children per parent, 60 minutes per child. Cost counted only where the harness reports it, else time and turn count. This draft adds 30 calls per minute per run for G7, which the plan leaves without a number **(proposal)**. | The `Limits` defaults and rules G4, G5 and G7. |

Related but not needed for H0:

- D15, D16, D17 (ACP drive). The goal turns D15 from "not now" toward drive by Ovis, for children
  an agent asks for. Where the ACP agent process lives (D16): this draft proposes the Ovis server's
  own child for the first version on this PC; a server restart then ends the turn as `gone`. The
  keeper process in a herdr-core terminal (plan 13) is the later answer. Adapters (`claude-agent-acp`,
  `codex-acp`) are installed by the user; Ovis does not download them (D17). **(proposal)**
- D20: how another machine is reached. hc machines come first, then a PC-to-PC path over the Ovis
  relay as H6.
- D9: how far hooks go. The turn-end hook in the G-rules and
  [results](#where-wait-and-result-come-from) assumes D9 reaches (c).

## What Ovis is in this contract

Ovis does not orchestrate (D22, received 2026-11-23). What to do and who does it is decided by an
orchestrator (dori, omo, a skill) or by the agent itself. Ovis has three roles (plan 12.1):

1. **The window people look through.** People see every agent, including the ones agents start,
   and answer their approvals. An agent in a terminal is a real TUI in a herdr-core terminal that
   people can step into. An agent Ovis drives over ACP has no TUI: its conversation is drawn in
   Ovis's chat view.
2. **The place agents get tools.** Ovis puts tools into an agent when it starts it (today the browser
   tool; next the harness tool and the memory tool).
3. **The safety rails.** Limits, human approval and a record for every agent an agent starts.

The harness tool therefore offers one start, one send and one result at a time, done safely. It has
no queue, schedule, automatic retry, fan-out, "look at the result and decide the next step", no
approval verb and no machine commands (plan 12.2). If any of these comes in, Ovis has become an
orchestrator.

**Where ACP stands.** ACP is a secondary channel beside the terminal (plan 10, 13; this replaces
the earlier "ACP is not Ovis's path"). In this contract it is four things:

- **The vocabulary.** Sessions, turns, `session/update` kinds, permission option kinds and stop
  reasons use ACP's names, whatever the transport.
- **How the harness tool drives a child (owner, 2026-11-23).** For a harness that speaks ACP
  (`drive` includes `acp`), Ovis runs the child as its ACP client. That changes plan 12.4 as
  follows:
  - The ACP connection is Ovis's. The calling agent holds none: it gets no socket, no ACP command
    and no adapter to run, only the harness tool's answers.
  - Every `session/request_permission` becomes a card for a person, with the agent's own options
    (`allow_once`, `reject_once` and the rest) passed unchanged. The calling agent sees only
    `waiting_human` (G8 holds).
  - Ovis adds no approval of its own, so a child that requests nothing ends with no card.
  - Ovis offers the agent no client file or terminal methods (`fs/*`, `terminal/*`). ACP v2 drops
    them anyway (plan 10.1).
  - A harness without ACP is driven in a terminal instead (see the fallback after the schema).
- **A read channel.** An agent Ovis has no transcript reader for can be read with `session/list` and
  `session/load` once M13 shows that is safe (A2, D14). That surfaces as `transcript: "acp"` in the
  capabilities.
- **An option for others.** "ACP on herdr-core", with a small keeper process in the terminal, is
  for an orchestrator that wants to drive an agent as data itself (plan 13).

Still blocked: the calling agent becoming the ACP client itself through Ovis and taking the child's
approvals ("option 1"). Ovis's tool never offers that. An agent with a shell can still run
`<agent> acp` on its own, as it can run `hc run`; nothing here stops that, and Ovis does not see it.

What ACP drive costs (plan 10.3): the child has no TUI to step into; menus, sign-in screens and other
TUI-only features are out of reach; and as the Ovis server's child, the process ends when the server
restarts (D16 above).

## Schema draft

Per D21 (a), the source of truth would be one JSON Schema file, `shared/harness-contract.schema.json`
**(proposal)**, from which `bun run generate:types` writes `shared/harness-contract.generated.ts`,
the way it already writes `server/herdr-core/hc-api.generated.ts` from `scripts/hc-schema.json`
(read, `scripts/generate-protocol-types.ts`). Two generator rules carry over: an enum becomes a
union widened with `(string & {})`, so a value from a newer side still flows; and a caller that meets
a value it does not know falls back to the terminal level instead of failing (plan 11.4).

The draft is written below as TypeScript for reading.

```ts
// Every --json line and every MCP tool answer is one of these, one JSON object per line.
type Envelope<K extends string, B> = { contract: "ovis-harness/0"; kind: K } & B;

// ---- identity --------------------------------------------------------------
interface Machine {
  id: string;                 // stable id; names may repeat
  name: string;
  reach: "local" | "hc-ssh" | "hc-via" | "relay";   // "relay" only after H6
  online: boolean;
  versions: { ovis?: string; hc?: string; herdr?: string };
}

interface Harness {
  kind: string;               // catalog kind: "claude", "codex", "opencode", ...
  version: string | null;
  installed: boolean;
  signed_in: boolean | null;  // null: the harness gives no way to tell
  capabilities: Capabilities;
}

interface SessionRef {
  address: string;            // terminal address "machine/t7", or for an ACP child Ovis's own
                              // "machine/acp:<id>" (proposal)
  drive: "terminal" | "acp";  // how this child is driven
  machine: string;            // Machine.id
  harness: string;            // Harness.kind
  agent_session_id: string | null;  // only when a reader proved it, never guessed by folder or time
  parent: string | null;      // address of the terminal that started it
  started_by: "human" | "agent";
}

// ---- capabilities: read flags, never harness names (rule 4 of plan 11.1) ----
interface Capabilities {
  level: "terminal" | "structured";             // what this harness gets here, now
  drive: ("terminal" | "acp")[];                // "acp": Ovis can be its ACP client on this machine,
                                                // directly or through an adapter the user installed
  acp_protocol: 1 | 2 | null;                   // the version it answered `initialize` with
  transcript: "none" | "file" | "acp";
  approvals: ("keys" | "hook" | "acp")[];       // every path that answers some approval
  turn_end: "strong" | "weak" | "none";          // how far "the turn ended" can be trusted
  turn_end_from: ("hook" | "reader" | "terminal")[];
  model_switch: "none" | "launch" | "session";
  resume: boolean;
  images: boolean;
  slash_commands: boolean;
  subagents: boolean;
  tool_delivery: ("mcp" | "shell")[];           // how the harness and browser tools reach it
  browser_tool: boolean;
  memory_tool: boolean;                         // false until U2
}

// ---- state, turns and results ---------------------------------------------
type SessionState =
  | { state: "idle" | "working" | "done" | "gone"; turn: number | null }
  | { state: "waiting_human"; turn: number | null; on: "approval" | "question" };
  // A parent learns only that the child waits for a person, never the card itself (G8).

interface SendAccepted {           // `send` answers "received", never the result (rule 1)
  accepted: true;
  turn_id: string;
  key: string | null;              // the caller's key; the same key again types nothing (rule 2, G7)
  duplicate: boolean;              // true when this key was already sent
}

interface TurnResult {
  turn_id: string;
  stop_reason: "end_turn" | "cancelled" | "refusal" | "max_tokens" | "max_turn_requests"
             | "gone" | "unknown";           // ACP's reasons, plus Ovis's own two
  evidence: "acp" | "hook" | "reader" | "terminal";  // where the end and the answer came from
  final_message: Untrusted | null;
}

interface Untrusted {               // G11: another agent's words are data, never instructions
  untrusted: true;
  from: string;                     // SessionRef.address
  text: string;
}

interface TranscriptPage {
  items: SessionUpdate[];
  next: string | null;              // cursor; resume with (session, turn, cursor) after a drop
}

type SessionUpdate =                // ACP's names
  | { type: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"; text: Untrusted }
  | { type: "tool_call" | "tool_call_update"; id: string; title: string; status: "pending" | "in_progress" | "completed" | "failed" }
  | { type: "plan"; entries: { content: string; status: string }[] }
  | { type: "native"; harness: string; value: unknown };   // passed through, meaning not promised

interface Screen { cols: number; rows: number; text: Untrusted }

// ---- safety ---------------------------------------------------------------
type Scope = "view" | "start" | "send" | "start_elsewhere";   // never "approve" (D19)

interface Grant {                    // what the user turned on, and where
  scope: Scope;
  where: { session: string } | { project: string } | { machine: string };
}

interface Limits {                   // D23 defaults (proposal)
  depth: 1;                          // settable 1..3
  children: 4;                       // running at once, per parent
  child_minutes: 60;
  child_turns: number | null;        // used where the harness reports no cost
  calls_per_minute: 30;
}

interface AuditRecord {              // G6: one per start, send and stop
  at: string;                        // ISO time
  run: string;                       // the calling run's id (its token names it)
  parent: string;                    // SessionRef.address
  child: string;
  machine: string;
  harness: string;
  verb: "start" | "send" | "stop";
  turn_id: string | null;
  stop_reason: TurnResult["stop_reason"] | null;
}

interface Refusal {
  error: {
    code: "tools_off" | "not_granted" | "approval_required" | "approval_denied"
        | "depth_exceeded" | "children_limit" | "time_limit" | "rate_limited"
        | "ancestor_target" | "self_target" | "not_owner" | "taken_over"
        | "unknown_session" | "unknown_contract";
    message: string;
  };
}
```

The four rules the schema serves (plan 11.1; Ovis and hc already keep them):

1. `send` answers "received" and a turn id. A result changes only on evidence tied to that turn
   (read, [the third contract](agent-commands.md#the-three-contracts)).
2. When unsure, read before sending again. `send` takes the caller's key so a retry cannot type twice.
3. Attaching never takes over. A send waits while a person types; `--takeover` stays a person's act.
4. Capabilities say what is true. A flag that is on and then fails is a bug.

**Fallback when ACP is missing.** `start` uses ACP only when the harness's `drive` includes `acp`.
Otherwise the child is a real TUI in a herdr-core terminal and is driven as one:

- `send` goes through the terminal input path.
- `wait` and `result` come from the hook, the reader or hc's turn count.
- `TurnResult.evidence` names which of them answered.

The calling agent uses the same verbs either way and reads `drive` on the `SessionRef`. The same
fallback applies when the ACP start fails, for example a missing adapter or an `initialize` with no
answer.

## Three harnesses

Claude Code and Codex because they are the two largest readers (plan 8.22); OpenCode as the third
because it speaks ACP directly and takes no MCP server on its command line, so it shows the two
paths the other two do not. The plan offered agy or OpenCode for the third.

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Transcript (`transcript`) | `file`: `claude-transcript` (read, `server/claude-transcript.ts`, `server/claude-store.ts`) | `file`: `codex-transcript` (read, `server/codex.ts`) | `file`: `opencode-transcript` (read, `server/opencode.ts`); `acp` also possible after M13 (plan 10.1: `opencode acp`, v1, loadSession, list) |
| Approvals (`approvals`) | `keys` for every dialog (`server/dialogs/`); `hook` for Bash requests through the PermissionRequest hook, not on Windows (read, `server/claude-permission-hook.ts`) | `keys` (read, `server/dialogs/`) | `keys`; a pending OpenCode v2 form is answered natively (read, `docs/agent-commands.md`, `server/opencode-native.ts`) |
| Turn end (`turn_end`, `turn_end_from`) | `strong` once the `Stop` hook is in (plan 12.4, H5); today `weak`, from the reader and hc's turn count | `weak`: reader and hc's turn count. Codex documents a `Stop` hook (plan 13.4, unverified in use) | `strong` for a v2 pane: its own service's turn-completion events (read, `server/opencode-native.ts`); `weak` otherwise |
| Tools at launch (`tool_delivery`) | `mcp` (`--mcp-config <file>`) and `shell` | `mcp` (`-c mcp_servers.…`) and `shell` | `shell` only: its `mcp` commands write its own settings, which Ovis does not touch (read, `shared/browser-tools.ts`) |
| Browser tool (`browser_tool`) | yes | yes | no (same reason) |
| Drive (`drive`) | `acp` only through the `claude-agent-acp` adapter, which the user installs (plan 10.1); else `terminal` | `acp` only through the `codex-acp` adapter, which the user installs (plan 10.1); else `terminal` | `acp` direct, `opencode acp`, which answered `initialize` with protocol 1 on this PC (plan 10.1); `terminal` too |
| Resume (`resume`) | yes, `POST /api/sessions/resume`, bound to the pane's store (read, `server/session-history-routes.ts`) | unverified for this draft | unverified for this draft |
| Model switch, images, slash commands, subagents | Not filled in. H4 gathers them per harness; until then they report the safe value (`none` / `false`). | same | same |
| Level when the reader fails | `terminal`: `screen` and `send` keep working | same | same |

The two harnesses the goal names first:

| | Gemini CLI | agy (Antigravity) |
|---|---|---|
| In Ovis today | A display name only (read, `server/agents-routes.ts`); no catalog entry, no transcript reader. Not installed on this PC. | Catalog entry (read, `shared/agent-catalog.ts`); transcript reader `agy-transcript` (read, `server/agy.ts`); installed on this PC. |
| ACP | Speaks ACP directly according to its docs (plan 10.1). The plan read the flag as `gemini --acp`; the exact flag name is **(unverified)**, not run here. | **(unverified)**. Only others' lists say it attaches over ACP (`agy acp` on the ACP site's client list; T3 Code's docs); nobody has run it. |
| Drive until checked | `terminal` (`drive: ["terminal"]`) until the flag answers `initialize` | `terminal`, with its reader for results, until `agy acp` answers `initialize` |

## Commands and the code they use

Two faces (plan 11.3). People and scripts get read-only commands (H1). Agents Ovis starts get
`ovis agent` and MCP tools of the same names (H2, H3). Both answer with the schema above. The first
build is thin: each command calls a route this PC's Ovis server already has. Today `ovis` has 11
subcommands (read, `scripts/plugin.ts`: start, stop, status, pair, link, logout, recover, confirm,
phone, phone-setup, tui); these join them.

| Command | Answers | Existing path | New work |
|---|---|---|---|
| `ovis machines` | `Machine[]` | `GET /api/machines` (`server/machine-api.ts`, `server/machines.ts`); hc `machine.list` | Map each PC's way in to `reach` |
| `ovis harnesses [--on m]` | `Harness[]` | `GET /api/agent-catalog` (`server/agent-catalog-routes.ts`, `shared/agent-catalog.ts`), `GET /api/agents` (`server/agents-routes.ts`); another PC through the `/api/machines/<id>/` proxy (`server/dispatch.ts`) | `capabilities`, built today from scattered facts: `BROWSER_TOOL_AGENTS` (`shared/browser-tools.ts`), which `source` a reader yields (`shared/protocol.ts`), the hook (`server/claude-permission-hook.ts`) |
| `ovis ls [--on m]` | `SessionRef[]` with `SessionState` | `GET /api/session`, whose herdr-core snapshot carries `parent_pane_id` and the turn count (`server/herdr-core/snapshot.ts`, `shared/agent-roster.ts`); `GET /api/pane/summary` (`server/pane-routes.ts`) | `started_by` |
| `ovis read <s> --state` | `SessionState` | the snapshot's agent status; `GET /api/pane/prompt` for a waiting approval or question (`server/prompt.ts`) | Collapse to the five states |
| `ovis read <s> --transcript` | `TranscriptPage` | `GET /api/pane/conversation` (`server/pane-routes.ts` → `server/conversation.ts`) | Map Ovis turns to ACP update kinds; mark text `Untrusted` |
| `ovis read <s> --result` | `TurnResult` | the conversation's last turn | Bind it to a `turn_id`; take the end from the hook where there is one |
| `ovis read <s> --screen` | `Screen` | `GET /api/pane/read` (`server/pane-routes.ts`) | none |
| `ovis agent machines` / `harnesses` / `ls` / `read` | as above | as above | Run token checks (G2) |
| `ovis agent start --harness h [--on m] [--cwd d] ["task"]` | `SessionRef` | this PC: `POST /api/tab/create` or `/api/workspace/create` with `agent` (`server/workspace-routes.ts` → `agentLaunch` in `server/agent-launch.ts`), first message checked by `firstMessageFault` (`shared/launch-rules.ts`); another machine: hc `terminal.run` with `on` (`server/herdr-core/machine-scope.ts`) | Terminal drive: pass hc's `parent` (Ovis reads it today but never sets it), with `labels` for the run. ACP drive on this PC, which has no code in Ovis today: start `<agent> acp` (or the user's adapter) as the server's child, then `initialize` with no `fs`/`terminal` client capabilities, then `session/new`. Both drives: G2 to G5 and G10 checks, and an approval card for `--on` (G3). |
| `ovis agent send <s> "task" [--key k]` | `SendAccepted` | `POST /api/pane/input` (`server/pane-routes.ts`; keeps the Claude rewind-dialog refusal); hc `terminal.send` takes `caller` and waits for a person (plan 11.1) | `turn_id` and the caller key (the one route the plan says must be new); G7 and G9 checks. ACP drive: `session/prompt`, sent once per key |
| `ovis agent wait <s> [--turn id]` | `SessionState` once the turn ends or waits on a person | the snapshot's turn count and status, the conversation reader, the hook (`server/claude-permission-hook.ts` for approvals) | A wait that resumes by (session, turn id, cursor) after a drop. ACP drive: the `session/prompt` response, with `waiting_human` while a permission card is open |
| `ovis agent result <s> [--turn id]` | `TurnResult` | as `ovis read --result` | as above. ACP drive: the stop reason and the turn's `agent_message_chunk`s, converted in the one place plan A1 names (today that code sits inside `server/grok.ts`, which reads Grok's `session/update` file) |
| `ovis agent ask --harness h [--cwd d] "task" [--key k]` | `TurnResult` | none: it is `start`, `send`, `wait` and `result` above in one call | The one tool the goal names **(proposal)**. One harness, one task, one answer; no retry, queue or fan-out (it is not orchestration). It leaves the child running for a follow-up `send` until `stop` or the G5 time limit. |
| `ovis agent stop <s>` | `{ stopped: true }` | `POST /api/pane/close` (`server/pane-routes.ts`) | Refuse any session this run did not start (`not_owner`). ACP drive: `session/cancel` for a running turn, then `session/close` and end the process |
| *(no verb)* approve | Only a person, in Ovis's screens | `POST /api/pane/prompt/answer` (`server/prompt.ts`); the Claude hook card | none; the tool never gets it (G8). ACP drive: Ovis answers `session/request_permission` with the `optionId` the person picked on the card, which needs an ACP source for the card (plan A5) |
| *(no verb)* `exec`, `file` | hc's own commands | `hc exec --on`, `hc file … --on` | none; Ovis does not reopen them (plan 11.4) |

Removed in revision 2 and not coming back in this contract: `ovis run`, `turn`, `wait`, `events`,
`approve`, `cancel` and `stop` as human commands (they read as Ovis handing out work), and a TS SDK
face (orchestrators wrap the command or the MCP tool themselves).

### Where wait and result come from

- **ACP drive:** the `session/prompt` response ends the turn with its stop reason (`evidence: "acp"`).
  The answer is the turn's `agent_message_chunk`s. Both are data, with no screen reading.
- **Terminal drive:** "hook plus reader" (plan 12.4). The hook says early that the turn ended and
  the reader takes out the answer. A harness with neither falls back to the terminal level, hc's
  status and turn count, and `turn_end` says so.

### How the tool reaches an agent

- MCP: at launch, for harnesses that take a server on the command line (Claude, Codex, Copilot), the
  way the browser tool is added (read, `withBrowserTool` in `server/agent-launch.ts`). Ovis never
  writes an agent's own settings.
- Shell: `ovis agent` for any agent with a shell. Its run token must be in the terminal's environment.
  herdr's `agent.start` takes no environment (plan 12.2), so the first version is herdr-core terminals
  only.

## Safety rules G1–G12

These apply only to calls made through Ovis's tool. A shell agent can call `hc run --on` itself and
bypass limits and approval; it stays visible, but nothing here stops it. Whether hc can enforce
anything is unverified (plan 12.3, 8.25). The run token tells runs apart; it does not stop another
program of the same OS account (as R20).

| # | Rule | Default (D23) | Enforced at | Proof (G12) |
|---|---|---|---|---|
| G1 Visible | Every agent an agent starts shows under its parent in the sidebar. A terminal child is a real TUI in a herdr-core terminal that a person can step into and take over at any time. An ACP child is drawn as a chat in Ovis's view, and a person can cancel it at any time. | always | Terminal: `start` sets hc `parent`; the sidebar already nests by `parent_pane_id` (read, `shared/agent-roster.ts`, `src/components/AgentSidebar.tsx`). Across machines the parent is not found today (same machine only): H3. ACP: a new sidebar row under the parent, with Ovis's own address. | A started child of either drive appears under its parent; one started on another machine shows its parent. |
| G2 View by default | An agent caller may only view (list, state, transcript). Start and send are turned on by the user per session, project or machine (`Grant`). | view only | Run token → grants check before every verb. Agent callers are a new kind of principal: neither `drive` nor `watch` (read, `shared/access.ts`). | Without a grant, `start` and `send` are refused `not_granted`. |
| G3 Other machine | Starting on another machine goes through a person's approval card showing who, which machine, which harness and what task. "Always allow" binds to one parent and one machine. | card each time | `start --on`; the card reuses the approval card surface. Touches authentication: owner check and a real review. | Zero starts elsewhere without an approval. |
| G4 Depth | A child cannot start agents. | 1, settable to 3 | Depth carried in the run token; a child gets view-only tools. | Past the depth, `depth_exceeded`. |
| G5 Limits | At most 4 running children per parent; 60 minutes per child; cost counted only where reported, else time and turns. Past a limit no new work is taken and a person is told; a running child is never killed. | 4, 60 min | `start` and `send`. | Past the limit, `children_limit` or `time_limit`, and the running child still runs. |
| G6 Record | Each parent → child act is recorded: who, machine, harness, when, turn id, stop reason. What was sent is in the session's own transcript and is not copied. | always | `AuditRecord` on every start, send and stop; a screen for it in H3. | Every start, send and stop leaves exactly one record. |
| G7 No loops | Sending to an ancestor or to oneself is refused. The same key types once. Calls per minute are limited. | 30/min per run (proposal) | `send`, using the `parent` chain and the key store. | `ancestor_target`, `self_target`, a repeated key gives `duplicate: true` and types nothing, a burst gets `rate_limited`. |
| G8 Only people approve | The tool has no approval verb. A child's approval request goes to a person as a card; the parent only sees `waiting_human`. For an ACP child, Ovis is the only ACP client: each `session/request_permission` becomes a card with the agent's options unchanged, and the calling agent never holds the connection or sees the request. Ovis adds no approval of its own, so a child that requests nothing ends with no card. | always | Schema: no approve scope. The ACP client lives in the Ovis server and its connection is never handed out. | No verb exists, and the parent's view of a waiting child holds no card content. With a fake ACP agent: a permission request shows a card, the turn waits until a person answers, and the parent's tool has no way to answer it. A turn with no request ends with no card. |
| G9 People win | A send waits while a person types in that terminal; once a person takes over, the parent's sends are refused. For an ACP child, a person's cancel or card answer wins over the parent; after a person cancels a turn, the parent's next send is refused until a person resumes the child. | always | The existing send path and attach claims (`server/input-guard.ts`, hc `terminal.send`); for ACP, the server's client. | A send during typing waits; after take-over, `taken_over`; after a person cancels an ACP turn, `taken_over`. |
| G10 Off switch | One switch turns the whole tool off and revokes every agent caller's token at once. Off by default. | off | Settings, checked before every verb. | With the switch off, every verb is `tools_off` and old tokens fail. |
| G11 Untrusted text | `read` and `result` mark another agent's words as data so they do not read as instructions. | always | `Untrusted` wrapper in the schema; the skill text says how to treat it. | Every text field from another session is `Untrusted`. |
| G12 Tests | Removing any one guard turns a test red. Each state change has a test: off then on, parent ends first, child on another machine, late answer, and for ACP children the server restarting mid-turn (`gone`) and an adapter that never answers `initialize` (falls back to terminal drive). | n/a | the H2 and H3 test suites, in an isolated session (`mkdtempSync` state, `port: 0`). | Guard-removal run per guard. |

H2's exit tests come from these: "view only unless turned on", "refused past the depth", "the same
key types once", "waits while a person types", and for ACP drive "a permission request reaches only
the card" and "a read-only ask ends with no card". H3 adds "zero starts elsewhere without approval" and
"no new work past a limit". H2 and H3 change an HTTP contract and touch authentication, so both need
the owner's word and a real review (plan 4.7).
