### Added
- While the relay is on, a PC also takes a paired device's relay channel directly on its private
  network addresses, so a phone at home can skip the relay once the app supports it. The same
  end-to-end encryption and device key are used; nothing pairs there, and the PC tells only
  signed-in devices where to find it. Turn it off with `POST /api/relay/direct`.
