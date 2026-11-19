### Fixed
- The setup guide's Done step says "This address can't get alerts." on a plain-http address, as the
  alerts step does, instead of "Alerts off".
- A Send test that never got the PC's answer (the network, a restart) is no longer kept as a failed
  confirmation that marks this device's alerts off; only the PC saying the push cannot reach this
  subscription is.
