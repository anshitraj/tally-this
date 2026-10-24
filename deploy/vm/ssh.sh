#!/usr/bin/env bash
# Opens a shell on the VM, or runs one command there, through Google's identity-aware proxy (the VM's SSH port is
# not open to the internet). Examples:
#   bash deploy/vm/ssh.sh
#   bash deploy/vm/ssh.sh 'sudo docker ps'
#   bash deploy/vm/ssh.sh 'sudo journalctl -u tallythis -n 100 --no-pager'
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$here/config.sh"

if [ "$#" -eq 0 ]; then
  exec gcloud compute ssh "$VM_NAME" --project "$PROJECT_ID" --zone "$ZONE" --tunnel-through-iap
fi
exec gcloud compute ssh "$VM_NAME" --project "$PROJECT_ID" --zone "$ZONE" --tunnel-through-iap --quiet --command "$1"
