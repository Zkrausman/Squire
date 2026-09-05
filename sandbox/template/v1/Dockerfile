# Squire restricted sandbox template v1.
# BLOCKED until the release builder is given an operator-approved immutable
# base image and an external v0.39.0 conformance record. No mutable tag or
# default digest is permitted here.
ARG SQUIRE_BASE_IMAGE
ARG SQUIRE_BASE_DIGEST
FROM ${SQUIRE_BASE_IMAGE}@${SQUIRE_BASE_DIGEST}

COPY config/principals-and-mounts.sh /opt/squire/build/principals-and-mounts.sh
COPY config/rootless-docker.sh /opt/squire/build/rootless-docker.sh
COPY supervisor/squire-supervisor.service /etc/systemd/system/squire-supervisor.service
RUN chmod 0555 /opt/squire/build/principals-and-mounts.sh /opt/squire/build/rootless-docker.sh

# The production build script must replace these build-only files with the
# digest-recorded squirectl/supervisor/runtime bundle before promotion.
LABEL org.squire.template.version="1" \
      org.squire.template.release-state="blocked-until-external-conformance"
