# Fork boundaries

This fork is `ricardofelixb/ovis`; upstream is `devswha/ovis`. This inventory compares the starting commit `da5afc54` with its upstream merge base, `2decd453d6a28eb6cf21647c6f928150d1196c5c`. It includes inherited fork changes, not just this refactor.

## Grouped sub-agent tabs

Upstream candidate (A), behind **Agent friends** (off by default). `src/fork/tabs/groupAgentTabs.ts`
folds same-workspace descendants into their visible parent without changing real tabs or order;
missing parents/cycles remain ordinary tabs. `src/fork/tabs/TabChips.tsx` and `src/fork/tabs/tab-chips.css`
provide tiny sub-agent controls (one Bot icon for every role, a neutral Terminal when the role is unknown), without a repeated
friend. Their named controls select the real child pane, keep its menu/rename/close, and highlight
selection; touch hold opens its menu. Chips stay pinned in their parent group. The desktop row,
phone header row and phone tabs sheet all share these controls; selecting a child leaves the
parent highlighted while the existing header/pane title continues to name the selected child.
Overflow chips retain menuitem semantics for the existing arrow-key navigation; sheet chips remain
ordinary buttons. Their mouse press preserves the menu on browsers that do not focus clicked buttons.
`src/components/TabStrip.tsx` hooks the grouping, chip mount and presentation-only selected/root
mapping; original tabs still drive commands. Its scroll-to-selection hook uses `forkOpenTab` in
`src/fork/tabs/TabChips.tsx` to measure the selected child chip rather than its parent, falling back to
the upstream active tab when no child is selected. `src/components/RowMenu.tsx` adds a generic optional
`trailing` sibling-control slot (one type field and two render sites), needed for attached chips
in a sheet without invalid nested buttons. TabStrip's missing grouped-tab presentation extension
point is an upstream PR candidate. This differs from Warp's collapsible tab groups: job roles stay
reachable on the parent, per the requested lower-noise design; no code or pixels were copied.
`src/fork/tabs/tabGroupLayout.ts` budgets attached chip widths in the desktop More overflow, delegating
to upstream's existing calculation unchanged with no groups. Phone chips keep 44px touch targets. Fork-only role metadata lives
in `shared/fork/pane.ts` and `server/fork/core-terminals.ts`: only hc labels `role=implement`,
`review` or `explore` become optional `agent_role`; herdr and old bridges omit it.
Upstream hooks: `server/herdr-core/snapshot.ts` adds `forkPaneFields` to the existing fork import
and one spread in `paneOf`; `shared/protocol.ts` adds one type import and one intersection.
`server/fork/fork-pane-role.test.ts` failed before implementation, then passed with both app-owned
and Ovis-owned layouts. No generated file or setting default changed.

Hook footprint (insertions/deletions vs `upstream/main`, merge base, measured with
`git diff --shortstat upstream/main...<ref> -- <file>`; before is `491a5965`):

| Upstream file | Before | After | Hooks added here |
| --- | --- | --- | --- |
| `src/components/TabStrip.tsx` | +23/-8 | +52/-27 | 3 imports; grouping/layout calls, selection guards, 2 chip mounts; independent child picker |
| `src/components/RowMenu.tsx` | +10/-3 | +19/-8 | optional trailing slot, 2 generic sibling render sites |
| `src/lib/useTabReorder.ts` | +1/-2 | +12/-6 | optional adjacent/drop-boundary callbacks, original geometry fallback preserved |
| `shared/protocol.ts` | +15/-1 | +17/-2 | type import + intersection |
| `server/herdr-core/snapshot.ts` | +3/-1 | +4/-1 | existing fork import extended + pane spread |
| `scripts/ci-browser.sh` | +5/-2 | +6/-2 | one fork regression registration, shared by serial/parallel browser lanes |

Regression coverage: `src/fork/tabs/groupAgentTabs.test.ts`,
`src/fork/tabs/TabChips.test.tsx`, `src/fork/tabs/tabGroupLayout.test.ts`,
`server/fork/fork-pane-role.test.ts` and the added opt-in TabStrip integration cases.
`scripts/fork-grouped-tabs-demo-regression.ts` uses synthetic demo-only parents and hc roles to
exercise desktop/phone grouping, child selection/title, rename, phone sheet, touch targets,
large sibling groups and the setting disabled. No real session or user state is used.
`src/lib/useTabReorder.ts` needs generic optional boundary callbacks (another upstream
extension-point candidate): the fork maps parent moves to the next visible root in native index
coordinates. Without this, Move right/left can silently step across folded children without moving
the parent on screen. Children stay pinned to their parent but can reorder among direct siblings by
menu, Alt+Shift+Arrow keys, or mouse drag. Fork-only sibling/drop boundaries reject other groups and
cross-generation drops. The generic drop-boundary callback shares upstream's fixed-layout, in-flight and
acknowledgement guards; root-tab geometry remains upstream. Chips use the same pointer-drag
controller as normal tabs, so dragging outside the strip still offers a split and opens the child
beside the current pane. Returning to the strip clears the split target; Escape, pointer cancellation
and lost capture cancel it. The separate HTML drag implementation and unused `moveTo` handle are gone.
Touch keeps scrolling and long-press menus.
Child pickers opt out of the selected-tab ellipsis lifecycle, so long presses and keyboard menus
on inactive chips stay open without selecting them; the existing missing-tab cleanup still applies.
A chip opened from More or the phone sheet resolves upstream's `rowMenuAnchor` before dismissing
that surface, so the child menu stays attached to the persistent More/header button, not a removed chip.
The demo regression covers an overflowed group's child menu and its Rename action, desktop sibling
shortcuts and drag, and an inactive phone child's long-press menu and sibling move without selection.
It also checks a child drag's split target, return to the strip, Escape and successful split drop;
a TabStrip regression covers split callbacks and click suppression. Both failed before the fix.

Validation: scoped fork/TabStrip/RowMenu/hc tests, conventions and changelog tests passed (276
cases); changed-file TypeScript diagnostics passed for both configs. In `herdr-ci-runner:local`,
`tab-menu-regression`, `tab-overflow-regression`, `mobile-tabs-regression`,
`fork-grouped-tabs-demo-regression`, `fork-tab-alignment-demo-regression`,
`tab-agent-mark-demo-regression`, `phone-glass-header-demo-regression` and
`phone-safe-area-demo-regression` passed. Demo UI artifacts were built for these checks only;
the initial implementer scope skipped project-wide checks. The required pre-push `bun run check fast`
later passed workflow syntax, generated-file freshness, full typecheck and production build, but its
unit lane found 14 OMP failures. `TMPDIR="$HOME/.cache/ovis-tmp/grouped-tabs-pr" bun test server/omp.test.ts`
reproduced the same 14 failures on base `491a5965` (48 passed), chiefly `ConversationUnavailable:
no_session_path`; no OMP code was changed. Its first complete run also caught a missing registration
for the new browser regression. `scripts/ci-browser.sh` now registers it with one line, so the serial
and parallel lanes both run it; the existing browser-lane assignment test caught this before the fix.

## Project friends and inbox clarity

Reusable upstream candidate, behind the existing **Agent friends** opt-in (off on new devices).
`server/fork/friends.ts` now assigns one friend per machine + workspace ID, not per pane. A workspace
ID survives bridge/runtime restarts and renames without following a pane's changing cwd; separate
workspaces intentionally remain separate projects. Descendants resolve their conductor's workspace,
even across workspaces. The browser/alert response stays `{ friends: { [machine:pane]: friend } }`;
avatars and notification callers keep that shape and add no child tint. `src/fork/friends/friends.ts` refreshes
when workspace or parent metadata changes, including non-agent ancestors, even if pane IDs stay the
same. Only its local refresh key carries metadata; the request remains `{ live, machines }`. Sorted
keys avoid requests on unchanged snapshots or mere pane/machine reordering. A monotonic request
generation fences publication after JSON decoding: a late response/body cannot replace a newer
project's picks, and stale errors cannot clear its deduplication key. Deterministic out-of-order fetch
and body regressions cover this. No new upstream hook or change to the hook counts below.

`project-friends.json`, owned by FriendStore, is a new flat workspace-to-friend document beside the
unchanged pane cache `friends.json`. A project's first observed pane/conductor inherits its old pick;
other panes converge on it. Reads alone do not write. Old releases ignore the new file and can rewrite
the pane cache without erasing project picks; a downgrade still reads the original pane-cache shape.
Malformed, unreadable or future-shaped project documents are never overwritten. Project picks remain
when the last agent exits so a new pane after a restart keeps the same friend. Missing snapshot
metadata retains the legacy fallback until the next roster observation. No API request/response shape
or auth/observe guard changes.

`src/fork/inbox/inboxRows.ts` applies the sidebar's existing family ordering after inbox filters/search,
before held ordering: a waiting helper brings its conductor with it, siblings keep their input order, and a
filtered-out conductor leaves a normal row. `forkInboxNesting` then decorates only families contiguous
in the drawn order: held helpers cannot connect to a parent below them or across an unrelated row.
IDs are machine-scoped. Fork CSS draws an indent and connector; pictures keep their normal full color. This follows the existing Ovis sidebar rather than
introducing a competing agent-group interaction.

`src/fork/inbox/InboxBack.tsx` replaces inbox branding with an accessible, fork-translated Back arrow on
wide windows only. Both App's header slot and the inbox's actual desktop rail use the existing exit
action. The classic shell never mounts an arrow; a phone's inbox home mounts neither arrow nor brand.
When Agent friends is off both slots keep their upstream contents. Fork CSS alone hides the classic
sidebar brand (no App hook), removing its flex gap while keeping New workspace and Collapse sidebar.
The footer's Open agent inbox entry and the menu remain reachable.

Hooks added/changed by this task (upstream files only):
- `server/index.ts`: one existing `friendOf` option binds the fork store. Alerts never consult the
  machine manager's possibly absent/stale roster. Fork diff vs `upstream/main` before/after:
  **+12/-5 → +12/-5** (unchanged hook footprint).
- `server/push.ts`: existing friend import/type/lookup hooks plus one fork initializer and one seed
  call. `forkAlertFriends` keeps the collector's pane/workspace/parent metadata, independently per
  machine, before its roster is published. Alerts and the first browser listing agree even with
  the machine manager off. Fork diff **+17/-6 → +19/-6** in the review fix.
- `server/core/status.ts`: existing friend type import and option use the fork lookup type so the
  collector can pass metadata; no new runtime hook. Fork diff **+4/-0 → +4/-0** in the review fix.
- `src/components/InboxList.tsx`: one import, one `forkInboxRows(..., settings.agentFriends)`
  wrapper before the hold, one `forkInboxNesting` call after it, one carried nesting flag and one
  row-class suffix. Fork diff **+2/-1 → +8/-6** (first review **+7/-5**).
- `src/App.tsx`: one import plus one `ForkInboxBack` mount in the existing inbox-only branch, `ForkSidebarFoot` wrapping the sidebar foot's `InboxFootEntry`, and `ForkInboxFoot` wrapping the wide inbox's `InboxRail` (`src/fork/inbox/SidebarFoot.tsx`): the places (workspaces, agent inbox, Pull requests) become icons at the end of the gear's row, and with Settings → Fork → Navigation → Footer, the agent inbox's column drops the rail for that same foot under its list, with the gear, plan meters and the agents that wait (alerts and the PCs menu are left out). That foot is upstream's own, extracted from `MachineSidebar.tsx` into `src/components/SidebarFooter.tsx` (a move, a candidate upstream PR; its row sizes move from `.sidebar-shell` to a shared rule in `Sidebar.css`), so both columns render the same component. `useForkInboxStatusBar` adds the open inbox thread to where `statusBarShown` holds, so under Footer that thread ends in the workspaces view's status bar too (not while Pull requests is up). CSS in `src/fork/github/GithubInbox.css`.
  Fork diff **+43/-62 → +45/-63**.
- Settings → Fork (`src/fork/settings/SettingsRows.tsx` `ForkPage`, `src/fork/settings/page.ts`): every fork switch on one page, grouped Places, Chat, Agents and Look, before About. Upstream hooks: `FORK_PAGE` in `PAGES`, `case "fork"` in `pageNote` and the page switch, the label in `SettingsDialog.tsx`, and the page id plus palette entry in `src/lib/paletteSettings.ts`. Follow Omarchy stays in Appearance.
- Navigation (Settings → Fork → Places): Default (upstream: rail in the inbox with Pull requests and Notes under its inbox button, the sidebar's inbox row replaced by an inbox icon alone at the end of the gear's row), Footer (the old Inbox footer switch, carried over by `withNavigation` in `src/fork/settings/settings.ts`) or Rail. Rail (`src/fork/inbox/Rail.tsx`, `Rail.css`): `ForkWorkspaceRail` draws upstream's `InboxRail` before the workspaces sidebar too (one line in `App.tsx`, which builds the rail once as `inboxRail` for both columns), `ForkRailPlaces` wraps the rail's inbox button (`InboxRail.tsx`) to add Pull requests and Notes, and `ForkInboxBack rail` puts a Workspaces place where the Ovis mark was. A phone draws Rail as Footer (`useNavigation`).
- Mute sub-agents (Settings → Fork, on by default): `shared/fork/alerts.ts` `helperAlertsMuted` mutes a
  pane with a `parent_pane_id` on every channel. Hooks: `server/core/status.ts` (the push `muted` option),
  `server/push.ts` (passes the pane to `muted`), `src/lib/useAlertSignals.ts` (one `paneMuted` for its three checks)
  and `shared/preferences.ts` (`FORK_SHARED_SETTING_KEYS`, so the server reads the setting; unset counts as on).
- `src/components/Markdown.tsx`: one `openPullLink` call in the link click handler (`src/fork/github/pullLinks.ts`): a
  plain click on a github.com pull request link opens its page in the Pull requests view (`GithubInbox.tsx`).
- `src/components/InboxRail.tsx`: one import plus a two-line `ForkInboxBack` wrapper around
  upstream's exit button (its fallback). Fork diff **0 → +3/-0**. Upstream now hides App's header in
  inbox mode, so this additional mount is needed for the requested desktop exit to actually appear.
- `src/lib/agentRoster.ts`: export the already-generic `nestRows` helper (one changed line, no
  behavior change), avoiding a duplicate algorithm in the fork. Fork diff **0 → +1/-1**.
- `server/fork/routes.ts` (fork-owned): supplies cached snapshots, or a local snapshot when the
  machine manager is disabled. No extra upstream route hook.

Scoped nesting checks: `TMPDIR="$HOME/.cache/ovis-tmp/inbox-agent-clarity" bun test
src/fork/inbox/inboxRows.test.ts src/lib/agentRoster.test.ts src/components/InboxList.test.tsx` exited 0
(71 tests), after the test-only commit exited 1 with the fork function still absent.

Scoped red/green evidence: `TMPDIR="$HOME/.cache/ovis-tmp/inbox-agent-clarity" bun test
server/fork/fork-friends.test.ts` exited 1 (three meaningful project/migration failures) before
implementation. Server conventions (`bun test server/conventions.test.ts`, same TMPDIR) exited 0
(16 tests). `TMPDIR="$HOME/.cache/ovis-tmp/inbox-agent-clarity" bun test
server/fork/fork-friends.test.ts server/friends.test.ts` exited 0 (6 tests). No Bigpowers timing or
RED-isolation scripts exist in this checkout; the failing test-only commit records RED directly.

Final scoped verification: `TMPDIR="$HOME/.cache/ovis-tmp/inbox-agent-clarity" bun test
src/fork server/fork/fork-friends.test.ts server/friends.test.ts
src/components/InboxList.test.tsx src/components/InboxMode.test.tsx src/components/InboxRail.test.tsx
src/lib/agentRoster.test.ts src/conventions.test.ts server/conventions.test.ts` exited 0 (166 tests,
18 files). Back-button RED exited 1 before implementation; its first GREEN attempt exposed an
incomplete browser stub in the new test. Adding the SettingsProvider's DOM/event boundary fixed it
(33 tests passed, including InboxMode and InboxRail). Scoped TypeScript over the changed TS/TSX roots
exited 0, after generating the vendor declarations as `scripts/typecheck.ts` does. An initial scoped
config without that vendor reference checked upstream vendor sources under app strictness; the same
16 vendor errors reproduced on base `ae7bb1e2`. That diagnostic setup was corrected, not vendor code.

The three inbox browser regressions (`inbox-mode-demo-regression.ts`, `inbox-mode-panes-demo-regression.ts`,
`inbox-mode-rail-demo-regression.ts`) each exited 0 in `herdr-ci-runner:local` as user `runner`, with no
host network or credentials. A separate demo-only capture exited 0 at 1440px and 390px with Agent
friends on: the desktop arrow leaves the inbox, classic has no arrow/logo or empty brand gap, the
footer entry is visible, and phone home has no arrow/logo. Evidence remains under
`$HOME/.cache/ovis-tmp/inbox-agent-clarity/screenshots/fork/` (the demo's per-pane friend fixtures are
not evidence of server project assignment). All browser TMPDIRs were under the runner's home cache.
Whole-project typecheck, `bun run check fast` and `bun run build` were skipped per implementer scope;
the browser regressions built their own disposable demo bundles. No push, PR, deployment or merge.

Self-audit: no auth/API shape changes, secrets, dependencies, generated-source edits or tint; retained
old cache format and protect unknown project documents. Ordering reuses upstream's cycle-safe helper.
Minimal upstream hooks and disabled-state fallback verified. No Bigpowers state/plan files created.

Review finding 1 reproduced with decrypted alerts before any browser request: both disabled-manager
and stale-manager cases picked three different friends for one project. Collector metadata now feeds
FriendStore directly, with no extra RPC, async delay or change to the alert payload. The new fork alert
regression exited 1 before implementation, then `TMPDIR="$HOME/.cache/ovis-tmp/inbox-agent-clarity-review"
bun test server/fork/fork-alert-friends.test.ts server/fork/fork-friends.test.ts server/friends.test.ts
server/push.test.ts server/conventions.test.ts` exited 0 (109 tests). All tests use disposable state
and a fake loopback push service, not a real herdr session or device.

Review finding 2 reproduced in a focused InboxList: an orphan helper and another row moved when
their conductor appeared. Nesting now precedes `heldOrder`, so the new conductor appends while the
reader holds a place, and the family nests once focus leaves. The fork component regression exited
1 before implementation; `TMPDIR="$HOME/.cache/ovis-tmp/inbox-agent-clarity-review" bun test
src/fork/inbox/fork-InboxList.test.tsx src/fork/inbox/inboxRows.test.ts src/lib/agentRoster.test.ts
src/components/InboxList.test.tsx src/conventions.test.ts` exited 0 (86 tests).

Finding 3 describes intentional opt-in behavior, not an implementation regression: before code was
written, the user explicitly chose **With Agent friends** when offered that or a **Separate inbox
setting**. The selected option said "project friends, nesting and cleaner header turn on together;
no new setting." Nesting, CSS and Back therefore stay behind that off-by-default setting. Existing
fork tests cover disabled branding, ordering and styling. Separating these controls would revise
that approved choice and is not part of the review fixes.

Review verification: the combined touched/fork, push and conventions suites passed (254 tests,
21 files); scoped TypeScript passed after correcting the new alert test's optional-value assertion
typing. All three inbox browser regressions passed again in the CI image as `runner`, with no network
or host credentials. Logs, exact commands/exits and screenshots are under
`$HOME/.cache/ovis-tmp/inbox-agent-clarity-review/`. Self-audit passed correctness, security, performance,
types, coverage and hook scope: no new dependency, generated source, wire contract, polling or RPC.
Whole-project checks/build remain skipped; browser runs built only disposable demo bundles. No push,
PR, deployment or merge. The Bigpowers churn/RED-isolation scripts are absent and were not recreated.

Second review, friend refresh: the unchanged-ID workspace-move regression exited 1 (one request
instead of two), then `TMPDIR="$HOME/.cache/ovis-tmp/inbox-agent-clarity-review2" bun test
src/fork/friends/AgentAvatar.test.tsx src/fork/friends/notifications.test.ts src/fork/conventions.test.ts
src/conventions.test.ts` exited 0 (22 tests). It also covers reparenting, a non-agent ancestor moving,
unchanged-snapshot deduplication and the unchanged API payload. All changes are fork-owned; upstream
hook counts are unchanged. No settings/default changes or deployment.

Second review, held decoration: both focused-list orders reproduced the incorrect connector
(exit 1). The fixture initially assumed snapshot order controlled activity ties; the existing inbox
actually uses workspace order, so the regression now sets explicit activity ranks. The new pure
`forkInboxNesting` test also went RED before its implementation. It walks the drawn ancestor path
without sorting, breaking it at unrelated rows; `forkInboxRows` reuses it for unheld families. The
only new upstream hook is the one-line decoration call before rendering. Agent friends remains the
explicitly approved opt-in (the reviewer withdrew that finding).

Final second-review verification: 257 tests across 21 touched/fork/conventions files, scoped strict
TypeScript, the three inbox browser regressions in the CI image and whitespace checks all exited 0.
Exact commands/exits and audit checklist are under
`$HOME/.cache/ovis-tmp/inbox-agent-clarity-review2/verification.md`; browser logs/screenshots are beside
it. The combined run included the earlier server friend/push regressions. Full-suite typecheck,
`bun run check fast` and production `bun run build` remain skipped per scoped-check instructions;
browser regressions build only disposable demo bundles. Self-audit covered correctness, security,
performance, types, coverage and fork hook scope: no new dependency, payload, setting or poller.
No push, PR, deployment, merge, generated-source edit or Bigpowers state/spec artifact.

## Three piles

- **A: reusable changes.** Upstream PR candidates, not submitted. Optional presentation features should arrive upstream disabled; protocol correctness fixes should retain their focused tests rather than acquire a switch.
- **B: preferences.** Ricardo's choice of layout, density and interaction, not a new upstream default. Each extracted preference has an existing or new Settings control.
- **C: installation-specific integration.** Omarchy's theme hook and the fork's distribution/deployment wiring. Keep these outside the default experience. Xiaomi's adb address and the VPS service belong only in `scripts/deploy-vps.ts`, not browser defaults.

A file can contain more than one pile. The inventory below lists every upstream-owned file modified or deleted at the starting commit, including scripts, native code and documentation outside `src/`, `server/` and `shared/`.

### Upstream PR candidates (pile A)

| Candidate | Fork implementation | Existing contract / opt-in |
| --- | --- | --- |
| Pi live voice and floating call orb | `src/fork/voice/piVoiceSession.ts`, `src/fork/voice/PiVoiceView.tsx`, `src/fork/voice/VoiceOrb.tsx`, `server/fork/pi-voice.ts` | Settings: Pi live voice. Existing Pi wire validation stays in `shared/pi-voice.ts`. Never bypass observe, origin or device-revocation checks. |
| Computer view | `src/fork/computer/ComputerView.tsx`, `src/fork/computer/computerSettings.ts`, `server/fork/screen.ts` | Settings: Computer view. The PC's screen-relay viewer is framed as it is, edge to edge (its own toolbar has full screen and keyboard); Ovis adds no controls and no settings of its own. Bridge configuration remains `OVIS_SCREEN_*`; a browser toggle is not an authorization boundary. |
| GitHub | `src/fork/github/GithubInbox.tsx`, `src/fork/github/GithubPull.tsx`, `src/fork/github/GithubConversation.tsx`, `src/fork/github/GithubFiles.tsx`, `src/fork/github/GithubActions.tsx`, `src/fork/github/GithubClone.tsx`, `src/fork/github/github.ts`, `src/fork/github/githubDemo.ts`, `src/fork/github/PullRequestsDialog.tsx`, `server/fork/github.ts`, `server/fork/github-clone.ts`, `server/fork/pull-requests.ts`, `shared/github.ts` | Upstream candidate. Settings: GitHub (stored `pullRequests` key, off by default; existing choices preserved). Keeps the workspace PR dialog; adds a GitHub section to the agent inbox (desktop rail, phone round button left of New workspace) with Review requested and Yours across every `gh` account signed in on the PC, and a repository filter (`ovis:fork-github-repo`). A pull request opens as a page drawn from GitHub's API in Ovis's design: beside the list on wide screens (a placeholder until one is picked), full screen on a phone with Back. Tabs (upstream `Segmented`): Overview, Conversation, Checks, Files; fork CSS reserves space for the control's touch targets and focus rings while scrolling horizontally, without vertical scrolling or clipped borders. The Files tab opens a file's diff under it in upstream `RepoDiff`, with review threads under their lines. Actions, as the account that listed the PR and hidden on read-only devices: comment, approve, request changes, and merge (confirm press, method remembered, pinned to the shown head commit). Checkout opens or creates a local worktree; a repository on no workspace gets Clone and checkout, into a folder the user confirms (suggested beside the owner's other checkouts, else the last parent, else `~/Projects`), never over something else. Fork PRs offer only Open on GitHub: branch names alone cannot verify fork provenance. Upstream hook: an optional `notes` prop in `src/components/RepoDiff.tsx` (content under a diff line, through the diff package's line annotations); outdated threads stay after the file's diff. |
| Notes | `src/fork/notes/NotesInbox.tsx`, `src/fork/notes/NoteEditor.tsx`, `src/fork/notes/notes.ts`, `src/fork/notes/notesDemo.ts`, `src/fork/notes/Notes.css`, `src/fork/inbox/Places.tsx`, `src/fork/inbox/place.ts`, `server/fork/notes.ts`, `shared/fork/notes.ts` | Personal. Settings: Notes (stored `notes` key, off by default; on where fork settings were already stored). A place in the agent inbox beside Pull requests (footer icon on wide screens, round button on a phone): Markdown files in the server's `~/Notes` (`OVIS_NOTES_DIR`), newest first, searched by title, folder and text; a subfolder shows as a prefix. A note opens beside the list on wide screens and full screen on a phone with Back, in a TipTap editor that formats as it is typed and saves Markdown 0.8s after the last key and when the note is left; rename in its title, delete behind a confirm, all hidden on read-only devices. Dependencies: `@tiptap/*` 3.34, loaded only when a note opens. `src/fork/inbox/Places.tsx` replaced the GitHub-only hooks in `src/App.tsx` and `src/components/InboxList.tsx` with one per slot. |
| Android inbox widget | `app/android/ovis-widget/`, `server/fork/inbox-widget.ts`, `shared/fork/inbox-widget.ts`, `src/fork/inboxWidget.ts` | Optional: add the widget from the Android launcher, then open Ovis with push set up. It shows agent status and recent snippets, waiting agents first; tapping a row opens its conversation. While a widget is placed, Ovis checks only the working rows within the digest’s row budget for new snippets every 30 seconds; unchanged digests are skipped except for the 10-minute keepalive. Hooks: `server/core/status.ts` wraps the existing push service and stops the widget scheduler, `server/push.ts` sends encrypted digests through it, and `src/fork/useForkApp.tsx` reports widget placement. `app/android/settings.gradle` links the module; `OvisMessagingService` hands digests to it instead of displaying an alert. For fork APKs set `OVIS_PUSH_RELAY=https://ovis-push-relay.ricardofelixb.workers.dev` at build time; the code default is unchanged. |
| Reply read-aloud | `src/fork/voice/SpeakButton.tsx`, `src/fork/voice/speech.ts`, `server/fork/speech.ts` | Settings: Read aloud, with the existing voice selector. No engine/model download until requested. |
| Pi model picker | `src/fork/chat/ComposerPill.tsx`, `src/fork/chat/modelMark.ts` | Settings: Pi model picker. On a pi pane with the ovis-model extension, the composer pill opens a model and thinking menu while pi is idle; every other pane, and the pill's mark, model and ring, stay upstream's. |
| Live previews, word fade and send motion | `src/fork/chat/liveTurn.ts`, `src/fork/chat/streamReveal.ts`, `src/fork/chat/wordFade.ts`, `src/fork/chat/chatPresentation.ts`; the `MarkdownTextContext` hook in `src/components/Markdown.tsx` | Settings: Animated replies. The last reply's new words fade in as they arrive, Streamdown's way (a span and CSS fade per word, 350ms, staggered 100ms, an update's words started within 1000ms; slower than Streamdown's 150/40/320); bullets, code, quotes, rules, tables and images fade too, each in its turn among the words, so none shows before the words ahead of it; a half-written word or markdown mark is held back. Upstream accepted-send follow remains the default. `MarkdownTextContext` is a small extension point worth offering upstream. |
| Agent friends | `src/fork/friends/AgentFriend.tsx`, `src/fork/friends/AgentAvatar.tsx`, `src/fork/friends/TabFriends.tsx`, `src/fork/friends/friends.ts`, `server/fork/friends.ts` | Settings: Agent friends. With Agent friends on, every place that shows a running agent (inbox, sidebar, tabs, palette, header, chat) shows its friend alone, no harness logo, through `AgentAvatar`; the harness `AgentMark` stays where it names a harness (picker, settings, usage, setup) and where a pane has no friend. Fork-only. |
| Generic runtime fixes | Conversation deltas, receipt whitespace, hidden-page throttling, independent machine reconnect, source bridges, favicon discovery, terminal/IME fixes | These fix transport or data interpretation, not personal layout. Their coupled upstream integrations and tests are retained; see limits below. |
| Copilot partial-log truncation within one timestamp tick | `server/copilot-store.ts`; existing regression in `server/copilot.test.ts` | Compare truncations against both complete-line and observed sizes. Coarse file timestamps can stay unchanged when a partial line is appended and removed. Generic upstream bug fix, no setting or test exclusion. |
| Portable native improvements | Android call lifecycle, notification permissions, friend pictures and multi-window handling | Native-app contribution candidates. They are not Xiaomi-only changes. Native files were not rewritten by this refactor. |

### Preferences (pile B)

New devices use upstream behavior. Migrated devices retain the previous fork behavior.

| Preference | New device | Migrated fork device | Control |
| --- | --- | --- | --- |
| Phone tabs | Row | Header, unless explicitly chosen otherwise | Existing Phone tabs setting |
| Angular boxes | Rounded | Square | Square corners |
| Lens control | Header buttons | Toggle in More | View toggle in More |
| Sidebar pictures | Agent marks | Friend pictures | Agent friends |
| Composer pill on pi | Upstream mark, model and ring | Model and thinking menu | Pi model picker |
| Chat previews and send-follow | Upstream transcript/follow rules | Live preview, word fade, pop animation and immediate follow | Animated replies |
| Extra views/actions | Absent | Pi voice, Computer, PRs and read-aloud available | Their individual feature switches |
| Terminal key bar | Upstream layout without Super | Existing saved layout, or the old fork layout including Super | Existing Key bar editor; adding Super is offered with Computer view |
| Context ring visibility | Visible, as upstream | Existing choice | Existing Context circle control |
| Running work starts open | Open, as upstream | Existing choice | Existing Open work while the agent runs control |

### Installation-specific code (pile C)

- `src/fork/settings/omarchyTheme.ts`, the Omarchy row in `src/fork/settings/SettingsRows.tsx`, and `server/fork/omarchy-themes.ts` implement Follow Omarchy. It is off by default and offered when this device has sent a theme. The hook stays in `scripts/omarchy-theme-hook.sh`. No theme colors were edited.
- `scripts/deploy-vps.ts` and `scripts/deploy-helpers.ts` retain the VPS/Xiaomi deployment workflow. This work does not deploy, restart a service, contact a phone, or change the live checkout.
- Fork source-bundle/release wiring and deployment documentation stay outside the UI extraction. They must not be proposed upstream with Ricardo's endpoints or service names.
- The fork's source bundle identity (`sourceBundleVersion` in `server/bundle-version.ts`, the `47+<hash>` that servers compare as `REMOTE_BUNDLE_VERSION`) hashes the files under `BUNDLE_PATHSPECS` on disk, so `bundleInput` skips generated output (`dist` directories, `*.tsbuildinfo`, as `tsc -b` writes under `shared/vendor/*`): the same commit once hashed differently on the VPS than on the PCs, and Ovis refused them. `scripts/deploy-vps.ts` compares each PC's identity with the VPS checkout's after its build. Fork-only, not an upstream PR candidate.
- `scripts/deploy-vps.ts` updates every PC's own Ovis before it restarts the VPS's `ovis.service`, then waits up to 60s for each updated PC (tracked by machine id, each request bounded) to show `connected` in `/api/machines`: a server started while a PC still ran the old code parked it in `error` and never retried (the reconnect API is owner-only). The PC list is read from the still-running server. Fork-only, not an upstream PR candidate.

### Dropped fork features

Branch in the header, Collapse offline PCs, Taller prompt cards, Compact tab menus and Sidebar pane actions were deleted, with no setting left behind: those screens behave as upstream's do. The tailnet presence pipeline (`server/tailnet.ts`, `tailnet_offline`) went with Collapse offline PCs: the fork no longer polls Tailscale presence. Upstream's own `server/tailscale.ts` (the `/api/access` reads) is untouched. A migrated device's stored values for those keys are ignored and dropped on the next save. The validation appendix below is a record of the earlier refactor and still names them.

## Settings and migration

`src/fork/settings/settings.ts` owns fork settings, sanitization, migration, scopes, storage and root data attributes. `src/fork/settings/SettingsRows.tsx` owns the translated controls, rendered through a small Settings-panel insertion. Upstream settings extend `ForkSettings` and spread the defaults/scope/sanitizer rather than duplicating each field.

The migration follows the existing legacy-settings approach. Only a main record containing a historical fork-only field (`contextCircle`, `speechVoice`, `liveVoice`, `followOmarchy` or `enterKey`) receives the old fork defaults. An upstream-only record, an absent record and an empty record do not. Explicit values always win, including `false`, a customized key bar, and `phoneTabs: "row"`. Existing dedicated storage keys take precedence over old values in the main record.

Fork choices also live in `ovis:fork-settings`. This protects them when an older upstream tab saves a main settings record that does not know these fields. Reads do not write storage. Reset and subsequent explicit changes persist in the fork key, so reloading cannot reapply an old default over a new choice. No server env default was added: device-local migration preserves each phone/desktop's choices without changing another install's behavior. A device with no surviving settings record cannot be identified as an old fork device; it correctly receives upstream defaults.

Translations added by fork features are collected in `src/fork/i18n/featureI18n.ts` and `src/fork/i18n/i18n*.ts`. Three locale entry points call `withForkI18n`; the upstream per-feature dictionaries and ownership tests remain unchanged. Shared labels move into the base dictionary at composition time, not by editing upstream translation files.

## Extraction boundaries

- `src/main.tsx` loads `src/fork/styles.css` after upstream styles. This imports fork chat/composer/component overrides. Presentation overrides use `data-fork-*="true"`; disabling a switch removes its styling immediately. Only two semantic radius variables are defined unconditionally, for fork-owned circular controls.
- Upstream component stylesheets were restored instead of keeping radius, speech and view-toggle rules inside them. The obsolete fork files-panel overrides were removed: upstream already owns the docked panel and resizer. Those overrides overrode `[hidden]` and double-counted the panel's width when loaded as a later stylesheet. The upstream implementation supplies the panel behavior instead.
- Fork-only public paths retain small compatibility re-exports where other fork code/tests already import them. Their implementations now live under `src/fork/` or `server/fork/`. Compatibility facades are intentionally not duplicated implementations.
- `server/fork/services.ts` constructs optional services and composes their socket handlers. `server/fork/routes.ts` dispatches screens, Pi voice, friends and speech. An unmatched route returns `null`; a successful WebSocket upgrade can resolve to `undefined`. Confusing these would continue dispatch after an upgrade.
- The screen hook remains after upstream authentication and observe checks, with its own origin check. The other hook remains after the API drive/origin/observe guards. No authorization, takeover, focus or queued-input rule was loosened. Device-local UI settings do not grant or revoke server API capabilities.
- PR handling stays behind the existing workspace route matching and remote-PC proxy guard. Omarchy event streaming stays in the authenticated PC-event handler. Moving either to a global pre-guard router would change its security/remote-routing semantics.

### Deliberately retained upstream integration

A small import-and-call is possible for a self-contained component, not for every addition to an existing state machine. These remaining diffs are recorded rather than hidden behind new abstractions:

1. `src/fork/useForkApp.tsx` now owns retained Computer state/rendering, phone voice, friend loading, native alert initialization, link routing and the desktop-script title contract. `src/App.tsx` calls it once and retains mount points, explicit `screenMachineId === null` guards and selection/menu callbacks. Existing `src/fork/HeaderLens.tsx` owns the header lens controls; upstream owns phone/header tab placement through `useTabSheet`. Sidebar, pane and terminal selection/focus integrations remain with their upstream owners. No Coding/Work browser split existed at this checkpoint; only the server-side runner filter remains.
2. `src/fork/chat/ComposerPill.tsx` owns the Pi model/reasoning menu, optimistic selection/expiry and context ring. `src/components/Composer.tsx` calls its hook and mounts its renderer around upstream's usage meter; the hook returns the displayed model/effort for the existing fit measurement. Voice-action/send arbitration and existing branch/context props remain integrated. An upstream pill-renderer extension point would avoid moving upstream's display markup; a shared App view extension point would reduce the remaining guards. Both are upstream PR candidates, not submitted.
3. `src/components/ChatView.tsx` and `src/components/ChatTimeline.tsx` retain live-row identity, read reconciliation, footer/scroll anchoring and transcript-layout fixes. Compact runs, speech, motion and reveal helpers are extracted. Moving the remaining timeline changes would require replacing the upstream reader/virtualizer, not a behavior-preserving module move. The upstream stopped-send effect and selection are restored verbatim, including their source-level test.
4. Machine connection/retry/update code, source-bundle handling, herdr-core adapters, Pi transcript/receipt parsing, native notifications and terminal lifecycle fixes retain their existing upstream integration and tests. These are portable correctness changes, not fork visual defaults. They need separate upstream correctness PRs; no new transport, cache, session ownership or RPC mechanism was invented here.
5. `server/fork/core-terminals.ts` owns `ovis.view=work` hiding. `server/herdr-core/snapshot.ts` imports and calls its predicate in the live projection; `server/herdr-core/adapter.ts` imports and calls it in event filtering. There is no separate Coding/Work browser grouping. Pi session naming is dropped: snapshots use upstream terminal names/titles and never read Pi session metadata for tab names. The shared metadata reader remains for session history.
6. The native Android call/notification changes and packaging files are outside this browser/server move. Their device permissions and lifecycle require native checks. This work does not claim to have run Android, Windows or macOS validation.
7. Existing convention-test adaptations, cross-module settings migrations, shared preference/wire fields and fixture helpers remain where their upstream owners enforce them. Generated files, tracked `.rej` files and `src/lib/fixtures-input-rows/**` recordings are unchanged.

## Regression ownership

Upstream `scripts/*-regression.ts` and `scripts/*-qa.ts` previously adapted to fork-only controls were restored to the merge-base versions. Fork preference/migration coverage lives in `scripts/fork-preferences-regression.ts`. `scripts/fork-features-regression.ts` exercises read-aloud playback controls, the Computer viewer frame (full screen allowed, no Ovis controls), pull-request checkout/reopening and Pi voice start/mute/end, plus the fresh-install disabled paths. Both are registered with the browser runner. Pure migration, model-mark, compact-run, branch-storage and chat-presentation regressions live under `src/fork/`.

The browser runner uses the CI image and a `git ls-files` tar, isolated test sessions and temporary state. Standalone upstream QA scripts absent from the serial lane are registered only inside the disposable verification snapshot, not added to normal CI. The SSH-profile QA needs its external SSH fixture and is explicitly excluded from the local parallel batch. See the validation appendix for exact scope and results.

## One-line hook extraction (PR #84 follow-up)

Counts compare against `upstream/main` with `git diff --shortstat upstream/main...HEAD -- <file>`; `+/-` means insertions/deletions. Before is commit `30d046a4` (PR #84). This table is updated alongside each extraction. Deleted upstream display lines still count: moving the Composer pill removes inline fork logic, but cannot make those upstream deletions disappear.

| Upstream file | Before +/− | After +/− | Fork hook |
| --- | --- | --- | --- |
| `server/herdr-core/adapter.ts` | +30/−6 | +8/−3 | Import and predicate call for event hiding; existing subscription bookkeeping remains |
| `server/herdr-core/snapshot.ts` | +51/−12 | +3/−1 | Import and predicate call in live-terminal projection |
| `src/App.tsx` | +65/−57 | +43/−62 | One `useForkApp` import/call; Computer/voice mounts and selection/header guards; existing HeaderLens and AgentAvatar mounts remain |
| `src/components/Composer.tsx` | +101/−39 | +31/−63 | One `useForkComposer` import/call plus `renderPill` mount; model/effort fit dependencies; existing voice/send integration remains |
| `src/components/InboxList.tsx` | +5/−5 | +2/−1 | One import plus `<ForkInboxAvatar row={row} />`; original InboxAvatar restored |
| `src/components/InboxMode.tsx` | +3/−2 | +3/−3 | Same avatar import and one-line mounts for phone thread title and wide thread chip |
| `src/lib/api.ts` | +30/−7 | +7/−17 | Fork API compatibility re-export, delta-reader import/call, exported shared JSON helpers and delta-size cache guard |
| `src/lib/notifications.ts` | +27/−12 | +9/−3 | Fork import, native permission hooks, one `forkAlert` call and friend-icon lookup; upstream signatures restored |
| `src/lib/useNotifications.ts` | +12/−3 | +3/−2 | Native permission-source predicate only; upstream signature restored, auto-request owned by useForkApp |
| `src/lib/useAlertSignals.ts` | +4/−2 | +2/−0 | No friend arguments on upstream notification calls; existing friend lookup for chimes/drop-ins stays |
| `src/lib/notifications.test.ts` | +11/−3 | +3/−3 | Friend characterization moved under src/fork; existing return-Promise assertions retained |
| `server/pi.ts` | +82/−2 | +53/−1 | Removed Pi-name-only function/imports; other existing Pi integrations unchanged |
| `server/herdr-core/adapter.test.ts` | +19/−1 | +0/−0 | Removed fork-only naming test; upstream file restored |
| `server/herdr-core/snapshot.test.ts` | +44/−1 | +21/−0 | Removed naming tests and their unused import; runner-hiding tests remain |
| `server/pi.test.ts` | +17/−1 | +0/−0 | Removed fork-only name lookup test; upstream file restored |
| `src/components/AgentSidebar.test.tsx` | +32/−7 | +7/−7 | Removed the fork-only Pi session name test and its snapshot import |
| `src/lib/i18n.test.ts` | +0/−0 | +1/−1 | Register the extracted pill as a composer dictionary owner; translations unchanged |

`src/fork/api.ts` owns incremental turn fetching/merging, PR checkout and Pi live voice requests. It reuses upstream's authenticated JSON/error helpers: remote-machine routing, cancellation, conditional reads and cache accounting remain unchanged. `src/fork/friends/notifications.ts` owns Android shell alerts/permission state and friend-picture lookup; callers no longer thread a friend through upstream APIs. Browser and native alerts still honor permission, visibility and the existing Agent friends setting. The App hook also supplies the live agent-pane set: a cached assignment must not decorate a shell after its agent exits, matching the old callers' `pane.agent` guard.

Follow-up validation (local, no browser, push, deployment or merge):

```sh
TMPDIR="$HOME/.cache/ovis-tmp/fork-hooks" bun test src/fork server/fork/core-terminals.test.ts server/herdr-core/adapter.test.ts server/herdr-core/snapshot.test.ts server/pi.test.ts src/conventions.test.ts server/conventions.test.ts src/lib/notifications.test.ts src/lib/useNotifications.hook.test.ts src/lib/api.test.ts src/lib/api-request-id.test.ts src/lib/api-signin.test.ts src/lib/conversationFetch.test.ts src/lib/sentWaiting.test.ts src/lib/compose.test.ts src/components/Composer*.test.tsx src/components/InboxList.test.tsx src/components/InboxMode.test.tsx src/components/TabStrip.appLayout.test.tsx src/components/PaneCanvas.appLayout.test.tsx scripts/changelog-fold.test.ts
```

Exit 0: 675 tests across 32 files, including both upstream conventions suites and fork conventions. Core naming followed a red/green regression; browser extraction reused existing tests and added pill/default/observe and Android alert characterization tests. A first test fixture lacked a browser language; setting its language explicitly fixed the fixture, not production code. An earlier notification run exposed stale friend arguments and a SettingsProvider dependency in the upstream notification hook; moving initialization into useForkApp and restoring the signatures fixed both. No known-flaky allowance was used. Final self-audit also found and migrated InboxMode's two shared-avatar callers. The new stale-friend regression failed first (`TMPDIR="$HOME/.cache/ovis-tmp/fork-hooks" bun test src/fork/friends/AgentAvatar.test.tsx`, exit 1: an agentless pane still showed `/friends/neko.png`), then passed with the fork-local eligibility check (`TMPDIR="$HOME/.cache/ovis-tmp/fork-hooks" bun test src/fork/friends/AgentAvatar.test.tsx src/components/InboxMode.test.tsx`, exit 0, 18 tests).

Self-audit: correctness (naming fallback, exact runner label, upstream disabled/observe pill, stale friends), security (unchanged JSON/origin/auth/remote-routing helpers; no new endpoints/dependencies/secrets), performance (incremental merge/cache bounds and retained viewer preserved), clarity/conventions and diff whitespace reviewed. New tests exercise public notification/pill/avatar behavior. The generic Bigpowers audit output/state-file instructions were not used: this task forbids new planning/state artifacts. At this implementation checkpoint, no independent review had run; the subsequent review is recorded below.

At the implementation checkpoint, `bun run check fast`, `bun run build` and project-wide type checking were deliberately skipped under the implementer's scoped-check restriction. Browser/native/device checks were not run. Required browser regressions remain for the review gate; the maintainer deploys and tests before merging.

### Approved pre-push follow-up

Independent review by `openai-codex/gpt-6.1-terra`, one round: no concrete problems found; the reviewer reproduced all 675 scoped tests and `git diff --check`. No review-requested fixes remained.

The repository's mandatory pre-push `check fast` then caught an overly strict fork-hook `agentStatus` type, an unused naming-test import, a stale AgentSidebar Pi-name test and the extracted pill's missing i18n ownership entry. These were fixed without runtime behavior changes. They were found after the independent review, not in a second review round.

```sh
TMPDIR="$HOME/.cache/ovis-tmp/fork-hooks" bun test src/fork/chat/ComposerPill.test.tsx server/herdr-core/snapshot.test.ts src/components/AgentSidebar.test.tsx src/lib/i18n.test.ts
```

Exit 0: 135 tests across four files after those fixes. `git diff --check` also exited 0.

```sh
TMPDIR="$HOME/.cache/ovis-tmp/fork-hooks" CHECK_DIR="$HOME/.cache/ovis-tmp/fh-push" bun run check fast
```

Final exit 1: workflow syntax, generated types/themes, type checking and build all passed; unit tests reported **17,746 pass, 14 fail, 57 skip in 1,005 files**. All 14 failures were in untouched `server/omp.test.ts`, including `ConversationUnavailable: no_session_path`. The first run stopped at the two type errors; the next exposed the stale test and dictionary ownership entry as well as these baseline failures. No full-fast pass is claimed.

Base evidence: in a disposable detached checkout at parent commit `30d046a4`, with the same locked dependencies:

```sh
TMPDIR="$HOME/.cache/ovis-tmp/fork-hooks" bun test server/omp.test.ts src/components/AgentSidebar.test.tsx src/lib/i18n.test.ts
```

Exit 1: 145 pass, the **same 14 omp failures**, across three files. The sidebar and i18n tests passed on the base. No omp files were changed. Browser/native/device checks and deployment remain outstanding; the pre-push type/test fixes have not had a second independent review.

## Size measurement

The command requested in the task counts **all changed paths**, including added files. Use name-status to distinguish collision-bearing upstream files from fork-owned additions:

```sh
base=$(git merge-base HEAD upstream/main)
git diff --name-only "$base" HEAD -- src server shared | wc -l
git diff --name-status "$base" HEAD -- src server shared
```

At the starting commit: **176 modified upstream files, 82 added fork files and 2 deleted upstream files** (260 paths). After extraction: **123 modified upstream files, 131 added fork files, no deletions** (254 paths). After the review follow-up: **124 modified upstream files, 132 added fork files, no deletions** (256 paths). The extra upstream file is the sidebar integration test, which now asserts default and opt-in menus; the addition is the provider-independent fork cache test. The generic Copilot fix makes the final totals **125 modified upstream files and 132 added fork files**, with no deletions, or 257 paths. This removes 51 modified-file collision surfaces and restores both deleted upstream modules. The merge check is recorded with validation below. Restoring an upstream file removes a collision surface; adding a fork module does not create one.

## Complete starting-file inventory

The following inventory is a static record of this refactor, not a release manifest. `Restored` means byte-identical to the upstream merge-base file; `Retained` includes both small hooks and the coupled changes explained above. Test/script classifications follow the feature they exercise; restoring them is not removal of that feature.

| Pile | State | Starting upstream files |
| --- | --- | --- |
| A | Restored | `scripts/agent-entry-points-demo-regression.ts`<br>`scripts/agent-skill-menu-demo-regression.ts`<br>`scripts/agy-chat-browser-qa.ts`<br>`scripts/chat-fallback-browser-qa.ts`<br>`scripts/chat-gjc-streaming-browser-qa.ts` |
| A | Restored | `scripts/chat-greeting-demo-regression.ts`<br>`scripts/chat-history-browser-qa.ts`<br>`scripts/chat-local-send-follow-demo-regression.ts`<br>`scripts/chat-size-regression.ts`<br>`scripts/chat-tool-paths-demo-regression.ts` |
| A | Restored | `scripts/chat-virtual-browser-qa.ts`<br>`scripts/chat-working-line-demo-regression.ts`<br>`scripts/claude-image-browser-qa.ts`<br>`scripts/command-outcome-demo-regression.ts`<br>`scripts/composer-draft-demo-regression.ts` |
| A | Restored | `scripts/composer-fit-demo-regression.ts`<br>`scripts/copilot-chat-browser-qa.ts`<br>`scripts/copilot-image-browser-qa.ts`<br>`scripts/deep-link-demo-regression.ts`<br>`scripts/default-view-regression.ts` |
| A | Restored | `scripts/devin-chat-browser-regression.ts`<br>`scripts/droplet-demo-regression.ts`<br>`scripts/file-viewer-regression.ts`<br>`scripts/files-documents-demo-regression.ts`<br>`scripts/files-panel-demo-regression.ts` |
| A | Restored | `scripts/font-swap-demo-regression.ts`<br>`scripts/grok-chat-browser-qa.ts`<br>`scripts/grok-image-browser-qa.ts`<br>`scripts/health-flap-demo-regression.ts`<br>`scripts/herdr-profiles-ssh-qa.ts` |
| A | Restored | `scripts/hide-pc-demo-regression.ts`<br>`scripts/machines-browser-qa.ts`<br>`scripts/mobile-viewport-regression.ts`<br>`scripts/new-session-skills-browser-qa.ts`<br>`scripts/notification-view-regression.ts` |
| A | Restored | `scripts/omo-question-wheel-regression.ts`<br>`scripts/omp-codex-image-browser-qa.ts`<br>`scripts/pane-find-regression.ts`<br>`scripts/pane-lifetime-regression.ts`<br>`scripts/pane-paging-demo-regression.ts` |
| A | Restored | `scripts/pending-pane-switch-regression.ts`<br>`scripts/phone-back-demo-regression.ts`<br>`scripts/pi-image-browser-qa.ts`<br>`scripts/prompt-card-timing-demo-regression.ts`<br>`scripts/secret-input-regression.ts` |
| A | Restored | `scripts/sidebar-activity-demo-regression.ts`<br>`scripts/split-view-regression.ts`<br>`scripts/sticky-modifiers-regression.ts`<br>`scripts/tap-targets-demo-regression.ts`<br>`scripts/terminal-arrows-clicks-regression.ts` |
| A | Restored | `scripts/terminal-autoswitch-demo-regression.ts`<br>`scripts/terminal-ghostty-demo-regression.ts`<br>`scripts/terminal-input-regression.ts`<br>`scripts/terminal-ipad-ime-regression.ts`<br>`scripts/terminal-keyboard-suggestions-regression.ts` |
| A | Restored | `scripts/update-browser-qa.ts`<br>`scripts/workspace-rows-regression.ts`<br>`scripts/workspace-touch-reorder-demo-regression.ts`<br>`src/components/AgentMark.test.tsx`<br>`src/components/AgentMark.tsx` |
| A | Restored | `src/conventions.test.ts`<br>`src/lib/composerStrip.test.ts`<br>`src/lib/composerStrip.ts`<br>`src/lib/i18n.test.ts`<br>`src/lib/i18n/chat.ja.ts` |
| A | Restored | `src/lib/i18n/chat.ko.ts`<br>`src/lib/i18n/chat.zh.ts`<br>`src/lib/i18n/composer.ja.ts`<br>`src/lib/i18n/composer.ko.ts`<br>`src/lib/i18n/composer.zh.ts` |
| A | Restored | `src/lib/i18n/files.ja.ts`<br>`src/lib/i18n/files.ko.ts`<br>`src/lib/i18n/files.zh.ts`<br>`src/lib/i18n/machines.ja.ts`<br>`src/lib/i18n/machines.ko.ts` |
| A | Restored | `src/lib/i18n/machines.zh.ts`<br>`src/lib/i18n/settings.ja.ts`<br>`src/lib/i18n/settings.ko.ts`<br>`src/lib/i18n/settings.zh.ts`<br>`src/lib/i18n/sidebar.ja.ts` |
| A | Restored | `src/lib/i18n/sidebar.ko.ts`<br>`src/lib/i18n/sidebar.zh.ts`<br>`src/lib/i18n/terminal.ja.ts`<br>`src/lib/i18n/terminal.ko.ts`<br>`src/lib/i18n/terminal.zh.ts` |
| A | Restored | `src/lib/i18n/workspace.ja.ts`<br>`src/lib/i18n/workspace.ko.ts`<br>`src/lib/i18n/workspace.zh.ts`<br>`src/lib/keyBar.test.ts`<br>`src/lib/workBlocks.test.ts` |
| A | Restored | `src/lib/workBlocks.ts`<br>`src/components/ChatTurn.test.ts`<br>`scripts/composer-fit-harness.ts`<br>`scripts/skill-menu-cases/claude-terminal.ts` |
| A | Retained | `app/android/app/src/main/AndroidManifest.xml`<br>`app/android/app/src/main/java/sh/ovis/app/HerdrShellPlugin.java`<br>`app/android/app/src/main/java/sh/ovis/app/MainActivity.java`<br>`app/android/ovis-push/build.gradle`<br>`app/android/ovis-push/src/main/java/sh/ovis/push/OvisMessagingService.java` |
| A | Retained | `app/android/ovis-push/src/main/res/values/strings.xml`<br>`app/web/error.html`<br>`app/web/index.html`<br>`index.html`<br>`public/sw.js` |
| A | Retained | `scripts/background-agent-detail-demo-run.ts`<br>`scripts/ci-browser-timings.json`<br>`scripts/ci-browser.sh`<br>`scripts/ci-browser.test.ts` |
| A | Retained | `scripts/film/capture.ts`<br>`scripts/omp-question-compat.ts`<br>`scripts/pane-mute-demo-run.ts`<br>`scripts/plugin.test.ts`<br>`scripts/plugin.ts` |
| A | Retained | `scripts/release-guards.ts`<br>`scripts/server-artifact.ts`<br>`scripts/source-scan.ts`<br>`server/auth.ts` |
| A | Retained | `server/bridge.ts`<br>`server/compiled-server.contract.test.ts`<br>`server/conventions.test.ts`<br>`server/conversation-metadata.test.ts`<br>`server/conversation-metadata.ts` |
| A | Retained | `server/conversation-monitor.ts`<br>`server/conversation.ts`<br>`server/core/connections.test.ts`<br>`server/core/status.ts`<br>`server/core/terminals.ts` |
| A | Retained | `server/dispatch.ts`<br>`server/hc-machines.test.ts`<br>`server/herdr-core/adapter.test.ts`<br>`server/herdr-core/adapter.ts`<br>`server/herdr-core/machine-bridge.ts` |
| A | Retained | `server/herdr-core/snapshot.test.ts`<br>`server/herdr-core/snapshot.ts`<br>`server/index.ts`<br>`server/install-lock.test.ts`<br>`server/machine-api.test.ts` |
| A | Retained | `server/machine-api.ts`<br>`server/machine-core-choice.test.ts`<br>`server/machine-events.contract.test.ts`<br>`server/machine-events.ts`<br>`server/machine-herdr-choice.test.ts` |
| A | Retained | `server/machine-herdr-switch-retry.test.ts`<br>`server/machine-independent-reconnect.test.ts`<br>`server/machine-own-update.test.ts`<br>`server/machine-update.test.ts`<br>`server/machines.test.ts` |
| A | Retained | `server/machines.ts`<br>`server/pane-routes.ts`<br>`server/pc-install.test.ts`<br>`server/pi-delivery.test.ts`<br>`server/pi-delivery.ts` |
| A | Retained | `server/pi.test.ts`<br>`server/pi.ts`<br>`server/project-favicon.test.ts`<br>`server/project-favicon.ts`<br>`server/push.test.ts` |
| A | Retained | `server/push.ts`<br>`server/remote-host.ts`<br>`server/request-log.test.ts`<br>`server/static.test.ts`<br>`server/static.ts` |
| A | Retained | `server/statusline-context.test.ts`<br>`server/transcript-records.ts`<br>`server/windows-native.test.ts`<br>`server/workspace-routes.ts`<br>`shared/machines.ts` |
| A | Retained | `shared/preferences.ts`<br>`shared/protocol.ts`<br>`shared/push.ts`<br>`shared/workspace-lifecycle.ts`<br>`site/demo/index.html` |
| A | Retained | `site/demo/transport.ts`<br>`src/components/Droplet.tsx`<br>`src/components/FilePanelResizer.tsx`<br>`src/components/KeyBar.tsx` |
| A | Retained | `src/components/KeyBarSettings.tsx`<br>`src/components/RowMenu.tsx`<br>`src/components/SentWaiting.tsx`<br>`src/components/SettingsDialog.tsx`<br>`src/components/Sidebar.appLayout.test.tsx` |
| A | Retained | `src/lib/api.ts`<br>`src/lib/compose.test.ts`<br>`src/lib/compose.ts`<br>`src/lib/droplet.ts`<br>`src/lib/filePanelWidth.test.ts` |
| A | Retained | `src/lib/filePanelWidth.ts`<br>`src/lib/keyBar.ts`<br>`src/lib/keys.ts`<br>`src/lib/machineContext.tsx`<br>`src/lib/nativeApp.ts` |
| A | Retained | `src/lib/notificationTarget.ts`<br>`src/lib/notifications.test.ts`<br>`src/lib/notifications.ts`<br>`src/lib/paneBranch.ts`<br>`src/lib/settings.legacy-fixture.ts` |
| A | Retained | `src/lib/themeBoot.test.ts`<br>`src/lib/themeBoot.ts`<br>`src/lib/themes.ts`<br>`src/lib/useAlertSignals.ts`<br>`src/lib/useMachineRoster.ts` |
| A | Retained | `src/lib/useNotifications.ts`<br>`src/lib/usePaneAttach.hook.test.ts`<br>`src/lib/useSelection.ts`<br>`src/lib/useSidebarLayout.ts`<br>`src/lib/useTabReorder.ts` |
| A | Retained | `src/lib/useTerminalMount.ts`<br>`src/lib/useTerminalRefits.hook.test.ts`<br>`src/lib/useTerminalRefits.ts`<br>`src/lib/useWorktreeBranches.ts`<br>`src/lib/webPanel.test.ts` |
| A | Retained | `src/lib/webPanel.ts`<br>`src/lib/worktreeBranches.test.ts`<br>`src/lib/worktreeBranches.ts`<br>`src/pwa-notification.test.ts`<br>`vite.config.ts` |
| A+B | Restored | `scripts/header-context-demo-regression.ts`<br>`scripts/header-lens-switch-regression.ts`<br>`scripts/inbox-mode-demo-regression.ts`<br>`scripts/key-bar-customization-demo-regression.ts`<br>`scripts/mobile-tabs-regression.ts` |
| A+B | Restored | `scripts/phone-glass-header-demo-regression.ts`<br>`scripts/settings-pages-demo-regression.ts`<br>`scripts/sidebar-declutter-demo-regression.ts`<br>`scripts/sidebar-filter-demo-regression.ts`<br>`scripts/sidebar-peek-demo-regression.ts` |
| A+B | Restored | `scripts/ui-regression.ts`<br>`src/components/AgentSidebar.css`<br>`src/components/AgentSidebar.test.ts`<br>`src/components/ChatView.css`<br>`src/components/ChatView.stoppedTurn.test.ts` |
| A+B | Restored | `src/components/Composer.css`<br>`src/components/PaneCanvas.css`<br>`src/components/TabStrip.css` |
| A+B | Retained | `src/components/AgentSidebar.test.tsx`<br>`src/components/AgentSidebar.tsx`<br>`src/components/ChatTimeline.test.tsx`<br>`src/components/ChatTimeline.tsx`<br>`src/components/ChatView.tsx` |
| A+B | Retained | `src/components/Composer.tsx`<br>`src/components/MachineSidebar.loading.test.tsx`<br>`src/components/MachineSidebar.test.ts`<br>`src/components/MachineSidebar.tsx`<br>`src/components/PaneCanvas.appLayout.test.tsx` |
| A+B | Retained | `src/components/PaneCanvas.tsx`<br>`src/components/PaneTerminal.tsx`<br>`src/components/TabStrip.appLayout.test.tsx`<br>`src/components/TabStrip.tsx`<br>`src/lib/sidebarAgents.test.ts` |
| A+B | Retained | `src/lib/sidebarAgents.ts` |
| A+B+C | Restored | `src/lib/settings.hook.test.ts`<br>`src/styles.css` |
| A+B+C | Retained | `src/App.tsx`<br>`src/components/Sidebar.tsx`<br>`src/lib/settings.test.ts`<br>`src/lib/settings.ts`<br>`src/lib/i18n.ja.ts`<br>`src/lib/i18n.ko.ts`<br>`src/lib/i18n.zh.ts` |
| A+C | Retained | `DESIGN.md`<br>`THIRD_PARTY_NOTICES.md`<br>`app/android/ovis-push/README.md`<br>`docs/guide.md`<br>`docs/herdr-core-layout.md` |
| A+C | Retained | `docs/native-app.md`<br>`docs/remote-pcs.md` |
| B | Restored | `src/components/AccountApprovalPrompt.css`<br>`src/components/AgentSetupCard.css`<br>`src/components/AgentsSettings.css`<br>`src/components/Droplet.css`<br>`src/components/FilesDialog.css` |
| B | Restored | `src/components/Machines.css`<br>`src/components/PromptCard.css`<br>`src/components/RowMenu.css`<br>`src/components/SettingsControls.css`<br>`src/components/SetupGuide.css` |
| B | Restored | `src/components/Sidebar.css`<br>`src/components/UsageSettings.css`<br>`src/components/VoiceInput.css` |
| C | Retained | `.github/workflows/remote-bundles.yml`<br>`AGENTS.md`<br>`scripts/build-remote-bundle.ts`<br>`server/remote-bundle.test.ts`<br>`server/remote-bundle.ts` |

Total inventoried: **284 upstream-owned paths** (282 modified and 2 deleted at the starting commit). The 148 originally added paths are fork-owned and do not collide with an upstream path; their feature families are described above.

## CI

`fork-ci.yml` runs on PRs, pushes to main and manual dispatch, on `ubuntu-24.04`. New runs cancel older runs for the ref. Independent jobs check types/generated types/themes/build, run four deterministic unit-file shards, and build/run fork browser regressions plus changed regression/QA scripts whose bytes differ from upstream. Changes are measured against the PR base or push's previous commit. Each job has a 10-minute timeout; **`Fork CI`** is the final, always-run gate and fails unless every job succeeds. Dependencies, Node and hosted Chromium follow upstream's pinned setup/cache paths. There are no integration/native/release jobs.

Expected warm-cache wall times (not GitHub measurements): typecheck/build **1-2 minutes**, each unit shard **1-3 minutes**, normal fork-only browser **1-3 minutes**, final gate **under 15 seconds**. The target is **2-3 minutes total**, not a guarantee for large diffs or cold Chromium installs. After filtering restored upstream copies, this migration PR selects **4 scripts**: `file-viewer-regression.ts`, `fork-features-regression.ts`, `fork-preferences-regression.ts` and `inbox-mode-demo-regression.ts`. None needs the external Docker SSH fixture. Inbox previously took 294 seconds, so this PR's browser job is more likely **5-7 minutes**, still subject to the 10-minute cap. No Copilot exclusion is present.

`fork-unit-shard.ts` mirrors upstream's unit file boundary and keeps each file in an isolated process/group. `--shard k/4 --list` prints a dry-run JSON list. If upstream changes its test roots or integration exceptions, update this fork-owned adapter. `fork-browser.ts --list` previews selection. The job shallow-fetches upstream main by URL and compares changed scripts byte-for-byte with that fetched commit; scripts absent upstream and all `fork-*-regression.ts` scripts run. If fetching fails, it logs a warning and runs all changed scripts. Selected scripts missing from the serial list are registered only in the disposable CI checkout and the file is restored on success or failure. No upstream workflow was edited.

**Repository settings completed by the maintainer:** all upstream workflows are disabled, and main's sole required check is **`Fork CI`**, from the GitHub Actions app. `fork-full.yml` is manual-only and calls `./.github/workflows/ci.yml` via `workflow_call`; disabled workflows still run when called. Full checks are optional, not part of the gate. This implementation did not change repository settings.

To undo the settings change, deliberately re-enable upstream workflows (including release/deploy workflows), then replace the fork gate with the project's three upstream required checks. These commands are documentation only; they were not run:

```sh
for file in .github/workflows/*.yml; do
  case "$file" in .github/workflows/fork-*) continue ;; esac
  gh workflow enable "${file##*/}" --repo ricardofelixb/ovis
done
gh api --method PATCH repos/ricardofelixb/ovis/branches/main/protection/required_status_checks --input - <<'JSON'
{"checks":[{"context":"Fast checks","app_id":15368},{"context":"Integration and browser","app_id":15368},{"context":"Native Windows install","app_id":15368}]}
JSON
```

## Local validation

No push, PR, merge, deployment or native-device check was performed. All browser builds ran in `herdr-ci-runner:local`, as its normal user, with only a disposable snapshot and verification-artifact mount. The live checkout and services were not used.

### Scoped commands

The host client command (exit 0, 424 tests across 22 files):

```sh
TMPDIR=$HOME/.cache/ovis-tmp/fork-sep bun test src/fork src/lib/settings.test.ts src/lib/settings.hook.test.ts src/lib/i18n.test.ts src/lib/workBlocks.test.ts src/lib/composerStrip.test.ts src/lib/keyBar.test.ts src/lib/sidebarAgents.test.ts src/conventions.test.ts src/components/AgentSidebar.test.ts src/components/AgentSidebar.test.tsx src/components/ChatTurn.test.ts src/components/ChatView.stoppedTurn.test.ts src/components/TabStrip.appLayout.test.tsx src/components/PaneCanvas.appLayout.test.tsx src/components/AgentMark.test.tsx
```

The isolated CI-image server command (exit 0, 84 tests across 9 files):

```sh
bun run check run bun test --timeout 15000 server/pi-voice.test.ts server/pi-voice.contract.test.ts server/start-screen.test.ts server/start-screen.contract.test.ts server/speech.test.ts server/friends.test.ts server/route-envelope.contract.test.ts server/pull-requests.test.ts server/conventions.test.ts
```

The initial host attempt at the server command was refused by preflight (exit 1: `this needs herdr on PATH (or OVIS_HERDR_BIN)`); it ran no server tests. The same check wrapper was then used successfully in the image. No real herdr or hc session was substituted on the host.

At the initial separation checkpoint, `bun run check fast` and whole-project type checks were skipped under the implementer instructions. The explicitly authorized follow-up below records their later results. Native and full-suite checks were not run. The required browser preparation (`bun install --frozen-lockfile`, `bun run build`) ran successfully inside the image, not on the host.

### Fixture typecheck follow-up

The follow-up reproduced nine type errors with `TMPDIR=$HOME/.cache/ovis-tmp/fork-sep-type-fix bun run typecheck` (exit 1). Chat-presentation fixtures now include `ts: null`, menu fixtures include a Lucide `icon`, and the pinned legacy-settings type excludes newer fork fields without adding them to its runtime record. `speechVoice` remains because that field existed in the pinned version. No app behavior or setting default changed.

After these fixes:

- `TMPDIR=$HOME/.cache/ovis-tmp/fork-sep-type-fix bun run typecheck` exited 0.
- `TMPDIR=$HOME/.cache/ovis-tmp/fork-sep-type-fix bun test src/fork/chat/chatPresentation.test.ts src/fork/tabMenus.test.tsx src/lib/settings.test.ts src/lib/settings.hook.test.ts` exited 0, with 147 passing tests. `src/lib/settings.test.ts` is the only importer of the legacy fixture.
- One `bun run check fast` ran in `herdr-ci-runner:local`, using a `git ls-files` tar, `bun install --frozen-lockfile` and a committed disposable git snapshot, without using the live checkout. It exited 1 after passing workflow syntax, generated-file freshness, typecheck and build. Unit results were 17,434 pass, 11 fail, 57 skip across 985 files.
- The failures were three menu expectations in `src/components/Sidebar.appLayout.test.tsx`, which still expect the now-opt-in `pull-requests` item, and eight tests in `src/lib/useWorktreeBranches.hook.test.ts`, which throw `useSettings needs a SettingsProvider above it`. Each file was rerun alone in the image on both the corrected snapshot and the pre-fix commit `dbb90bb7`; all four commands exited 1 with the same 3/8 failure split. These pre-existing branch failures were reported, not changed in this fixture-only fix. No second full fast run was made.

Logs, the JSON report and the runnable `fast.sh` / `compare.sh` recipes are retained at `$HOME/.cache/ovis-verification/fork-sep-type-fix-e3cd58/`. The fast container used CPUs 0-3 because this Docker daemon exposes only CPUs 0-7; the initial request for CPUs 64-95 was rejected before a container or check started. Browser regressions were not rerun for these fixture-only edits.

### Review follow-up

All three subsequent findings were reproduced and addressed:

1. All eight original `src/lib/useWorktreeBranches.hook.test.ts` cases threw `useSettings needs a SettingsProvider above it`. The polling hook now takes an optional `persistBranches` argument instead of reading settings. Sidebar and CommandPalette pass the cache opt-in explicitly. The upstream polling tests remain unchanged, and `src/fork/worktreeBranches.hook.test.ts` verifies both cache settings without a provider.
2. Three sidebar menu tests still expected the opt-in action under default settings. Those cases now run with `pullRequests` both false and true, including locked agents, so close/delete assertions complete in both modes.
3. The preferences browser script checked only control presence. The new fork-features script actually plays/pauses/resumes/stops fixture speech, loads the desktop iframe and sends quality/keyboard updates, checks out and reopens a demo pull request without duplicating its worktree, and starts/mutes/unmutes/ends Pi voice. Fresh defaults expose none of these actions and make no feature service requests. Pi uses Chromium's fake microphone and a local protocol peer; this does not test OpenAI audio or contact a real PC.

Scoped checks:

- `TMPDIR=$HOME/.cache/ovis-tmp/fork-review-e3cd58 bun test src/lib/useWorktreeBranches.hook.test.ts src/fork/worktreeBranches.hook.test.ts src/components/Sidebar.appLayout.test.tsx src/components/CommandPalette.appLayout.test.tsx src/fork/branchStorage.test.ts src/conventions.test.ts` exited 0: **55 passed**.
- `TMPDIR=$HOME/.cache/ovis-tmp/fork-review-e3cd58 bun test scripts/ci-browser-parallel.test.ts` exited 0: **12 passed**.
- `TMPDIR=$HOME/.cache/ovis-tmp/fork-review-e3cd58 bun node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --noUnusedLocals --skipLibCheck --module ESNext --moduleResolution Bundler --target ES2022 --resolveJsonModule --allowImportingTsExtensions --types bun scripts/fork-features-regression.ts` exited 0. The first invocation needed TypeScript's `--ignoreConfig` flag; the second exposed Bun's extra fetch type member, resolved with the same browser-fetch cast as the existing demo transport.
- `bash -n scripts/ci-browser.sh` and `git diff --check` exited 0.
- A `git ls-files` tar ran as the image's `runner` user in `herdr-ci-runner:local`, with `--entrypoint bash`, CPUs 0-3, a locked install, a disposable git snapshot and `bun run build`. `BROWSER_SCRIPTS=scripts/fork-features-regression.ts,scripts/fork-preferences-regression.ts,scripts/sidebar-branch-line-demo-regression.ts,scripts/sidebar-machine-layout-demo-regression.ts,scripts/palette-machines-demo-regression.ts BROWSER_WORKERS=4 BROWSER_RETRY=0 bun scripts/ci-browser-parallel.ts` exited 0: **5/5 passed**, with no retries. Preparation and all scripts exited 0. Only browser-only type annotations and this record changed after the snapshot.

Recipes, unit logs, browser summary and per-script logs are retained in `$HOME/.cache/ovis-verification/fork-review-e3cd58/`. The temporary root and container were removed after verification. Full fast, whole-project typecheck, integration/native checks and another merge dry run were not repeated for this scoped review follow-up. No live build, service, real session, push or deployment was used.

### Fork CI follow-up

- `TMPDIR=$HOME/.cache/ovis-tmp/fork-ci-e3cd58 bun test scripts/fork-unit-shard.test.ts scripts/fork-browser.test.ts scripts/ci-setup.test.ts scripts/light-runner-workflow.test.ts scripts/workflow-needs.test.ts scripts/ci-browser.test.ts scripts/ci-browser-parallel.test.ts` exited 0: **72 passed** after the upstream-copy filter was added. Initial test-only commits failed with missing-module/export errors; the unit runner also reproduced an incorrectly accepted empty test file before its output check was added.
- `TMPDIR=$HOME/.cache/ovis-tmp/fork-ci-e3cd58 bun node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --noUnusedLocals --skipLibCheck --module ESNext --moduleResolution Bundler --target ES2022 --resolveJsonModule --allowImportingTsExtensions --types bun scripts/fork-unit-shard.ts scripts/fork-unit-shard.test.ts scripts/fork-browser.ts scripts/fork-browser.test.ts` exited 0.
- Actionlint 1.7.12, downloaded and SHA-256 verified, validated `.github/workflows/fork-ci.yml` and `.github/workflows/fork-full.yml`, exit 0. The release archive's SHA-256 was `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`.
- `TMPDIR=$HOME/.cache/ovis-tmp/fork-ci-e3cd58 bun scripts/fork-unit-shard.ts --shard k/4 --list` exited 0 for each `k` in 1, 2, 3, 4. Comparing the concatenated lists with `selectUnitFiles()` proved **988 files, 247 per shard, 988 unique**, with Copilot included. The actual four full shards were not run locally.
- The isolated CI image installed/built successfully, then `bun run check run -- bun scripts/fork-browser.ts` exited 0 with manual-dispatch selection: **2/2 passed in 22.7 seconds**, including cleanup. The separate earlier review batch passed 5/5. The initial PR selector returned 71 scripts. After the requested upstream-copy filter, the final dry run returned the four scripts listed in the CI section; that whole list was not rerun. The job uses `git fetch --depth=1 https://github.com/devswha/ovis.git main`. Host validation used a full `git fetch --no-tags https://github.com/devswha/ovis.git main` to avoid changing the worktrees' shared shallow boundary, then `FORK_BROWSER_EVENT=pull_request FORK_BROWSER_BASE=$(git rev-parse origin/main) FORK_BROWSER_UPSTREAM=$(git rev-parse FETCH_HEAD) bun scripts/fork-browser.ts --list`, exit 0. The fetched upstream commit was `b969ea870244eb83526c5c0644b69aa11c7959db`.
- The initial `HERDR_TEST_MODE=unit bun test server/copilot.test.ts` in the image exited 1, **132 pass / 1 fail**: `keeps a logged binding when only the log's timestamps change` at line 740. The same command on a fresh snapshot of pre-CI commit `081b5562` exited 1 with the same assertion and counts. Copilot was not excluded. The observed-size truncation fix below resolves this blocker.
- `git diff --exit-code 081b5562 -- .github/workflows ':(exclude).github/workflows/fork-*.yml'` and `git diff --check` exited 0: upstream workflow files are unchanged by this follow-up.

The container recipe's aggregate exit was 1 solely because of the explicitly checked Copilot failure; the browser/check-wrapper exit was 0. Logs, scripts and exact validation commands are retained in `$HOME/.cache/ovis-verification/fork-ci-e3cd58/`. No full fast/typecheck, integration/native suite, upstream workflow, repository setting or deployment was run/changed in this CI follow-up.

### Copilot truncation follow-up

The existing timestamp-refresh regression failed before the fix, **132 pass / 1 fail**. A partial append raises `observedSize` without advancing the complete-line checkpoint. Truncating back to that checkpoint inside one filesystem timestamp tick leaves mtime/ctime unchanged. The change detector now compares the file size against both checkpoint sizes, so the next scan creates a fresh generation. The test is unchanged and Copilot remains in Fork CI.

- `TMPDIR=$HOME/.cache/ovis-tmp/fork-copilot-fix bun test server/copilot.test.ts` exited 1 before the fix and 0 on each of three runs afterwards: **133 passed each**.
- `TMPDIR=$HOME/.cache/ovis-tmp/fork-copilot-fix bun scripts/fork-unit-shard.ts --shard k/4 --list` exited 0 for each `k` in 1, 2, 3, 4. The concatenated lists exactly match the unit file list: **988 unique files, 247 per shard, Copilot included exactly once in shard 4**.
- `TMPDIR=$HOME/.cache/ovis-tmp/fork-copilot-fix bun test scripts/fork-unit-shard.test.ts server/conventions.test.ts` exited 0: **25 passed**.
- `TMPDIR=$HOME/.cache/ovis-tmp/fork-copilot-fix bun test src/lib/useWorktreeBranches.hook.test.ts src/components/Sidebar.appLayout.test.tsx` exited 0: **23 passed**, reconfirming the two earlier review fixes. The browser coverage results above remain unchanged.
- `git diff --check` exited 0. Self-audit checked the new invalidation path, security, performance and clarity. No new test, setting, dependency or generated file was needed.

Exact commands and logs are retained in `$HOME/.cache/ovis-verification/fork-copilot-fix/`. Full fast, full unit shards, browser builds, whole-project typecheck, integration/native suites and another merge dry run were not repeated for this two-file fix. The full Fork CI will run on the PR after review.

### Browser commands and results

All batches used the same container recipe:

```sh
mkdir -p "$HOME/.cache/ovis-tmp/fork-sep"
git ls-files -z | tar --null -T - -cf "$HOME/.cache/ovis-tmp/fork-sep/snapshot.tar"
docker run --entrypoint bash -v "$HOME/.cache/ovis-tmp/fork-sep:/input" herdr-ci-runner:local /input/<batch>.sh
```

Inside the container each batch unpacks the tar, installs from the lockfile, initializes a disposable git snapshot, builds, then runs:

```sh
BROWSER_SCRIPTS=<comma-separated scripts> BROWSER_WORKERS=4 BROWSER_RETRY=0 CHECK_DIR=/input/<batch>-results bun scripts/ci-browser-parallel.ts
```

The standalone QA scripts not present in upstream's serial list were registered only in the disposable snapshot. The initial keyboard batch hit that selector guard (exit 1: `Not in scripts/ci-browser.sh: scripts/keyboard-viewport-demo-regression.ts`), then was rerun with the same temporary registration. The SSH-profile QA was not run: it requires its external SSH fixture.

| Batch | Exact inner selector / command | Exit and result |
| --- | --- | --- |
| Restored upstream scripts and feature regressions | `BROWSER_SCRIPTS="$(grep -v herdr-profiles-ssh-qa /input/restored-scripts.txt \| paste -sd, -),scripts/fork-preferences-regression.ts,scripts/chat-size-regression.ts,scripts/composer-fit-demo-regression.ts,scripts/header-context-demo-regression.ts,scripts/chat-tool-paths-demo-regression.ts,scripts/chat-working-line-demo-regression.ts" BROWSER_WORKERS=4 BROWSER_RETRY=0 CHECK_DIR=/input/restored-results bun scripts/ci-browser-parallel.ts` | 1: 59/68 passed; failures were either fixed and rerun below or reproduced on the starting commit. |
| Default ordering, send-follow and key bar | `BROWSER_SCRIPTS=scripts/sidebar-filter-demo-regression.ts,scripts/chat-local-send-follow-demo-regression.ts,scripts/fork-preferences-regression.ts,scripts/key-bar-customization-demo-regression.ts BROWSER_WORKERS=4 BROWSER_RETRY=0 CHECK_DIR=/input/defaults-final-results bun scripts/ci-browser-parallel.ts` | 0: 4/4 passed. |
| Baseline comparison, current result | `BROWSER_SCRIPTS=scripts/agent-skill-menu-demo-regression.ts,scripts/inbox-mode-demo-regression.ts,scripts/machines-browser-qa.ts,scripts/pane-lifetime-regression.ts,scripts/sidebar-activity-demo-regression.ts,scripts/sidebar-peek-demo-regression.ts,scripts/ui-regression.ts,scripts/update-browser-qa.ts BROWSER_WORKERS=4 BROWSER_RETRY=0 CHECK_DIR=/input/current-final-results bun scripts/ci-browser-parallel.ts` | 1: sidebar activity passed; pane/menu, skill helper and keyboard-hook regressions were fixed afterwards. |
| Baseline comparison, `da5afc54` | Same eight-script selector with `CHECK_DIR=/input/base-final-results`, unpacking a tar of `da5afc54`, not the worktree | 1: 4/8 passed; the same four unrelated failures below. |
| Final pane/menu and restored helpers | `BROWSER_SCRIPTS=scripts/pane-lifetime-regression.ts,scripts/agent-skill-menu-demo-regression.ts,scripts/composer-fit-demo-regression.ts,scripts/fork-preferences-regression.ts BROWSER_WORKERS=4 BROWSER_RETRY=0 CHECK_DIR=/input/last-results bun scripts/ci-browser-parallel.ts` | 0: 4/4 passed. |
| Final keyboard/defaults | `BROWSER_SCRIPTS=scripts/inbox-mode-demo-regression.ts,scripts/phone-glass-header-demo-regression.ts,scripts/keyboard-viewport-demo-regression.ts,scripts/fork-preferences-regression.ts BROWSER_WORKERS=4 BROWSER_RETRY=0 CHECK_DIR=/input/keyboard-results bun scripts/ci-browser-parallel.ts` | 0: 4/4 passed (inbox 294.3s, phone header 18.6s, viewport 9.0s, fork preferences 15.8s). |

Red/green checks caught and fixed the default key bar, context strip, accepted-send following, sidebar tab-name ordering and live refresh, compact tab menus, a remaining fork-only skill-menu helper, and keyboard-aware cramped sizing. For the latter, a filtered copy of the original inbox test reproduced `{"short":52,"controls":[]}`; changing only the cramped hook to upstream's media-query hook passed. Replacing ChatView or ChatTimeline alone did not. The normal default now uses the upstream hook; migrated devices retain the old keyboard-aware hook. The fork regression checks both sides of a focused 900px-to-650px keyboard resize, not just the settings flag.

Four browser checks remain blocked independently of this refactor. The same eight-script command was run against `da5afc54`; no unrelated fixes or weakened assertions were added:

| Check | Starting commit and current failure |
| --- | --- |
| `scripts/machines-browser-qa.ts` | `TypeError: path must be a string or a file descriptor`, `ERR_INVALID_ARG_TYPE`, at the standalone fixture-path setup. |
| `scripts/update-browser-qa.ts` | `Updated process never became active`. |
| `scripts/ui-regression.ts` | `Start uses the folder Browse is showing`: `~/ci-tmp/.../made-here` versus `/home/runner/ci-tmp/.../made-here`. |
| `scripts/sidebar-peek-demo-regression.ts` | `hover: Timeout 30000ms exceeded` on `.agent-list .agent-item[data-pane="w1C:p1"] .agent-select`, which is not visible. |

Validation artifacts, the runnable container scripts, and `check-command-history.md` (the exact check/preparation commands and their tool exit codes, including red checks) are retained outside the temporary test root at `$HOME/.cache/ovis-verification/fork-sep-e3cd58/`. The temporary test root is removed after verification. The report is evidence of scoped checks, not a claim that the full suite is green.

### Merge dry run

`git merge --no-commit --no-ff upstream/main` exited **0**, with no conflicts, against upstream `0a91d1438b1979ac6bb9c5bd7705e60542ad47a1`. `git merge --abort` exited **0** and restored the job branch; nothing was merged or pushed. `git diff --check` exited **0**. Generated files, tracked `.rej` files and fixture recordings have no diff from `da5afc54`.

### Self-audit

- Correctness: checked upstream defaults, migration precedence, explicit false/reset values, hook ordering, route fallthrough and WebSocket upgrades. Restored-file inventory was checked byte-for-byte.
- Security: no new dependencies or credentials. Authentication, origin and observe guards retain their route order; device revocation still closes screen/voice sockets. UI preferences are not access controls. No automatic input, focus or takeover was introduced.
- Performance: fork listeners/polling are disabled with their features. No new transcript rebuild, PTY ownership or cache was added.
- Clarity/scope: small compatibility facades are intentional; moved large modules were not gratuitously rewritten. Pure helpers and optional controls have focused unit or browser coverage. No Bigpowers plan/state files were created. The skill's spec-output and project-wide-check requirements are superseded by this task's explicit instructions.
- CI follow-up: read-only token permissions, pinned actions, no persisted checkout credentials or new dependencies. Shards preserve per-file process isolation and failure exits. Browser selection tests cover PR/push bases, upstream byte comparisons, missing scripts, fetch fallback and restoration of temporary registration. Copilot remains visible; it was not removed to make the gate green.
- The tempting shortcut was to treat all failed browsers as baseline failures. The baseline comparison instead identified the new menu/helper/keyboard failures, which were fixed; only the four reproduced failures above remain blocked.
