#!/usr/bin/env bash
# Makes the one self-signed code-signing certificate every macOS release is signed with
# (electron-builder.yml, .github/workflows/release.yml). Run it once, ever.
#
#   bash scripts/make-mac-cert.sh [output folder, default ~/chat-v2-signing]
#
# Why one certificate for good: macOS keys an app's privacy permissions (Screen Recording,
# Accessibility, Automation) and Squirrel.Mac keys its in-place updates to the app's designated
# requirement, which for this certificate is `identifier "com.pandacover.chatv2" and certificate
# root = H"<this certificate's SHA-1>"`. Every build signed with it satisfies every other's. A new
# certificate is a new app to macOS: permissions reset for everyone and installed apps refuse the
# update. So keep a backup of the .p12 and its password somewhere safe (a password manager), and
# never commit them. The .cer is public and goes in the repository (build/chat-v2-signing.cer).
#
# Writes into the output folder, which must be outside the repository:
#   chat-v2-signing.p12       certificate and private key (SECRET), for the MAC_CERT_P12 secret
#   chat-v2-signing.password  the .p12's password (SECRET), for the MAC_CERT_PASSWORD secret
#   chat-v2-signing.cer       the certificate alone (public, DER)
set -euo pipefail

NAME='chat-v2 Code Signing'
DAYS=3650
out="${1:-$HOME/chat-v2-signing}"
repo="$(cd "$(dirname "$0")/.." && pwd -P)"

mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
case "$out/" in
  "$repo"/*) echo "Refusing to write the certificate inside the repository ($repo). Pick a folder outside it." >&2; exit 1 ;;
esac
if [ -e "$out/chat-v2-signing.p12" ]; then
  echo "$out/chat-v2-signing.p12 already exists. Replacing it would reset every user's permissions; not overwriting." >&2
  exit 1
fi

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat >"$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $NAME
O = pandacover
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

password="$(openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-32)"
openssl req -x509 -newkey rsa:3072 -sha256 -days "$DAYS" -nodes -config "$work/cert.cnf" -keyout "$work/key.pem" -out "$work/cert.pem"
# macOS's `security import` reads only the older PKCS#12 encryption (3DES, SHA-1 MAC).
openssl pkcs12 -export -name "$NAME" -inkey "$work/key.pem" -in "$work/cert.pem" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout "pass:$password" -out "$out/chat-v2-signing.p12"
openssl x509 -in "$work/cert.pem" -outform DER -out "$out/chat-v2-signing.cer"
printf '%s' "$password" >"$out/chat-v2-signing.password"

sha1="$(openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')"
echo
echo "Made '$NAME', valid for $DAYS days, in $out"
echo "  SHA-1: $sha1"
echo "  designated requirement: identifier \"com.pandacover.chatv2\" and certificate root = H\"$sha1\""
echo
echo "Next:"
echo "  1. Back up chat-v2-signing.p12 and chat-v2-signing.password (losing them resets everyone's permissions)."
echo "  2. Copy the public certificate into the repository: cp \"$out/chat-v2-signing.cer\" build/chat-v2-signing.cer"
echo "  3. Add the GitHub secrets (from the repository folder):"
echo "       base64 < \"$out/chat-v2-signing.p12\" | tr -d '\\n' | gh secret set MAC_CERT_P12"
echo "       gh secret set MAC_CERT_PASSWORD < \"$out/chat-v2-signing.password\""
