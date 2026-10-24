#!/usr/bin/env bash
# Puts the secrets into Google Secret Manager. The values go straight to Google: they are never written to a file
# by this script and never printed (only names and lengths are).
#
#   bash deploy/vm/set-secrets.sh                    ask for each third-party secret with hidden input,
#                                                    skipping any you leave empty
#   bash deploy/vm/set-secrets.sh --from-env .env    copy them from a .env file instead (DATABASE_URL, the R2 key
#                                                    pair, GEMINI_API_KEY, ANTHROPIC_API_KEY), with no typing
#   bash deploy/vm/set-secrets.sh --rotate           also make new random values for the two internal secrets
#                                                    (this signs everyone out)
#
# The two internal secrets (tallythis-jwt-secret, tallythis-worker-service-token) are made here, at random, the first
# time. Use only NEW keys: anything that was ever stored in Railway should be treated as exposed (see
# docs/GCP_VM_DEPLOYMENT.md).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$here/config.sh"
gc() { gcloud --project "$PROJECT_ID" "$@"; }
has_value() { gc secrets versions describe latest --secret="$1" >/dev/null 2>&1; }

rotate=0
from_env=""
while [ "$#" -gt 0 ]; do
  case $1 in
    --rotate) rotate=1 ;;
    --from-env)
      shift
      from_env=${1:?--from-env needs the path of a .env file}
      [ -f "$from_env" ] || { echo "No such file: $from_env" >&2; exit 2; }
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

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

# The value of NAME in a .env file, without quotes or line endings; nothing when it is absent or empty.
env_value() { # env_value <file> <NAME>
  local line
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" | tail -n 1) || true
  [ -n "$line" ] || return 0
  line=${line#*=}
  line=${line//$'\r'/}
  line=${line#\"}; line=${line%\"}
  line=${line#\'}; line=${line%\'}
  printf '%s' "$line"
}

import() { # import <secret-name> <ENV_NAME> [<another ENV_NAME to try>]
  local secret=$1 value="" used="" candidate
  shift
  for candidate in "$@"; do
    value=$(env_value "$from_env" "$candidate")
    if [ -n "$value" ]; then used=$candidate; break; fi
  done
  if [ -z "$value" ]; then
    echo "  $secret: none of $* is set in $from_env, skipped"
    return 0
  fi
  if ! safe_value "$value"; then
    echo "  $secret: NOT stored ($used contains a space, quote, dollar sign, backslash or backtick)" >&2
    return 1
  fi
  printf '%s' "$value" | gc secrets versions add "$secret" --data-file=- >/dev/null
  echo "  $secret: stored from $used (${#value} characters)"
}

echo
if [ -n "$from_env" ]; then
  echo "Third-party secrets, copied from $from_env (use only NEW values there):"
  import tallythis-database-url DATABASE_URL
  import tallythis-r2-access-key-id CLOUDFLARE_R2_ACCESS_KEY_ID STORAGE_ACCESS_KEY_ID
  import tallythis-r2-secret-access-key CLOUDFLARE_R2_SECRET_ACCESS_KEY STORAGE_SECRET_ACCESS_KEY
  import tallythis-gemini-api-key GEMINI_API_KEY
  import tallythis-anthropic-api-key ANTHROPIC_API_KEY CLAUDE_API_KEY
else
  echo "Third-party secrets: use the NEW values you made after rotating the old ones."
  ask tallythis-database-url "Neon connection string for the application (postgresql://...)"
  ask tallythis-r2-access-key-id "Cloudflare R2 access key ID"
  ask tallythis-r2-secret-access-key "Cloudflare R2 secret access key"
  ask tallythis-gemini-api-key "Gemini API key"
  ask tallythis-anthropic-api-key "Anthropic API key (optional)"
fi

echo
for name in tallythis-database-url tallythis-jwt-secret tallythis-worker-service-token tallythis-r2-access-key-id tallythis-r2-secret-access-key tallythis-gemini-api-key; do
  if has_value "$name"; then echo "  ok       $name"; else echo "  MISSING  $name (required)"; fi
done
if has_value tallythis-anthropic-api-key; then echo "  ok       tallythis-anthropic-api-key"; else echo "  not set  tallythis-anthropic-api-key (optional)"; fi
