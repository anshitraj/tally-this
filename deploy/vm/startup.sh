#!/usr/bin/env bash
# Runs as root every time the VM boots (Compute Engine "startup-script" metadata). Safe to run again.
# Installs Docker and the small helper that receives a release. It holds no secrets and starts no application:
# the application is put in place by deploy.sh and started by the tallythis systemd unit.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg python3 unattended-upgrades

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Container logs rotate, and containers keep running while Docker itself is restarted for an update.
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" },
  "live-restore": true
}
JSON
systemctl enable --now docker

# Security updates install themselves.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT

mkdir -p /opt/tallythis/bin /opt/tallythis/releases

# The one stable entry point deploy.sh calls: unpack a release from stdin, then let the release install itself.
cat > /opt/tallythis/bin/receive-release <<'RECEIVE'
#!/usr/bin/env bash
# usage: git archive --format=tar.gz <ref> | receive-release <release-name>
set -euo pipefail
release=${1:?release name}
case $release in *[!A-Za-z0-9._-]*|'') echo "bad release name" >&2; exit 2 ;; esac
dest=/opt/tallythis/releases/$release
rm -rf "$dest"
mkdir -p "$dest"
tar -xz -C "$dest"
exec bash "$dest/deploy/vm/install-release.sh" "$release"
RECEIVE
chmod 0755 /opt/tallythis/bin/receive-release
