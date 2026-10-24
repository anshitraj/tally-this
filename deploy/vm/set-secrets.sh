#!/usr/bin/env bash
# Puts the secrets into Google Secret Manager. Run it yourself in a terminal: the values you type are hidden, go
# straight to Google and are never written to a file, and nobody else (including Claude) sees them.
#
#   bash deploy/vm/set-secrets.sh              ask for each third-party secret, skipping any you leave empty
#   bash deploy/vm/set-secrets.sh --rotate     also make new random values for the two internal secrets
#                                              (this signs everyone out)
#
# The two internal secrets (tallythis-jwt-secret, tallythis-worker-service-token) are made here, at random, the first time. Use only
# NEW keys: anything that was ever stored in Railway should be treated as exposed (see docs/GCP_VM_DEPLOYMENT.md).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$here/config.sh"
gc() { gcloud --project "$PROJECT_ID" "$@"; }
has_value() { gc secrets versions describe latest --secret="$1" >/dev/null 2>&1; }

rotate=0
[ "${1:-}" = "--rotate" ] && rotate=1

# A container env file cannot carry these safely (the VM refuses such a value at start-up), so catch it here.
safe_value() {
  case $1 in
    '' | *[[:space:]]* | *'"'* | *"'"* | *'$'* | *'\'* | *'`'*) return 1 ;;
    *) return 0 ;;
  esac
}

echo "Internal secrets"
for name in tallythis-jwt-secret tallythis-worker-service-token; do
  if [ "$rotate" -eq 1 ] || ! has_value "$name"; then
    # tr removes the line ending Windows' openssl adds: a secret must hold exactly the characters it is made of.
    openssl rand -hex 32 | tr -d '\r\n' | gc secrets versions add "$name" --data-file=- >/dev/null
    echo "  $name: new random value stored"
  else
    echo "  $name: already has a value (use --rotate to replace it)"
  fi
done

ask() { # ask <secret-name> <what to paste>
  local name=$1 label=$2 value
  if has_value "$name"; then
    printf '  %s already has a value. Paste a NEW %s to replace it, or press Enter to keep it: ' "$name" "$label"
  else
    printf '  Paste the %s (Enter to skip for now): ' "$label"
  fi
  read -r -s value
  echo
  value=${value//$'\r'/}   # a paste from a Windows window can carry a carriage return
  [ -z "$value" ] && return 0
  if ! safe_value "$value"; then
    echo "  Not stored: it contains a space, quote, dollar sign, backslash or backtick." >&2
    return 1
  fi
  printf '%s' "$value" | gc secrets versions add "$name" --data-file=- >/dev/null
  echo "  $name stored"
}

echo
echo "Third-party secrets: use the NEW values you made after rotating the old ones."
ask tallythis-database-url "Neon connection string for the application (postgresql://...)"
ask tallythis-r2-access-key-id "Cloudflare R2 access key ID"
ask tallythis-r2-secret-access-key "Cloudflare R2 secret access key"
ask tallythis-gemini-api-key "Gemini API key"
ask tallythis-anthropic-api-key "Anthropic API key (optional)"

echo
for name in tallythis-database-url tallythis-jwt-secret tallythis-worker-service-token tallythis-r2-access-key-id tallythis-r2-secret-access-key tallythis-gemini-api-key; do
  if has_value "$name"; then echo "  ok       $name"; else echo "  MISSING  $name (required)"; fi
done
if has_value tallythis-anthropic-api-key; then echo "  ok       tallythis-anthropic-api-key"; else echo "  not set  tallythis-anthropic-api-key (optional)"; fi
