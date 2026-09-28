#!/bin/bash
# Rebuild the Spark debug APK.
#
# Sandbox notes (learned the hard way):
#  - the Gradle daemon inherits the sandboxed context, so always use --no-daemon
#  - the JVM does NOT read HTTPS_PROXY; when a proxy is needed it has to go through
#    systemProp.* in $GRADLE_USER_HOME/gradle.properties
#  - a foreground run gets SIGTERM'd after a few minutes; run this in the background
#  - the wrapper jar resolves fine, but the distribution itself was fetched by hand into
#    ~/gradle-dist, so GRADLE_USER_HOME is pinned to the cache that already holds every
#    dependency. Changing it means re-downloading the whole toolchain.
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export JAVA_HOME="${JAVA_HOME:-/Users/michaelhwang/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/tmp/gradle-home}"

GRADLE="${GRADLE:-$HOME/gradle-dist/gradle-8.14.3/bin/gradle}"
if [ ! -x "$GRADLE" ]; then
  echo "gradle distribution not found at $GRADLE" >&2
  echo "set GRADLE=/path/to/gradle, or download gradle-8.14.3-all.zip into ~/gradle-dist" >&2
  exit 1
fi

# Copy www/ into the Android project so the APK ships the current web layer.
(cd "$ROOT" && ./node_modules/.bin/cap copy android)

# Stale build dirs inside node_modules break incremental builds with
# "Unable to delete file ... aar-metadata.properties". Nuke them first.
python3 - "$ROOT" <<'PY' || true
import glob, os, shutil, sys
root = sys.argv[1]
targets = set(glob.glob(os.path.join(root, 'node_modules', '@capacitor', '**', 'build'), recursive=True))
for t in sorted(targets):
    if os.path.isdir(t):
        shutil.rmtree(t, ignore_errors=True)
        print('cleaned', os.path.relpath(t, root))
PY

cd "$ROOT/android"
"$GRADLE" --stop >/dev/null 2>&1 || true

"$GRADLE" assembleDebug --console=plain --no-daemon "$@"
