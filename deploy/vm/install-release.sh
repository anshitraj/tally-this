#!/usr/bin/env bash
# Runs on the VM, as root, from inside an unpacked release (receive-release calls it). It builds the images, puts
# the release live, waits until the three services report healthy, and puts the previous release back if they do
# not. Usage: install-release.sh <release-name>
set -euo pipefail

release=${1:?release name}
base=/opt/tallythis
dir=$base/releases/$release
compose=(docker compose --project-directory "$dir" --env-file "$base/runtime.env" -f "$dir/deploy/vm/compose.yaml")

if [ ! -f "$base/runtime.env" ]; then
  echo "No $base/runtime.env yet. deploy.sh uploads it; run it from your computer, not by hand on the VM." >&2
  exit 1
fi

# Keep the helper files in step with this release.
install -m 0755 "$dir/deploy/vm/fetch-secrets.sh" "$base/bin/fetch-secrets.sh"
install -m 0644 "$dir/deploy/vm/tallythis.service" /etc/systemd/system/tallythis.service
systemctl daemon-reload
systemctl enable tallythis >/dev/null 2>&1 || true

echo "== Building images for $release (this takes a few minutes the first time)"
RELEASE=$release "${compose[@]}" build

previous=
if [ -L "$base/current" ]; then
  previous=$(readlink -f "$base/current")
fi

# Points "current" at a release and records its name, which names the images the unit starts.
switch_to() {
  ln -sfn "$1" "$base/current.new"
  mv -T "$base/current.new" "$base/current"
  echo "RELEASE=$(basename "$1")" > "$base/release.env"
}

healthy() {
  local name state
  for name in tallythis-worker-1 tallythis-api-1 tallythis-gateway-1; do
    state=$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)
    [ "$state" = healthy ] || return 1
  done
}

echo "== Switching to $release"
switch_to "$dir"
systemctl restart tallythis

ok=0
for _ in $(seq 1 60); do
  if healthy; then
    ok=1
    break
  fi
  if ! systemctl is-active --quiet tallythis; then
    break
  fi
  sleep 5
done

if [ "$ok" -ne 1 ]; then
  echo "== $release did not become healthy. Last log lines:" >&2
  journalctl -u tallythis --no-pager -n 40 >&2 || true
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    echo "== Putting the previous release back: $previous" >&2
    switch_to "$previous"
    systemctl restart tallythis || true
  else
    # Nothing to go back to: stop the service so it does not keep retrying (and asking Secret Manager) in a loop.
    echo "== There is no previous release to go back to; stopping the service. After fixing the cause run: sudo systemctl start tallythis" >&2
    systemctl stop tallythis || true
  fi
  exit 1
fi

echo "== $release is running and healthy"
# Keep the three newest releases and drop old images.
ls -1dt "$base"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
docker image prune -f >/dev/null 2>&1 || true
