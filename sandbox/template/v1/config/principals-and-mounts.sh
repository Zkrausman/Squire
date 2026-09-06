#!/bin/sh
set -eu
umask 077

# Fixed image-build/boot bootstrap. It consumes no environment/configuration
# supplied by a role and never interpolates ticket or repository text.
getent group squirectl >/dev/null 2>&1 || groupadd --system --gid 1000 squirectl
getent passwd squirectl >/dev/null 2>&1 || useradd --system --uid 1000 --gid 1000 --home-dir /ticket/control --no-create-home --shell /usr/sbin/nologin squirectl
getent group squireagent >/dev/null 2>&1 || groupadd --system --gid 1001 squireagent
getent passwd squireagent >/dev/null 2>&1 || useradd --system --uid 1001 --gid 1001 --home-dir /ticket/runtime --no-create-home --shell /usr/sbin/nologin squireagent
[ "$(getent group squirectl | cut -d: -f3)" = "1000" ] || { echo "squirectl group identity is substituted" >&2; exit 1; }
[ "$(getent group squireagent | cut -d: -f3)" = "1001" ] || { echo "squireagent group identity is substituted" >&2; exit 1; }
[ "$(id -u squirectl)" = "1000" ] && [ "$(id -g squirectl)" = "1000" ] && [ "$(id -G squirectl)" = "1000" ] || { echo "squirectl principal identity or supplementary groups are substituted" >&2; exit 1; }
[ "$(id -u squireagent)" = "1001" ] && [ "$(id -g squireagent)" = "1001" ] && [ "$(id -G squireagent)" = "1001" ] || { echo "squireagent principal identity or supplementary groups are substituted" >&2; exit 1; }
# Rootless Docker must have one fixed subordinate range. These constants are
# image policy, never ticket/role input; any pre-existing substitution fails.
[ ! -L /etc/subuid ] && [ ! -L /etc/subgid ] || { echo "subordinate mapping files must not be symlinks" >&2; exit 1; }
touch /etc/subuid /etc/subgid
if ! grep -q '^squireagent:' /etc/subuid; then printf '%s\n' 'squireagent:100000:65536' >> /etc/subuid; fi
if ! grep -q '^squireagent:' /etc/subgid; then printf '%s\n' 'squireagent:100000:65536' >> /etc/subgid; fi
chmod 0644 /etc/subuid /etc/subgid
subuid_entries=$(grep -Ec '^squireagent:' /etc/subuid || true)
subgid_entries=$(grep -Ec '^squireagent:' /etc/subgid || true)
subuid_exact=$(grep -Ec '^squireagent:[0-9]+:65536$' /etc/subuid || true)
subgid_exact=$(grep -Ec '^squireagent:[0-9]+:65536$' /etc/subgid || true)
[ "$subuid_entries" = "1" ] && [ "$subuid_exact" = "1" ] || { echo "squireagent has no single exact subordinate UID range" >&2; exit 1; }
[ "$subgid_entries" = "1" ] && [ "$subgid_exact" = "1" ] || { echo "squireagent has no single exact subordinate GID range" >&2; exit 1; }

install -d -m 0770 -o squirectl -g root /ticket/control
install -d -m 0700 -o squirectl -g squirectl /ticket/import /ticket/artifacts /ticket/evidence
install -d -m 0770 -o squirectl -g squireagent /ticket/workspace /ticket/sessions /ticket/docker /ticket/runtime
install -d -m 1770 -o squireagent -g squireagent /ticket/tmp
install -d -m 0700 -o squireagent -g squireagent /ticket/docker/data
install -d -m 0750 -o squireagent -g squirectl /ticket/docker/run
chmod 0750 /opt/squire /opt/squire/bin
chown root:squirectl /opt/squire /opt/squire/bin
chown root:squirectl /opt/squire/bin/squirectl
chmod 0550 /opt/squire/bin/squirectl
chown root:root /opt/squire/bin/squire-supervisor
chmod 0550 /opt/squire/bin/squire-supervisor
if command -v sudo >/dev/null 2>&1; then rm -f "$(command -v sudo)"; fi
# Rootless Docker may require these two narrowly scoped user-namespace
# mapping helpers. They are not sudo, a Docker socket, or a rootful daemon;
# every other set-ID program is stripped from the image.
for helper in /usr/bin/newuidmap /usr/bin/newgidmap; do
  if [ -e "$helper" ]; then
    [ -f "$helper" ] && [ "$(stat -c '%u:%g' "$helper")" = "0:0" ] && [ "$(stat -c '%a' "$helper")" = "4755" ] || { echo "rootless mapping helper identity is invalid: $helper" >&2; exit 1; }
  fi
done
find / -xdev -type f -perm /6000 ! -path /usr/bin/newuidmap ! -path /usr/bin/newgidmap -exec chmod a-s {} +
if ! capability_files=$(getcap -r / 2>/dev/null); then
  echo "file capability inventory could not be completed" >&2
  exit 1
fi
[ -z "$capability_files" ] || { echo "file capabilities are not permitted in the role image" >&2; exit 1; }
