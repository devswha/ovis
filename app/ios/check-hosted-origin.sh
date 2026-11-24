#!/bin/sh
# Fails the App target's build ("Check the hosted origin" phase) when the pages copied into it by `bun x cap sync ios`
# name another hosted origin than OVIS_APP_ORIGIN, the one the native code trusts (OvisAppOrigin), or were built for
# another first screen than OVIS_APP_HOME, the one it opens (OvisAppHome): `bun run build:web` for the other platform's
# build rewrites hosted-origin.generated.xcconfig without copying pages here.
# It also fails a build whose shell is not where OVIS_APP_SHELL (OvisAppShell) says: `bundled` needs the shell that run
# packed into app/bundled-shell (which the "Carry the shell" phase copies into the app, carry-shell.sh), `hosted` none
# there; and an archive of the store app (Product > Archive, what an App Store upload is made from) that would load
# the shell from the network, which only a test build does.
# Usage: check-hosted-origin.sh <the copied shell.js> <OVIS_APP_ORIGIN> <OVIS_APP_HOME> <OVIS_APP_SHELL>
#   <app/bundled-shell> <ACTION> <PRODUCT_BUNDLE_IDENTIFIER>
pages=$(sed -n 's/^export const APP_ORIGIN = "\([^"]*\)";$/\1/p' "$1" 2>/dev/null)
if [ "$pages" != "$2" ]; then
  echo "error: $1 names ${pages:-no hosted origin} and OVIS_APP_ORIGIN is ${2:-empty}: run bun run build:web with the OVIS_APP_URL this build is for, then bun x cap sync ios"
  exit 1
fi
home=$(sed -n 's/^export const APP_HOME = "\([^"]*\)";$/\1/p' "$1" 2>/dev/null)
if [ "$home" != "$3" ]; then
  echo "error: $1 was built for ${home:+the }${home:-no} first screen and OVIS_APP_HOME is ${3:-empty}: run bun run build:web with the OVIS_APP_HOME this build is for, then bun x cap sync ios"
  exit 1
fi
case "$4" in
  bundled)
    for file in shell/index.html shell/render.html shell-policy.json; do
      if [ ! -f "$5/$file" ]; then
        echo "error: OVIS_APP_SHELL is bundled and $5 holds no $file: run bun run build:web (OVIS_APP_SHELL_DIR names the dist-shell to carry, else it builds one from this checkout). OVIS_APP_SHELL=hosted loads the shell from the network instead, never in a store build"
        exit 1
      fi
    done
    # the shell is served at the hosted origin's host on the app's own scheme, where localhost is the app's own pages
    case "$2" in
      https://localhost|https://localhost:*)
        echo "error: OVIS_APP_SHELL is bundled and OVIS_APP_ORIGIN is $2: the app's own pages are at that host, so the shell cannot be served there. Build this origin with OVIS_APP_SHELL=hosted"
        exit 1;;
    esac;;
  hosted)
    if [ -e "$5" ]; then
      echo "error: OVIS_APP_SHELL is hosted and $5 still holds a shell from another run: run bun run build:web with the OVIS_APP_SHELL this build is for"
      exit 1
    fi
    if [ "$6" = "install" ] && [ "$7" = "sh.ovis.app" ]; then
      echo "error: this archive of sh.ovis.app would load the shell from the network (OVIS_APP_SHELL=hosted, the default with OVIS_APP_URL), which the store app never does. Run bun run build:web with OVIS_APP_SHELL=bundled (OVIS_APP_SHELL_DIR names the release's dist-shell), then bun x cap sync ios; a test build with another bundle ID may stay hosted"
      exit 1
    fi;;
  *)
    echo "error: OVIS_APP_SHELL is ${4:-empty}: it is bundled or hosted (app/ios/hosted-origin.xcconfig)"
    exit 1;;
esac
