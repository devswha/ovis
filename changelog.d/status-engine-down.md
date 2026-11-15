### Changed
- `ovis status` tells a stopped engine from a stopped server: while Ovis answers and herdr or
  herdr-core does not, it says `engine-down`, names the engine and gives the server's reason,
  instead of `down`, also on a server in the machine profile. A server whose process still runs but does not answer says so too. The
  `running` line is unchanged.
- The command line's instructions no longer send a person only to this PC's screen: revoking a
  device names Settings → Devices and PCs on this PC or on a device of yours that drives it,
  and turning the relay on names `ovis link --code`. Its usage text lists only this PC's commands.
- `ovis add` and `ovis link --code` name the app the server pairs with (`OVIS_RELAY_APP_URL`), the
  one its QR codes open, instead of always app.ovis.sh.
