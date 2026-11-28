### Added
- A PC on a relay of its own that also names an app of its own (`OVIS_RELAY_APP_URL`) now shows a
  code to type beside the QR code, held on that relay, and says which app to type it in. The app
  must be built with `OVIS_RELAY_URL` set to that relay, so it looks typed codes up there: a phone's
  Home Screen app, which cannot open a QR link, then pairs with the code. Such a PC can also be
  added from another PC over Tailscale, which looks its code up on its relay.

### Changed
- Self-hosting a relay and an app: rebuild the app with `OVIS_RELAY_URL` set to your relay. An app
  built without it looks typed codes up on Ovis's relay, so it finds no PC for the code your PC now
  shows; the QR code still pairs.
