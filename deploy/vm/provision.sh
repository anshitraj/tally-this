#!/usr/bin/env bash
# Creates everything TallyThis needs in a Google Cloud project: a private network of its own, one VM with only web
# ports open to the world, a service account that can read only TallyThis's own secrets, the (empty) secrets, and
# a daily disk snapshot. Everything it makes is named tallythis-*, so it can share a project with other work
# without touching it. Safe to run again: every step checks first.
#
# Run from Git Bash, after `gcloud auth login` and after copying config.sh.example to config.sh.
#   bash deploy/vm/provision.sh
# The project must already exist and be billed. To have this script create a new one, run it with CREATE_PROJECT=1
# (a billing account only allows a limited number of projects, so linking a new one can be refused).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
if [ ! -f "$here/config.sh" ]; then
  echo "Copy $here/config.sh.example to $here/config.sh and fill it in first." >&2
  exit 1
fi
# shellcheck disable=SC1091
. "$here/config.sh"

say() { printf '\n== %s\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }
gc() { gcloud --project "$PROJECT_ID" "$@"; }

SA_NAME=tallythis-vm
SA="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

# Secrets the VM may read. Third-party credentials are added by set-secrets.sh; the two internal ones are
# generated there too (never shown). The prefix keeps them apart from anything else in a shared project.
SECRETS=(
  tallythis-database-url tallythis-jwt-secret tallythis-worker-service-token
  tallythis-r2-access-key-id tallythis-r2-secret-access-key tallythis-gemini-api-key tallythis-anthropic-api-key
)

say "Project $PROJECT_ID"
if exists gcloud projects describe "$PROJECT_ID"; then
  echo "found"
elif [ "${CREATE_PROJECT:-0}" = 1 ]; then
  gcloud projects create "$PROJECT_ID" --name="TallyThis"
else
  echo "Project $PROJECT_ID was not found. Check PROJECT_ID in config.sh, or run with CREATE_PROJECT=1 to make it." >&2
  exit 1
fi

say "Billing"
if [ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)" = "True" ]; then
  echo "already billed"
else
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" >/dev/null
  echo "linked to $BILLING_ACCOUNT"
fi

say "Turning on the services used"
gc services enable \
  compute.googleapis.com secretmanager.googleapis.com iap.googleapis.com iam.googleapis.com \
  cloudresourcemanager.googleapis.com logging.googleapis.com monitoring.googleapis.com

say "Private network (the default network is not used)"
exists gc compute networks describe tallythis-vpc || gc compute networks create tallythis-vpc --subnet-mode=custom
exists gc compute networks subnets describe tallythis-subnet --region "$REGION" \
  || gc compute networks subnets create tallythis-subnet --network=tallythis-vpc --region "$REGION" \
       --range=10.10.0.0/24 --enable-private-ip-google-access

say "Firewall: web ports for everyone, SSH only through Google's identity-aware proxy"
exists gc compute firewall-rules describe tallythis-allow-web \
  || gc compute firewall-rules create tallythis-allow-web --network=tallythis-vpc --direction=INGRESS --action=ALLOW \
       --rules=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=tallythis-web
exists gc compute firewall-rules describe tallythis-allow-iap-ssh \
  || gc compute firewall-rules create tallythis-allow-iap-ssh --network=tallythis-vpc --direction=INGRESS --action=ALLOW \
       --rules=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=tallythis-web

say "Fixed public address"
exists gc compute addresses describe tallythis-ip --region "$REGION" || gc compute addresses create tallythis-ip --region "$REGION"
IP=$(gc compute addresses describe tallythis-ip --region "$REGION" --format='value(address)')
echo "$IP"

say "Service account for the VM (reads its own secrets, writes logs, nothing else)"
exists gc iam service-accounts describe "$SA" || gc iam service-accounts create "$SA_NAME" --display-name="TallyThis VM"
for attempt in 1 2 3 4 5 6; do
  if exists gc iam service-accounts describe "$SA"; then break; fi
  echo "waiting for the service account to exist ($attempt)"; sleep 5
done
for role in roles/logging.logWriter roles/monitoring.metricWriter; do
  gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$role" --condition=None >/dev/null
done

say "Secrets (stored in $REGION; the VM's account may read these and no others)"
for name in "${SECRETS[@]}"; do
  exists gc secrets describe "$name" \
    || gc secrets create "$name" --replication-policy=user-managed --locations="$REGION"
  gc secrets add-iam-policy-binding "$name" --member="serviceAccount:$SA" \
    --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
done

# gcloud is a Windows program under Git Bash and needs a Windows-style path to the file.
startup_script=$(cygpath -m "$here/startup.sh" 2>/dev/null || echo "$here/startup.sh")

say "The VM $VM_NAME ($MACHINE_TYPE, $DISK_GB GB, Debian 12)"
if ! exists gc compute instances describe "$VM_NAME" --zone "$ZONE"; then
  gc compute instances create "$VM_NAME" --zone "$ZONE" --machine-type "$MACHINE_TYPE" \
    --network=tallythis-vpc --subnet=tallythis-subnet --address="$IP" --tags=tallythis-web \
    --service-account="$SA" --scopes=cloud-platform \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size="${DISK_GB}GB" --boot-disk-type=pd-balanced \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata=enable-oslogin=TRUE --metadata-from-file=startup-script="$startup_script" \
    --deletion-protection
else
  echo "already exists; refreshing its startup script so it matches this checkout"
  gc compute instances add-metadata "$VM_NAME" --zone "$ZONE" --metadata-from-file=startup-script="$startup_script"
fi

say "Daily disk snapshot, kept 14 days"
exists gc compute resource-policies describe tallythis-daily --region "$REGION" \
  || gc compute resource-policies create snapshot-schedule tallythis-daily --region "$REGION" \
       --max-retention-days=14 --daily-schedule --start-time=20:00
gc compute disks add-resource-policies "$VM_NAME" --zone "$ZONE" --resource-policies=tallythis-daily 2>/dev/null || true

cat <<EOF

Done. The VM's public address is $IP

Next:
  1. DNS: add an A record  $SITE_ADDRESS -> $IP  (DNS only, no proxy). Until then, use
     $(echo "$IP" | tr . -).sslip.io as SITE_ADDRESS in config.sh and runtime.env.
  2. Rotate every key that was ever in Railway, then:  bash deploy/vm/set-secrets.sh
  3. Copy runtime.env.example to runtime.env and fill it in, then:  bash deploy/vm/deploy.sh
EOF
