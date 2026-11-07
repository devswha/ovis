# Dependencies

Every artifact below is public, and the last column says how much of each has actually been tested here.

| Component | Public artifact and license | Tested here |
| --- | --- | --- |
| Standalone intercom client (selected) | `vendor/pi-intercom/pi-intercom-0.17.3.tgz` in public `Strand-AI/pi-voice` at commit `900801dc48323e0f10151af68e0e5071772b69eb`. MIT, Nico Bailon. | SHA-256 `ffe3d8921aea5edccb80e48285d1f713042ec80c7141e6e7b330055630555616`. The archive contains the source, the generated `pi-intercom/client` export and its type declarations. The integration test runs its real broker and client with synthetic peers. |
| Resolved closure | `package-lock.json` in this folder: 30 public archives, all MIT | Each archive matched its locked SHA-512 integrity and declares MIT. License texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No archive or binary is committed. |
| Intercom registry release | npm `pi-intercom@0.18.1` (current `latest`). MIT. | This CLI cannot use it: the archive has no `client.ts`, `dist/client.js` or `./client` export. Its other uses are outside this audit. |
| Intercom GitHub source | `odfalik/pi-intercom` at `30dcbdd134e3b3236e50e02c31d25093360fe3fc`, manifest version `0.10.1`. MIT. | Left unused because it predates the standalone client. |
| Pi runtime | npm `@earendil-works/pi-coding-agent@1.4.0` from `earendil-works/pi`. MIT, Node `>=22.19.0`. | Untested so far. Running real Pi sessions with the matching extension is the next step. |

Pick the intercom package by its exports, not by version number: a higher registry version is not a drop-in replacement here.

## Not covered

Audio capture or playback, provider sessions, native apps and devices are out of scope and unvalidated. The CLI has run on macOS only. A fresh Pi runtime with the extension loaded, real agents, Linux and Windows are untested.
