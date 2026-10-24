#!/usr/bin/env bash
# Writes the secrets each container needs into /run/tallythis from Google Secret Manager, just before the stack
# starts. /run is memory, so nothing is left on the disk, and each container gets only the secrets it uses.
#
# The VM's own service account (no key file anywhere) is the only credential used, and it can read only the
# secrets listed in provision.sh.
#
# The three addresses below can be overridden so the tests can run this against a fake server.
set -euo pipefail
umask 077

META=${TALLYTHIS_METADATA_URL:-http://metadata.google.internal/computeMetadata/v1}
SECRETS_API=${TALLYTHIS_SECRETMANAGER_URL:-https://secretmanager.googleapis.com}
OUT=${TALLYTHIS_RUN_DIR:-/run/tallythis}
mkdir -p "$OUT"

project=$(curl -fsS -H 'Metadata-Flavor: Google' "$META/project/project-id")
token=$(curl -fsS -H 'Metadata-Flavor: Google' "$META/instance/service-accounts/default/token" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')

# Prints the newest value of a secret. Returns 3 when the secret has no value yet, 4 when the call itself failed.
secret() {
  local reply code
  reply=$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $token" \
    "$SECRETS_API/v1/projects/$project/secrets/$1/versions/latest:access") || return 4
  code=${reply##*$'\n'}
  [ "$code" = 200 ] || return 3
  printf '%s' "${reply%$'\n'*}" \
    | python3 -c 'import sys, json, base64; sys.stdout.write(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode())'
}

# A container env file cannot carry these safely, so a value that has one is refused instead of being damaged.
safe_value() {
  case $1 in
    '' | *[[:space:]]* | *'"'* | *"'"* | *'$'* | *'\'* | *'`'*) return 1 ;;
    *) return 0 ;;
  esac
}

failed=0

# build_env <file> NAME=secret-name[:optional] ...
build_env() {
  local file=$1 pair name rest secret_name mode value status
  shift
  : > "$OUT/$file.tmp"
  for pair in "$@"; do
    name=${pair%%=*}
    rest=${pair#*=}
    secret_name=${rest%%:*}
    mode=required
    [ "$rest" = "$secret_name" ] || mode=${rest#*:}
    status=0
    value=$(secret "$secret_name") || status=$?
    if [ "$status" -ne 0 ]; then
      if [ "$mode" = optional ] && [ "$status" -eq 3 ]; then
        continue
      fi
      echo "tallythis: secret '$secret_name' (for $name) has no value or cannot be read (status $status). Run deploy/vm/set-secrets.sh." >&2
      failed=1
      continue
    fi
    # A value made or pasted on Windows can end in a carriage return or newline that is not part of the secret.
    # Trim those from the end only; anything inside the value is judged as it is.
    while [ -n "$value" ] && [[ $value == *$'\r' || $value == *$'\n' ]]; do
      value=${value%?}
    done
    if ! safe_value "$value"; then
      echo "tallythis: secret '$secret_name' contains a space, quote, dollar sign, backslash or backtick, which a container env file cannot carry safely." >&2
      failed=1
      continue
    fi
    printf '%s=%s\n' "$name" "$value" >> "$OUT/$file.tmp"
  done
  mv "$OUT/$file.tmp" "$OUT/$file"
}

build_env gateway.env \
  DATABASE_URL=tallythis-database-url \
  JWT_SECRET=tallythis-jwt-secret

build_env api.env \
  DATABASE_URL=tallythis-database-url \
  JWT_SECRET=tallythis-jwt-secret \
  WORKER_SERVICE_TOKEN=tallythis-worker-service-token \
  CLOUDFLARE_R2_ACCESS_KEY_ID=tallythis-r2-access-key-id \
  CLOUDFLARE_R2_SECRET_ACCESS_KEY=tallythis-r2-secret-access-key \
  GEMINI_API_KEY=tallythis-gemini-api-key \
  ANTHROPIC_API_KEY=tallythis-anthropic-api-key:optional

build_env worker.env \
  WORKER_SERVICE_TOKEN=tallythis-worker-service-token

chmod 600 "$OUT"/*.env
if [ "$failed" -ne 0 ]; then
  exit 1
fi
