#!/usr/bin/env bash
# Builds a release on the VM and starts it. Only COMMITTED files are sent (git archive), so nothing from your
# working folder, such as a local .env, can end up on the server. If the new release does not become healthy the
# VM puts the previous one back.
#
#   bash deploy/vm/deploy.sh            deploy the committed HEAD
#   bash deploy/vm/deploy.sh <git-ref>  deploy a branch, tag or commit
#
# The VM is reached through Google's identity-aware proxy, so its SSH port is not open to the internet.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
if [ ! -f "$here/config.sh" ] || [ ! -f "$here/runtime.env" ]; then
  echo "Copy config.sh.example to config.sh and runtime.env.example to runtime.env (both in $here) and fill them in first." >&2
  exit 1
fi
# shellcheck disable=SC1091
. "$here/config.sh"

ref=${1:-HEAD}
sha=$(git -C "$root" rev-parse --short=10 "$ref")
if [ "$ref" = HEAD ] && [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "Note: changes you have not committed are NOT deployed. Deploying the committed $sha." >&2
fi
release="$sha-$(date -u +%Y%m%d%H%M%S)"

vm() {
  gcloud compute ssh "$VM_NAME" --project "$PROJECT_ID" --zone "$ZONE" --tunnel-through-iap --quiet --command "$1"
}

# Files are sent with scp: gcloud's SSH client on Windows cannot pass binary data through stdin.
# (gcloud is a Windows program under Git Bash and needs Windows-style paths.)
winpath() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
upload() {
  gcloud compute scp "$(winpath "$1")" "$VM_NAME:$2" --project "$PROJECT_ID" --zone "$ZONE" --tunnel-through-iap --quiet
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "== Waiting for the VM to be ready (the first boot installs Docker)"
ready=0
for _ in $(seq 1 60); do
  if vm 'test -x /opt/tallythis/bin/receive-release && command -v docker >/dev/null' 2>/dev/null; then
    ready=1
    break
  fi
  sleep 10
done
if [ "$ready" -ne 1 ]; then
  echo "The VM is not ready after 10 minutes. Check:  bash deploy/vm/ssh.sh 'sudo journalctl -u google-startup-scripts --no-pager | tail -40'" >&2
  exit 1
fi

echo "== Sending your settings (runtime.env, which holds no secrets) and release $release (commit $sha)"
git -C "$root" archive --format=tar.gz -o "$tmp/release.tar.gz" "$ref"
upload "$here/runtime.env" /tmp/tallythis-runtime.env
upload "$tmp/release.tar.gz" /tmp/tallythis-release.tar.gz

echo "== Building and starting it on the VM"
vm "sudo /opt/tallythis/bin/receive-release $release /tmp/tallythis-release.tar.gz /tmp/tallythis-runtime.env"

echo
echo "== Running. Try:  curl -sS https://$SITE_ADDRESS/api/health"
