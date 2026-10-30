# Pi Voice experiment: public dependency boundaries

This branch contains an isolated **Pi routing experiment (no audio)**. It does not add a Voice-call feature to Ovis. The [CLI README](../../experiments/pi-voice-routing/README.md) documents fake mode and exact local routing.

[Discussion #2298](https://github.com/devswha/ovis/discussions/2298) provides context, not maintainer approval. An upstream feature still requires the agreement described in CONTRIBUTING.md.

## Scope

The branch starts at public Ovis commit `421689b7c978c91488118b649bf5174b840ac961`. All additions are under `experiments/pi-voice-routing/` and this document. Application code, root dependencies, native projects and updater behavior are unchanged.

The CLI discovers intercom-connected Pi sessions. Each selection pins a full session ID plus endpoint epoch and creates a fresh human endpoint. Users send typed text explicitly and read replies. Names and pane focus never determine delivery. Unknown delivery outcomes are not retried. End disconnects the human endpoint without cancelling Pi work already dispatched.

The source is new work on the public base. The isolated lockfile refers to exact public artifacts without committing dependency binaries or archives. Audio and native integration are out of scope and unvalidated.

## Dependency, license and reproducibility matrix

Public availability does not imply a successful runtime or device test.

| Component | Public artifact and license | Current evidence and limits |
| --- | --- | --- |
| Ovis base | Public `devswha/ovis` at `421689b7c978c91488118b649bf5174b840ac961`; MIT | Application remains unchanged. |
| Pi runtime | Public `earendil-works/pi`; npm `@earendil-works/pi-coding-agent@1.4.0`; MIT; Node `>=22.19.0` | Available candidate, not a verified compatible runtime/extension pair. No installed operator runtime is included or treated as the public dependency. |
| Intercom GitHub main | Public `odfalik/pi-intercom` at `30dcbdd134e3b3236e50e02c31d25093360fe3fc`, manifest version `0.10.1`; MIT | This unselected package differs from the standalone client artifact. |
| Intercom registry release | Public npm `pi-intercom@0.18.1`; MIT | Downloaded archive matched registry integrity. It lacks `client.ts`, `dist/client.js` and a `./client` export. It does not supply this CLI's API. Its other uses are outside this audit. |
| Selected standalone intercom artifact | Public `Strand-AI/pi-voice` commit `900801dc48323e0f10151af68e0e5071772b69eb`, `vendor/pi-intercom/pi-intercom-0.17.3.tgz`; MIT, Nico Bailon | SHA-256 `ffe3d8921aea5edccb80e48285d1f713042ec80c7141e6e7b330055630555616`. Source, generated client and declarations are present. Real broker/synthetic-peer routing tested. Exact-send and reject-offline capability negotiation is performed by the public client. |
| Selected dependency closure | Isolated `package-lock.json`; 30 public archives, all MIT | Each archive's package metadata and locked SHA-512 integrity checked, including optional platform packages. License texts retained in the [notice file](../../experiments/pi-voice-routing/THIRD_PARTY_NOTICES.md). No binaries redistributed. |
| Existing Ovis clip dictation | Existing `shared/voice.ts`, `server/voice.ts` and recording UI; MIT plus provider terms | Short-clip transcription, not a live-call transport. Unchanged. |

The selected archive's exact public URL, SHA-512 integrity, attribution and transitive notices are in [THIRD_PARTY_NOTICES.md](../../experiments/pi-voice-routing/THIRD_PARTY_NOTICES.md). A greater registry version is not a substitute for the required standalone export.

## Validation and remaining uncertainty

The CLI's unit tests cover exact selection, stale or duplicate identity, disconnected/replaced targets, unknown delivery, callback fencing, concurrent selection, input size and terminal control filtering. The integration test uses the actual public client and broker with synthetic peers in a temporary profile. It does not load a Pi extension into a real runtime.

A fresh public Pi runtime/extension installation, live-agent execution, Linux/Windows smoke tests, audio and native device behavior remain unverified. The application integration/browser/Windows lanes do not test this separate CLI. An npm advisory audit reported no known dependency vulnerabilities at validation time. Source/security review remains a separate gate.

## Maintainer questions

- Should Pi-specific discovery and exact routing remain a companion package, or would an extension boundary belong in Ovis?
- Does any small part of the routing contract belong in core, independent of Pi and the separate audio runtime?
- Should authenticated device actions and native call lifecycle stay outside Ovis? This branch makes neither decision.

The experimental fork lets maintainers inspect these boundaries before deciding what, if anything, belongs upstream.
