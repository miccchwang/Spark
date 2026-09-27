#!/bin/bash
# Rebuild the Spark debug APK.
#
# Sandbox notes (learned the hard way):
#  - the Gradle daemon inherits the sandboxed context, so always use --no-daemon
#  - the JVM does NOT read HTTPS_PROXY, it needs systemProp.* in gradle.properties
#  - a foreground run gets SIGTERM'd after a few minutes; run this in the background
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export JAVA_HOME="/Users/michaelhwang/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
export ANDROID_HOME="$HOME/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

PROXY_PORT="${PROXY_PORT:-55509}"
export HTTPS_PROXY="http://127.0.0.1:${PROXY_PORT}"
export HTTP_PROXY="http://127.0.0.1:${PROXY_PORT}"

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
./gradlew --stop >/dev/null 2>&1 || true

./gradlew assembleDebug --no-daemon \
  -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort="$PROXY_PORT" \
  -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort="$PROXY_PORT" \
  -Dhttp.nonProxyHosts=localhost \
  -Dorg.gradle.jvmargs="-Xmx1536m -Djdk.tls.client.protocols=TLSv1.2" \
  "$@"
