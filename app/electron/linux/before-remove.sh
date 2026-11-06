#!/bin/bash
# The .deb's prerm. Ovis starts its own herdr-core server (HC_SESSION=ovis) from a copy in the
# user's data folder, and that server outlives the app on purpose. Once the package is gone nothing
# can reach it any more, so removing the package stops it, for the user who removed it (sudo or
# pkexec say who). Never on an upgrade: the next version takes the same server over. Best effort:
# whatever happens here, the removal goes on.

[ "$1" = remove ] || exit 0

uid="${PKEXEC_UID:-${SUDO_UID:-}}"
case "$uid" in '' | 0 | *[!0-9]*) exit 0 ;; esac
entry="$(getent passwd "$uid")" || exit 0
user="$(printf '%s' "$entry" | cut -d: -f1)"
home="$(printf '%s' "$entry" | cut -d: -f6)"
hc="$home/.config/Ovis/bin/herdr-core"
[ -n "$user" ] && [ -x "$hc" ] || exit 0

runtime="/run/user/$uid"
[ -d "$runtime" ] || runtime=""
command -v runuser >/dev/null 2>&1 || exit 0
timeout 20 runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" PATH=/usr/local/bin:/usr/bin:/bin \
  ${runtime:+XDG_RUNTIME_DIR="$runtime"} HC_SESSION=ovis "$hc" server stop >/dev/null 2>&1 \
  && echo "Ovis: the herdr-core server it started for $user is stopped." \
  || echo "Ovis: could not stop the herdr-core server it started for $user."
exit 0
