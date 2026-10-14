#!/usr/bin/env bash
# Install a verified distribution on the provisioned Debian host. Config and data stay outside releases.
set -euo pipefail

archive=${1:?Usage: deploy-server.sh ARCHIVE RELEASE_ID}
release_id=${2:?Usage: deploy-server.sh ARCHIVE RELEASE_ID}
enable_full_access=${3:-false}
[[ $enable_full_access == true || $enable_full_access == false ]] || exit 1
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ $release_id =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || { echo 'Invalid release ID.' >&2; exit 1; }
root=/opt/eta-bot
mkdir -p "$root/releases"
exec 9>"$root/deploy.lock"
flock -w 300 9

release="$root/releases/$release_id"
[[ ! -e $release ]] || { echo 'Release already exists; use a new deployment attempt.' >&2; exit 1; }
test -r /etc/eta-bot/config.json
id eta-bot >/dev/null
/usr/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
mkdir "$release"
tar -xzf "$archive" -C "$release" --no-same-owner
test -s "$release/dist/main.mjs"
test -x "$release/dist/sandbox-launcher"
test -s "$release/scripts/eta-bot.service"
test -s "$release/scripts/check-server.mjs"
chown -R root:root "$release"
chmod -R go-w "$release"

previous=$(readlink -f "$root/current" || true)
unit_backup=$(mktemp)
had_unit=false
if [[ -f /etc/systemd/system/eta-bot.service ]]; then
  cp /etc/systemd/system/eta-bot.service "$unit_backup"
  had_unit=true
fi
config_backup=
if [[ $enable_full_access == true ]]; then
  config_backup=$(mktemp /etc/eta-bot/config.json.backup.XXXXXXXX)
  cp -p /etc/eta-bot/config.json "$config_backup"
fi
switched=false
rollback() {
  result=$?
  trap - EXIT
  if (( result != 0 )) && [[ -n $config_backup ]]; then
    cp -p "$config_backup" /etc/eta-bot/config.json
  fi
  if (( result != 0 )) && $switched; then
    echo 'Deployment failed; restoring the previous release.' >&2
    if [[ -n $previous && -d $previous ]]; then
      ln -sfn "$previous" "$root/current.next"
      mv -Tf "$root/current.next" "$root/current"
      if $had_unit; then cp "$unit_backup" /etc/systemd/system/eta-bot.service; fi
      systemctl daemon-reload
      systemctl reset-failed eta-bot || true
      systemctl restart eta-bot || true
    else
      systemctl stop eta-bot || true
      systemctl disable eta-bot || true
      rm -f "$root/current"
    fi
  fi
  rm -f "$unit_backup"
  if [[ -n $config_backup ]]; then rm -f "$config_backup"; fi
  exit "$result"
}
trap rollback EXIT
if [[ $enable_full_access == true ]]; then
  /usr/bin/node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = '/etc/eta-bot/config.json';
const config = JSON.parse(readFileSync(path, 'utf8'));
config.allowedSandboxModes = [...new Set([
  ...(config.allowedSandboxModes ?? ['read-only', 'workspace-write']),
  'danger-full-access',
])];
writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
NODE
fi
switched=true
install -m 644 "$release/scripts/eta-bot.service" /etc/systemd/system/eta-bot.service
ln -sfn "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
systemctl daemon-reload
systemctl enable eta-bot
systemctl reset-failed eta-bot || true
systemctl restart eta-bot
check_args=()
if [[ $enable_full_access == true ]]; then check_args+=(--expect-full-access); fi
for attempt in {1..30}; do
  if systemctl is-active --quiet eta-bot && runuser -u eta-bot -- /usr/bin/node "$release/scripts/check-server.mjs" "${check_args[@]}" >/dev/null 2>&1; then
    echo "Eta Bot deployed: $release_id"
    exit 0
  fi
  sleep 1
done
journalctl -u eta-bot -n 30 --no-pager >&2
exit 1
