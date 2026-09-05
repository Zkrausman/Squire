#!/bin/sh
set -eu
umask 077

# Fixed image-build/boot bootstrap. It consumes no environment/configuration
# supplied by a role and never interpolates ticket or repository text.
getent group squirectl >/dev/null 2>&1 || groupadd --system --gid 1000 squirectl
getent passwd squirectl >/dev/null 2>&1 || useradd --system --uid 1000 --gid 1000 --home-dir /ticket/control --no-create-home --shell /usr/sbin/nologin squirectl
getent group squireagent >/dev/null 2>&1 || groupadd --system --gid 1001 squireagent
getent passwd squireagent >/dev/null 2>&1 || useradd --system --uid 1001 --gid 1001 --home-dir /ticket/runtime --no-create-home --shell /usr/sbin/nologin squireagent

install -d -m 0700 -o squirectl -g squirectl /ticket/control /ticket/import
install -d -m 0770 -o squireagent -g squireagent /ticket/workspace /ticket/sessions /ticket/artifacts /ticket/evidence /ticket/docker
install -d -m 0700 -o squireagent -g squireagent /ticket/docker/data /ticket/docker/run
chmod 0750 /opt/squire
find /opt/squire -xdev -type f -perm /6000 -exec chmod a-s {} +
