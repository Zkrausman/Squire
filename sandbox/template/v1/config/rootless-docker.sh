#!/bin/sh
set -eu
umask 077

# Rootless daemon bootstrap. The controller image must provide a pinned
# rootless Docker package; no host socket, context, registry credential, or
# ambient DOCKER_HOST is accepted.
if [ "$(id -u)" -ne 1001 ]; then
  echo "rootless Docker must run as squireagent" >&2
  exit 1
fi
install -d -m 0700 -o 1001 -g 1001 /ticket/docker/data /ticket/docker/run
export HOME=/ticket/runtime
export XDG_RUNTIME_DIR=/ticket/docker/run
export DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
export DOCKER_HOST=unix:///ticket/docker/run/docker.sock
exec dockerd-rootless.sh --data-root /ticket/docker/data --exec-root /ticket/docker/exec --pidfile /ticket/docker/run/docker.pid --host "$DOCKER_HOST" --iptables=false
