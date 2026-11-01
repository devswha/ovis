# Pi routing experiment (no audio)

A terminal CLI for the routing half of a Pi Voice experiment. It lists intercom-connected Pi sessions. You pick one exact session ID and endpoint epoch, then send typed messages and read the replies. Nothing here records or plays audio.

This folder is self-contained. It has its own `package.json` and lockfile, and Ovis's app, root dependencies and CI do not use it. Background is in [Ovis discussion #2298](https://github.com/devswha/ovis/discussions/2298).

## Run fake mode

Node.js 22.19 or newer is required. From this directory:

```sh
npm run fake
```

Fake mode runs without installing dependencies. It does not import intercom code or open sockets. Enter:

```text
list
select 1
send hello
end
quit
```

The reply is synthetic. This does not test a Pi runtime, audio, or native behavior.

## Test the public broker dependency

```sh
npm ci --ignore-scripts
npm test
npm run test:integration
```

Installation uses the exact public standalone intercom archive, not npm `pi-intercom@latest`. The lockfile pins the dependency closure. Install scripts are not needed for this experiment. Integration testing starts an owned, foreground broker in a temporary profile and uses synthetic peers, not your Pi sessions or herdr state. It stops that broker and removes its profile afterwards.

## Local Pi mode

Local mode requires a running, compatible Pi intercom broker and Pi sessions with the matching intercom extension loaded. It never starts, updates, replaces or reconnects a broker. It refuses brokers that lack exact-send and reject-offline-delivery capabilities.

Use an isolated Pi profile for testing. Set `PI_CODING_AGENT_DIR` consistently for the Pi processes and this CLI. Set the same `PI_INTERCOM_SCOPE_ID` if you use scopes. Configure the extension from the same public artifact identified in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Do not assume a registry release with a greater version contains the same API.

```sh
npm run local
```

Use `list` and inspect the full ID and epoch before `select <row>`. `send <text>` dispatches a real message and can trigger tools or paid model work in the selected Pi session. Opening local mode or selecting a target does not send a task. There is no provider credential or microphone in this CLI.

The current integration test proves standalone-client/broker routing with synthetic peers. A fresh public Pi runtime plus extension installation has not been validated. The public runtime `@earendil-works/pi-coding-agent@1.4.0` is available, but compatibility with this extension still needs testing. Real-agent, Windows and Linux smoke tests remain unrun.

## Delivery and privacy

- A fresh human endpoint belongs to each explicit selection. Labels, names and pane focus never determine delivery.
- Send rechecks the live roster. The broker then enforces exact ID plus epoch. A changed or disconnected target requires a new selection.
- A delivery receipt describes transport delivery, not agent execution or success. Replies from the selected endpoint appear without per-request correlation.
- Unknown delivery outcomes block more sends for that selection. Nothing is retried, queued for replay, or resent automatically. Inspect the target before choosing to submit another request.
- End fences local callbacks and disconnects the human endpoint. It does not cancel Pi work already dispatched.
- This CLI does not write a transcript. Text and session identifiers appear in the terminal and may remain in terminal scrollback. Pi and intercom may store messages under their own policies.
- Incoming terminal output is bounded and control characters are removed. Treat reply content as untrusted advice, not executable commands.

## Boundaries

Audio and native integration are out of scope and unvalidated. Ovis's existing short-clip dictation is unchanged. The CLI works with Pi and pi-intercom only.

[DEPENDENCIES.md](DEPENDENCIES.md) lists each public artifact this folder uses, with its license and what has been tested.
