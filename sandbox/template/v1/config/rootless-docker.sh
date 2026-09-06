#!/bin/sh
set -eu
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# Rootless daemon bootstrap. The controller image must provide a pinned
# rootless Docker package; no host socket, context, registry credential, or
# ambient DOCKER_HOST is accepted.
if [ "$(id -u)" -ne 1001 ] || [ "$(id -g)" -ne 1001 ] || [ "$(id -G)" != "1001" ]; then
  echo "rootless Docker must run as squireagent without supplementary groups" >&2
  exit 1
fi
if [ -L /ticket/docker/data ] || [ -L /ticket/docker/run ]; then
  echo "rootless Docker directories must not be symlinks" >&2
  exit 1
fi
install -d -m 0700 -o 1001 -g 1001 /ticket/docker/data
if [ "$(stat -c '%u:%g:%a' /ticket/docker/data)" != "1001:1001:700" ]; then
  echo "rootless Docker data directory is not the exact private role directory" >&2
  exit 1
fi
if [ ! -d /ticket/docker/run ] || [ "$(stat -c '%u:%g:%a' /ticket/docker/run)" != "1001:1000:750" ]; then
  echo "rootless Docker runtime directory is not the exact private controller-owned directory" >&2
  exit 1
fi
chmod 0750 /ticket/docker/run
export HOME=/ticket/runtime
export XDG_RUNTIME_DIR=/ticket/docker/run
export DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
export DOCKER_HOST=unix:///ticket/docker/run/docker.sock
if [ ! -x /usr/bin/dockerd-rootless.sh ]; then
  echo "the pinned rootless Docker helper is missing" >&2
  exit 1
fi
exec /usr/bin/dockerd-rootless.sh --data-root /ticket/docker/data --exec-root /ticket/docker/exec --pidfile /ticket/docker/run/docker.pid --host "$DOCKER_HOST" --iptables=false
