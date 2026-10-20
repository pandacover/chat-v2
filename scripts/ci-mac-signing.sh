#!/usr/bin/env bash
# CI (macOS runners): makes the release certificate (scripts/make-mac-cert.sh) available to
# codesign, so `electron-builder -c.mac.identity="chat-v2 Code Signing"` signs with it.
#
# Needs MAC_CERT_P12 (the .p12, base64) and MAC_CERT_PASSWORD from the repository's secrets, and
# the public certificate at build/chat-v2-signing.cer. electron-builder only uses identities that
# `security find-identity -v` lists, which leaves out untrusted ones, so the certificate is also
# trusted for code signing on the runner (only there: users never need to trust it).
set -euo pipefail

if [ -z "${MAC_CERT_P12:-}" ] || [ -z "${MAC_CERT_PASSWORD:-}" ]; then
  echo "::error::MAC_CERT_P12 and MAC_CERT_PASSWORD aren't set. Make the certificate with scripts/make-mac-cert.sh and add them as repository secrets."
  exit 1
fi
cer=build/chat-v2-signing.cer
tmp="${RUNNER_TEMP:-$(mktemp -d)}"
p12="$tmp/chat-v2-signing.p12"
printf '%s' "$MAC_CERT_P12" | base64 --decode >"$p12"

sha1_of() { openssl x509 -noout -fingerprint -sha1 "$@" | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'; }
expected="$(sha1_of -inform DER -in "$cer")"
# The secret must hold the repository's certificate: another one would sign a different app.
got="$(openssl pkcs12 -in "$p12" -passin env:MAC_CERT_PASSWORD -nokeys -clcerts | sha1_of)"
if [ "$got" != "$expected" ]; then
  echo "::error::MAC_CERT_P12 holds certificate $got, but build/chat-v2-signing.cer is $expected."
  exit 1
fi

keychain="$tmp/chat-v2-signing.keychain-db"
keychain_password="$(uuidgen)"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$p12" -k "$keychain" -P "$MAC_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
# Lets codesign use the key without a prompt.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
rm -f "$p12"

# Trusted for code signing in the admin trust settings (no prompt under sudo on the runners).
sudo security authorizationdb write com.apple.trust-settings.admin allow >/dev/null 2>&1 || true
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$cer"

if ! security find-identity -v -p codesigning | grep -q '"chat-v2 Code Signing"'; then
  echo "::error::The certificate was imported but codesign doesn't list it as a valid identity."
  security find-identity -p codesigning
  exit 1
fi
security find-identity -v -p codesigning
echo "MAC_CERT_SHA1=$expected" >>"${GITHUB_ENV:-/dev/null}"
