# Moving herdr's session to herdr-core

Settings > About offers "Move everything to herdr-core" on a PC whose Ovis serves herdr's TUI, has
herdr-core, can switch its runtime (Linux and macOS, started by Ovis's launcher) and has no Herdr app
installed (the app arranges a core in a document Ovis never writes). It moves all of herdr's session
or nothing.

## What moves

| herdr | herdr-core |
|---|---|
| Workspaces, tabs, their order and names | the same, as `herdr.space` / `herdr.tab` / `ovis.*` labels and the `ovis-layout` document ([herdr-core-layout.md](herdr-core-layout.md)) |
| Splits and their ratios | the same tree, rebuilt from herdr's `split_<n>_<path>` ids |
| An idle agent whose conversation this PC's stores list | the agent, reopened on that conversation (the commands Earlier sessions uses) |
| An idle agent whose conversation cannot be told | the agent, started new in the same folder |
| A shell with nothing running in front | a new shell in the same folder |

Scrollback, programs running in a shell and anything kept only in a process's memory do not move.
One conversation reopens in one pane only.

## What makes it wait

An agent at work, waiting for an answer, or with a message Ovis still holds for it; a shell whose
foreground process is not the shell (or whose processes herdr cannot tell): the move waits and goes
by itself once none is left, until it is cancelled. An agent with text typed in its input line, or
one Ovis has no exit command for, waits for the person to end it.

## How it runs

1. Each agent is typed its own exit command (`/exit` or `/quit`, from its own command list) only
   while herdr still says it is idle, and must be gone within 10 s. If it takes work instead, nothing
   more is typed into it and the move rolls back.
2. Everything is built on herdr-core through an adapter of the move's own, on a socket in the state
   folder, while the server still serves herdr. Every terminal it starts carries `ovis.move=<id>`.
3. The agents start there; then the runtime switches to herdr-core.

herdr is never closed or changed. On any failure before the switch is taken, every terminal labeled
with the move is ended, then each agent ended in herdr starts again in its own pane on its own
conversation, unless the pane has an agent again or the conversation runs elsewhere (the result
names those). Each step is written to `runtime-move-<port>.json` in the state folder before it is
taken; a server that stops mid-move leaves the move `interrupted`, and nothing is retried by itself.

To go back after a move, switch the runtime to herdr in Settings: herdr's session is where it was.
