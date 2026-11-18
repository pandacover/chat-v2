#!/usr/bin/env bash
# CI (macOS runners): checks a packaged chat-v2.app is signed as it must be.
#
#   bash scripts/ci-mac-verify.sh <path/to/chat-v2.app> self-signed|adhoc arm64|x64
#
# self-signed (releases): signed with the release certificate, and its designated requirement is
# exactly `identifier "com.pandacover.chatv2" and certificate root|leaf = H"<build/chat-v2-signing.cer's
# SHA-1>"`: the same for every version, which is what keeps permissions and lets Squirrel.Mac
# install updates. adhoc (pull requests): ad-hoc signed, but signed (electron-builder can skip
# signing without failing, which once shipped an app that kept asking for the microphone).
# Both: the identifier, the microphone entitlement and usage text, and the Claude Code binary for
# the app's processor (outside the asar, see electron-builder.yml) signed and starting. The binary
# is checked on its own: --deep seals a bare executable outside Contents/MacOS as a resource
# without checking its signature.
set -euo pipefail
app="$1"
mode="$2"
arch="$3"
claude="$app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$arch/claude"

codesign --verify --deep --strict --verbose=2 "$app"
info="$(codesign -dv --verbose=4 "$app" 2>&1)"
echo "$info"
grep -qx 'Identifier=com.pandacover.chatv2' <<<"$info"
codesign -d --entitlements - "$app" 2>&1 | grep -q com.apple.security.device.audio-input
plutil -p "$app/Contents/Info.plist" | grep -q NSMicrophoneUsageDescription
codesign --verify --strict --verbose=2 "$claude"
claude_info="$(codesign -dv --verbose=4 "$claude" 2>&1)"
# Only this processor's binary ships.
other=$([ "$arch" = arm64 ] && echo x64 || echo arm64)
if [ -e "$app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$other" ]; then
  echo "::error::$app also carries the $other Claude Code binary"
  exit 1
fi

case "$mode" in
  self-signed)
    sha1="$(openssl x509 -inform DER -in build/chat-v2-signing.cer -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')"
    grep -qx 'Authority=chat-v2 Code Signing' <<<"$info"
    grep -qx 'Authority=chat-v2 Code Signing' <<<"$claude_info"
    dr="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
    echo "Designated requirement: $dr"
    if ! [[ "$dr" =~ ^identifier\ \"com\.pandacover\.chatv2\"\ and\ certificate\ (root|leaf)\ =\ H\"$sha1\"$ ]]; then
      echo "::error::$app's designated requirement isn't the identifier and the release certificate ($sha1): $dr"
      exit 1
    fi
    ;;
  adhoc)
    grep -q 'Signature=adhoc' <<<"$info"
    grep -q 'Signature=adhoc' <<<"$claude_info"
    ;;
  *)
    echo "Unknown mode: $mode (self-signed or adhoc)" >&2
    exit 2
    ;;
esac

# The Intel binary runs on Apple silicon runners through Rosetta.
lipo "$claude" -verify_arch "$([ "$arch" = arm64 ] && echo arm64 || echo x86_64)"
"$claude" --version
echo "OK: $app ($mode, $arch)"
