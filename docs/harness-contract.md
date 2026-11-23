# Harness contract (draft, H0)

The contract for Ovis's harness layer: what it says about machines, harnesses and sessions, the
harness tool Ovis hands to agents it starts, and the safety rules around both. It is a draft for the
owner to decide on. No code implements it yet.

- Source: the direction plan `ovis-direction-1123` (`PLAN.ko.md`, revision 2), chapters 11 and 12
  and step H0 of 4.7. ACP background is in its chapters 10 and 13.
- Code cited at `origin/main` 9deae046d (2026-11-23).
- Marks: **(read)** seen in the code or docs at that commit, **(plan)** taken from the plan,
  **(proposal)** this draft's own suggestion, **(unverified)** nobody has checked it.
- Not in this draft: the M15 result table that H0's exit asks for. M15 is a measurement (does the
  Ovis path report turn end, the turn's last answer and a pending approval better than `hc wait` and
  `hc read`?). It has not run. If it fails, the harness tool keeps only the view and safety verbs and
  leaves send, wait and result to hc (plan, M15).

## Decisions for the owner

H0 is done when these four are decided. Everything below is written for the recommended answer;
another answer changes the parts named in the last column.

| # | Question | Options | Recommendation | What it changes here |
|---|---|---|---|---|
| D18 | Does Ovis own a common harness-layer interface? | (a) No: human screens and hc only. (b) This contract in writing (H0), then read-only commands for people (H1). (c) Also the harness tool handed to agents (H2, H3). | (b) now. (c) only after D19 and D23. In every case Ovis never decides or hands out work (D22). | (a) drops this document. (b) builds only [the human commands](#commands-and-the-code-they-use). (c) adds the `ovis agent` rows and [the safety rules](#safety-rules-g1g12). |
| D19 | What may an agent do through the harness tool? | (a) View only: list, state, transcript. (b) + start and send on this PC, where the user turned it on. (c) + start on another machine. (d) + answer approvals. | (a) by default, (b) when turned on. (c) goes through a human approval card every time. (d) never: only a person approves. Machine commands (`exec`, `file`) stay hc's and Ovis does not open them. | Sets the `scope` values in [the schema](#schema-draft) and rules G2, G3 and G8. |
| D21 | What shape is the contract? | (a) One schema that generates the types, with the commands' `--json` output as the stable surface. (b) TypeScript types only. | (a). It survives a Rust port of the inside unchanged (plan 11.3). | (b) drops the schema file and the generated types; the tables still apply. |
| D23 | Default limits of the harness tool | Depth (may a child start children?), children per parent, time and cost per child. | Depth 1 (settable up to 3), 4 running children per parent, 60 minutes per child. Cost counted only where the harness reports it, else time and turn count. This draft adds 30 calls per minute per run for G7, which the plan leaves without a number **(proposal)**. | The `Limits` defaults and rules G4, G5 and G7. |

Related but not needed for H0: D20 (how another machine is reached: hc machines first, a PC-to-PC
path over the Ovis relay later as H6) and D9 (how far hooks go; the turn-end hook in G-rules and
[results](#where-wait-and-result-come-from) assumes D9 reaches (c)).

## What Ovis is in this contract

Ovis does not orchestrate (D22, received 2026-11-23). What to do and who does it is decided by an
orchestrator (dori, omo, a skill) or by the agent itself. Ovis has three roles (plan 12.1):

1. **The window people look through.** Every agent, including agents started by agents, is a real
   TUI in a herdr-core terminal. People see it, answer its approvals and step into its terminal.
2. **The place agents get tools.** Ovis puts tools into an agent when it starts it (today the browser
   tool; next the harness tool and the memory tool).
3. **The safety rails.** Limits, human approval and a record for every agent an agent starts.

The harness tool therefore offers one start, one send and one result at a time, done safely. It has
no queue, schedule, automatic retry, fan-out, "look at the result and decide the next step", no
approval verb and no machine commands (plan 12.2). If any of these comes in, Ovis has become an
orchestrator.

**Where ACP stands.** ACP is a secondary channel, not Ovis's path and not something to dismiss
(plan 10, 13; this replaces the earlier "ACP is not Ovis's path"). In this contract it is three
things:

- The vocabulary. Sessions, turns, `session/update` kinds, permission option kinds and stop reasons
  use ACP's names, whatever the transport.
- A read channel. An agent Ovis has no transcript reader for can be read with `session/list` and
  `session/load` once M13 shows that is safe (A2, D14). That surfaces as `transcript: "acp"` in the
  capabilities.
- An option for others. "ACP on herdr-core", with a small keeper process in the terminal, is for an
  orchestrator that wants to drive an agent as data (plan 13). The harness tool itself never drives
  a child over ACP: the one ACP client would be the parent, and the child's approvals would go to it
  instead of to a person (plan 12.4, against G8).

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
  address: string;            // terminal address, "machine/t7"
  machine: string;            // Machine.id
  harness: string;            // Harness.kind
  agent_session_id: string | null;  // only when a reader proved it, never guessed by folder or time
  parent: string | null;      // address of the terminal that started it
  started_by: "human" | "agent";
}

// ---- capabilities: read flags, never harness names (rule 4 of plan 11.1) ----
interface Capabilities {
  level: "terminal" | "structured";             // what this harness gets here, now
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
  evidence: "hook" | "reader" | "terminal";  // where the end and the answer came from
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
| ACP | through the `claude-agent-acp` adapter only (plan 10.1) | through the `codex-acp` adapter only (plan 10.1) | direct, `opencode acp` (plan 10.1, run on this PC) |
| Resume (`resume`) | yes, `POST /api/sessions/resume`, bound to the pane's store (read, `server/session-history-routes.ts`) | unverified for this draft | unverified for this draft |
| Model switch, images, slash commands, subagents | Not filled in. H4 gathers them per harness; until then they report the safe value (`none` / `false`). | same | same |
| Level when the reader fails | `terminal`: `screen` and `send` keep working | same | same |

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
| `ovis agent start --harness h [--on m] [--cwd d] ["task"]` | `SessionRef` | this PC: `POST /api/tab/create` or `/api/workspace/create` with `agent` (`server/workspace-routes.ts` → `agentLaunch` in `server/agent-launch.ts`), first message checked by `firstMessageFault` (`shared/launch-rules.ts`); another machine: hc `terminal.run` with `on` (`server/herdr-core/machine-scope.ts`) | Pass hc's `parent` (Ovis reads it today but never sets it); `labels` for the run; G2 to G5 and G10 checks; approval card for `--on` (G3) |
| `ovis agent send <s> "task" [--key k]` | `SendAccepted` | `POST /api/pane/input` (`server/pane-routes.ts`; keeps the Claude rewind-dialog refusal); hc `terminal.send` takes `caller` and waits for a person (plan 11.1) | `turn_id` and the caller key (the one route the plan says must be new); G7 and G9 checks |
| `ovis agent wait <s> [--turn id]` | `SessionState` once the turn ends or waits on a person | the snapshot's turn count and status, the conversation reader, the hook (`server/claude-permission-hook.ts` for approvals) | A wait that resumes by (session, turn id, cursor) after a drop |
| `ovis agent result <s> [--turn id]` | `TurnResult` | as `ovis read --result` | as above |
| `ovis agent stop <s>` | `{ stopped: true }` | `POST /api/pane/close` (`server/pane-routes.ts`) | Refuse any session this run did not start (`not_owner`) |
| *(no verb)* approve | Only a person, in Ovis's screens | `POST /api/pane/prompt/answer` (`server/prompt.ts`); the Claude hook card | none; the tool never gets it (G8) |
| *(no verb)* `exec`, `file` | hc's own commands | `hc exec --on`, `hc file … --on` | none; Ovis does not reopen them (plan 11.4) |

Removed in revision 2 and not coming back in this contract: `ovis run`, `turn`, `wait`, `events`,
`approve`, `cancel` and `stop` as human commands (they read as Ovis handing out work), and a TS SDK
face (orchestrators wrap the command or the MCP tool themselves).

### Where wait and result come from

"Hook plus reader" (plan 12.4): the hook says early that the turn ended, the reader takes out the
answer. A harness with neither falls back to the terminal level, hc's status and turn count, and
`turn_end` says so. ACP's stop reason is used only where someone drives the agent over ACP, which
the harness tool does not.

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
| G1 Visible | An agent an agent starts is a real TUI in a herdr-core terminal, shown under its parent in the sidebar; a person can step in and take over at any time. | always | `start` sets hc `parent`; the sidebar already nests by `parent_pane_id` (read, `shared/agent-roster.ts`, `src/components/AgentSidebar.tsx`). Across machines the parent is not found today (same machine only): H3. | A started child appears under its parent; one started on another machine shows its parent. |
| G2 View by default | An agent caller may only view (list, state, transcript). Start and send are turned on by the user per session, project or machine (`Grant`). | view only | Run token → grants check before every verb. Agent callers are a new kind of principal: neither `drive` nor `watch` (read, `shared/access.ts`). | Without a grant, `start` and `send` are refused `not_granted`. |
| G3 Other machine | Starting on another machine goes through a person's approval card showing who, which machine, which harness and what task. "Always allow" binds to one parent and one machine. | card each time | `start --on`; the card reuses the approval card surface. Touches authentication: owner check and a real review. | Zero starts elsewhere without an approval. |
| G4 Depth | A child cannot start agents. | 1, settable to 3 | Depth carried in the run token; a child gets view-only tools. | Past the depth, `depth_exceeded`. |
| G5 Limits | At most 4 running children per parent; 60 minutes per child; cost counted only where reported, else time and turns. Past a limit no new work is taken and a person is told; a running child is never killed. | 4, 60 min | `start` and `send`. | Past the limit, `children_limit` or `time_limit`, and the running child still runs. |
| G6 Record | Each parent → child act is recorded: who, machine, harness, when, turn id, stop reason. What was sent is in the session's own transcript and is not copied. | always | `AuditRecord` on every start, send and stop; a screen for it in H3. | Every start, send and stop leaves exactly one record. |
| G7 No loops | Sending to an ancestor or to oneself is refused. The same key types once. Calls per minute are limited. | 30/min per run (proposal) | `send`, using the `parent` chain and the key store. | `ancestor_target`, `self_target`, a repeated key gives `duplicate: true` and types nothing, a burst gets `rate_limited`. |
| G8 Only people approve | The tool has no approval verb. A child's approval request goes to a person as a card; the parent only sees `waiting_human`. | always | Schema: no approve scope. | No verb exists; the parent's view of a waiting child holds no card content. |
| G9 People win | A send waits while a person types in that terminal; once a person takes over, the parent's sends are refused. | always | The existing send path and attach claims (`server/input-guard.ts`, hc `terminal.send`). | A send during typing waits; after take-over, `taken_over`. |
| G10 Off switch | One switch turns the whole tool off and revokes every agent caller's token at once. Off by default. | off | Settings, checked before every verb. | With the switch off, every verb is `tools_off` and old tokens fail. |
| G11 Untrusted text | `read` and `result` mark another agent's words as data so they do not read as instructions. | always | `Untrusted` wrapper in the schema; the skill text says how to treat it. | Every text field from another session is `Untrusted`. |
| G12 Tests | Removing any one guard turns a test red. Each state change has a test: off then on, parent ends first, child on another machine, late answer. | n/a | the H2 and H3 test suites, in an isolated session (`mkdtempSync` state, `port: 0`). | Guard-removal run per guard. |

H2's exit tests come from these: "view only unless turned on", "refused past the depth", "the same
key types once", "waits while a person types". H3 adds "zero starts elsewhere without approval" and
"no new work past a limit". H2 and H3 change an HTTP contract and touch authentication, so both need
the owner's word and a real review (plan 4.7).
