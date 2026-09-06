# Squire restricted sandbox template v1. The build context is resolved only
# by the host promotion worker against an operator-supplied immutable base.
# No mutable tag, default digest, or host secret enters this image.
ARG SQUIRE_BASE_IMAGE
ARG SQUIRE_BASE_DIGEST
FROM ${SQUIRE_BASE_IMAGE}@${SQUIRE_BASE_DIGEST}

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/ticket/control \
    XDG_CONFIG_HOME=/ticket/control/config \
    XDG_RUNTIME_DIR=/ticket/runtime/squirectl

COPY config/principals-and-mounts.sh /opt/squire/build/principals-and-mounts.sh
COPY config/rootless-docker.sh /opt/squire/build/rootless-docker.sh
COPY supervisor/squire-principals.service /etc/systemd/system/squire-principals.service
COPY supervisor/squire-supervisor.service /etc/systemd/system/squire-supervisor.service
COPY supervisor/squire-docker.service /etc/systemd/system/squire-docker.service
COPY runtime/squirectl.mjs /opt/squire/bin/squirectl
COPY runtime/squire-supervisor.mjs /opt/squire/bin/squire-supervisor
COPY supervisor/squire-guest-supervisor.ts /opt/squire/build/squire-guest-supervisor.ts
RUN install -d -m 0750 /opt/squire /opt/squire/bin \
 && chmod 0555 /opt/squire/build/principals-and-mounts.sh /opt/squire/build/rootless-docker.sh \
 && chmod 0550 /opt/squire/bin/squirectl /opt/squire/bin/squire-supervisor \
 && test -x "$(command -v node)" \
 && test -x "$(command -v systemctl)" \
 && test -x "$(command -v dockerd)" \
 && test -x "$(command -v getcap)" \
 && test -x /usr/bin/dockerd-rootless.sh \
 && test -x /usr/bin/rootlesskit \
 && test -x /usr/bin/newuidmap \
 && test -x /usr/bin/newgidmap \
 && node --check /opt/squire/bin/squirectl \
 && node --check /opt/squire/bin/squire-supervisor \
 && /opt/squire/build/principals-and-mounts.sh \
 && [ "$(stat -c '%u:%g:%a' /usr/bin/newuidmap)" = "0:0:4755" ] \
 && [ "$(stat -c '%u:%g:%a' /usr/bin/newgidmap)" = "0:0:4755" ] \
 && systemctl enable squire-principals.service squire-docker.service squire-supervisor.service

# The exact base, runtime/helper bytes, OCI digest, and host conformance
# evidence are recorded by scripts/build-sandbox-template.mjs and the trusted
# promotion worker. This image is buildable, but never implicitly promoted.
LABEL org.squire.template.version="1" \
      org.squire.template.runtime-bundle="squirectl-v1" \
      org.squire.template.release-state="buildable-awaiting-external-conformance"
