#!/usr/bin/env bash
# Run on the VM after a build, before real secrets exist (or any time): starts each built image on its own with
# throwaway random values and checks it answers. Nothing here uses a real secret, publishes a port, or stays running.
#   bash deploy/vm/ssh.sh 'sudo bash /opt/tallythis/current/deploy/vm/smoke-test.sh'
set -uo pipefail
source /opt/tallythis/release.env
cur=$(readlink -f /opt/tallythis/current)
fake_jwt=$(openssl rand -hex 32)
fake_token=$(openssl rand -hex 32)
net=smoke-net
docker network create "$net" >/dev/null 2>&1 || true
cleanup() { docker rm -f smoke-worker smoke-api smoke-gateway >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1; }
trap cleanup EXIT
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; }

echo "== release $RELEASE"

echo "== Caddyfile"
if docker run --rm -v "$cur/deploy/vm/Caddyfile:/etc/caddy/Caddyfile:ro" -e SITE_ADDRESS=api.example.test -e ACME_EMAIL=ops@example.test caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -3; then pass "caddy validate finished (see lines above)"; fi

echo "== worker (production mode, with a token)"
docker run -d --name smoke-worker --network "$net" -e APP_ENV=production -e PORT=8091 -e WORKER_SERVICE_TOKEN="$fake_token" "tallythis-worker:$RELEASE" >/dev/null
sleep 6
code() { docker run --rm --network "$net" curlimages/curl:8.10.1 -s -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }
[ "$(code http://smoke-worker:8091/health)" = 200 ] && pass "worker /health answers 200 without a token" || fail "worker /health"
[ "$(code -X POST http://smoke-worker:8091/parse/csv)" = 401 ] && pass "worker refuses a call without the token (401)" || fail "worker without token"
[ "$(code -X POST -H "X-Service-Token: $fake_token" http://smoke-worker:8091/parse/csv)" = 422 ] && pass "worker accepts the token and reaches the route (422 = empty request)" || fail "worker with token"

echo "== API image (fake database address, so health is expected to say the database is unreachable)"
docker run -d --name smoke-api --network "$net" -e NODE_ENV=production -e PORT=8080 -e JWT_SECRET="$fake_jwt" \
  -e DATABASE_URL="postgresql://smoke:smoke@127.0.0.1:1/smoke" -e PYTHON_WORKER_URL=http://smoke-worker:8091 \
  -e WORKER_SERVICE_TOKEN="$fake_token" -e STORAGE_PROVIDER=local "tallythis-api:$RELEASE" >/dev/null
sleep 12
status=$(code http://smoke-api:8080/api/health)
case "$status" in 200|503) pass "API is up and answers /api/health ($status)";; *) fail "API /api/health gave '$status'"; docker logs --tail 15 smoke-api 2>&1 | cut -c1-200;; esac
[ "$(code -X PATCH http://smoke-api:8080/api/company)" = 401 ] && pass "API refuses an unauthenticated PATCH /api/company (401)" || fail "API PATCH without sign-in"
docker exec smoke-api sh -c 'command -v tesseract >/dev/null && command -v pdftoppm >/dev/null' && pass "API image has tesseract and poppler for scans" || fail "OCR tools missing"

echo "== gateway image (production mode)"
docker run -d --name smoke-gateway --network "$net" -e APP_ENV=production -e PORT=8090 -e JWT_SECRET="$fake_jwt" \
  -e TYPESCRIPT_API_URL=http://smoke-api:8080 -e PYTHON_WORKER_URL=http://smoke-worker:8091 -e CORS_ORIGIN=https://www.example.test "tallythis-gateway:$RELEASE" >/dev/null
sleep 5
body=$(docker run --rm --network "$net" curlimages/curl:8.10.1 -s http://smoke-gateway:8090/api/health 2>/dev/null)
echo "  gateway health body: $body" | cut -c1-260
printf '%s' "$body" | grep -q '"goApi":"ok"' && pass "gateway answers and reports itself ok" || fail "gateway health"
printf '%s' "$body" | grep -q '"pythonWorker":"ok"' && pass "gateway reaches the worker through its private name" || fail "gateway -> worker"
printf '%s' "$body" | grep -q '"typeScriptFallback":"ok"\|"typeScriptFallback":"degraded"' && pass "gateway reaches the API through its private name" || fail "gateway -> api"
origin=$(docker run --rm --network "$net" curlimages/curl:8.10.1 -s -D - -o /dev/null -X OPTIONS -H "Origin: https://evil.example" -H "Access-Control-Request-Method: GET" http://smoke-gateway:8090/api/company 2>/dev/null | grep -i '^access-control-allow-origin' || true)
[ -z "$origin" ] && pass "gateway sends no CORS allowance to an unlisted site" || fail "CORS allowed: $origin"
echo "== done"
