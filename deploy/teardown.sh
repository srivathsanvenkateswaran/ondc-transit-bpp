#!/usr/bin/env bash
#
# Stop everything this deployment started and remove its volumes, so the next
# deploy/bring-up.sh starts from nothing.
#
# This is destructive and says so before doing anything. It asks once, listing
# exactly what it will remove. Pass --yes only when you have read that list
# somewhere else.
#
# Usage:
#     deploy/teardown.sh [--yes] [--keep-images] [--keep-runtime]
#
#   --yes           do not prompt.
#   --keep-images   do not offer to remove the pulled images.
#   --keep-runtime  keep deploy/runtime/ (rendered config, verification
#                   evidence, the cached beckn-onix checkout).
#
# What it removes, and why all of it has to go together
# -----------------------------------------------------
# The registry stores each subscriber's signing public key. The gateway stores
# its own private key in its own database. The protocol servers hold the
# private keys prepare-runtime.sh generated. Keeping any one of those three
# while discarding another leaves a network whose signatures do not verify, and
# the symptom is a 401 several layers away from the cause. So teardown removes
# all of them or none.
#
# Verification status
# -------------------
# VERIFIED by running, on an arm64 macOS host under amd64 emulation, against a
# stack deploy/bring-up.sh had brought up: both Compose projects came down with
# their volumes, beckn_network was removed, stage-0/onix-sync/runtime/ and
# deploy/runtime/ were removed, and the registry and gateway images were
# removed. Nothing from either project was left in `docker ps -a` or
# `docker network ls`.
#
# UNVERIFIED on x86_64 Linux, and unverified against a registry or gateway
# container that some other tool started. The stray-container prompt exists for
# that case but was not exercised.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

KEEP_IMAGES=0
KEEP_RUNTIME=0

while (( $# )); do
  case "$1" in
    --yes|-y)       DEPLOY_ASSUME_YES=1 ;;
    --keep-images)  KEEP_IMAGES=1 ;;
    --keep-runtime) KEEP_RUNTIME=1 ;;
    -h|--help)      sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "unknown argument '$1'. Try --help." ;;
  esac
  shift
done
export DEPLOY_ASSUME_YES="${DEPLOY_ASSUME_YES:-0}"

RUNTIME_KEY_DIR="${REPO_ROOT}/stage-0/onix-sync/runtime"

main() {
  step "Teardown"
  log "  This is destructive. It will remove:"
  log ""
  log "    - the six protocol servers, the provider, Mongo, Redis and RabbitMQ"
  log "      (docker compose down -v, at the repository root)"
  log "    - the registry and the gateway, with their databases"
  log "      (docker compose -f deploy/network.compose.yml down -v)"
  log "    - the Docker network ${BECKN_NETWORK}"
  log "    - the generated ONIX signing keys and rendered configs in"
  log "      stage-0/onix-sync/runtime/"
  if (( KEEP_RUNTIME == 0 )); then
    log "    - deploy/runtime/ (rendered registry and gateway config, verification"
    log "      evidence, the cached beckn-onix checkout)"
  fi
  log ""
  log "  It will NOT touch .env, phase-1/, phase-2/, stage-0/onix-sync/config/"
  log "  or anything else tracked in git."
  log ""

  confirm "Remove all of the above?" || die "teardown cancelled; nothing was changed."

  step "Stopping the provider topology"
  if [[ -f "${REPO_ROOT}/docker-compose.yml" ]]; then
    ( cd "${REPO_ROOT}" && docker compose down -v --remove-orphans ) \
      || warn "docker compose down at the repository root reported an error; continuing."
    ok "provider topology and its volumes removed"
  fi

  step "Stopping the registry and the gateway"
  docker compose -f "${DEPLOY_DIR}/network.compose.yml" down -v --remove-orphans \
    || warn "docker compose down for the network reported an error; continuing."
  # The upstream compose files use fixed container names, so a container left
  # behind by a hand-run beckn-onix installer would block the next bring-up.
  local name
  for name in registry gateway; do
    if docker ps -a --format '{{.Names}}' | grep -qx "${name}"; then
      warn "a container named '${name}' is still present; it was not started by deploy/network.compose.yml."
      if confirm "Remove the container '${name}'?"; then
        docker rm -f "${name}" >/dev/null && ok "removed ${name}"
      fi
    fi
  done
  ok "registry and gateway removed with their databases"

  step "Removing the Docker network"
  if docker network inspect "${BECKN_NETWORK}" >/dev/null 2>&1; then
    docker network rm "${BECKN_NETWORK}" >/dev/null \
      && ok "network ${BECKN_NETWORK} removed" \
      || warn "could not remove ${BECKN_NETWORK}; something is still attached. Run 'docker network inspect ${BECKN_NETWORK}'."
  else
    ok "network ${BECKN_NETWORK} already gone"
  fi

  step "Removing generated keys"
  if [[ -d "${RUNTIME_KEY_DIR}" ]]; then
    rm -rf "${RUNTIME_KEY_DIR}"
    ok "stage-0/onix-sync/runtime/ removed (generated keys and rendered ONIX configs)"
  else
    ok "stage-0/onix-sync/runtime/ already gone"
  fi

  if (( KEEP_RUNTIME == 0 )); then
    step "Removing deploy/runtime"
    rm -rf "${RUNTIME_DIR}"
    ok "deploy/runtime/ removed"
  fi

  if (( KEEP_IMAGES == 0 )); then
    step "Images"
    log "  The pulled images are about 1.4 GB: protocol-server 446 MB, mongo 594 MB,"
    log "  rabbitmq 277 MB, redis 46 MB, plus registry and gateway."
    if confirm "Also remove the pulled registry and gateway images?"; then
      docker rmi fidedocker/registry:latest fidedocker/gateway:latest >/dev/null 2>&1 \
        && ok "registry and gateway images removed" \
        || warn "could not remove one or both images; they may be in use."
    else
      log "  images kept"
    fi
  fi

  step "${C_GREEN}Teardown complete${C_OFF}"
  log ""
  log "  deploy/bring-up.sh will now start from nothing."
  log ""
}

main "$@"
