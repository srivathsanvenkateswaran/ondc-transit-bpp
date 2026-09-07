#!/usr/bin/env bash
#
# Non-interactive bring-up: a fresh x86_64 Ubuntu host with Docker, to a
# working local Beckn network, with no menu and no human in the loop.
#
# It replaces the one manual step stage-0/onix-sync/RESULTS.md records:
#
#     bash install/beckn-onix.sh
#     # selection: 4
#
# A menu is fine on a laptop and useless on a server. This script does what
# option 4 does for the two components we actually need, from the same upstream
# templates at the same pinned revision, and then does the four things option 4
# never did: create the Docker network, install the yq flavour
# prepare-runtime.sh needs, seed the registry so the subscribers' public keys
# match the generated runtime keys, and start the provider's own topology.
#
# Usage:
#     deploy/bring-up.sh [--yes] [--allow-non-x86] [--no-build]
#
#   --yes            do not prompt. Required when stdin is not a terminal.
#   --allow-non-x86  proceed on a non-x86_64 host. See README.md; RabbitMQ has
#                    crashed twice under ARM emulation on this stack.
#   --no-build       skip `--build` on the provider image; use whatever
#                    ondc-transit-bpp:local already exists.
#
# When it finishes, run deploy/verify.sh. That is the script that proves the
# network actually works. This one only proves it started.
#
# Verification status
# -------------------
# VERIFIED by running, on an arm64 macOS host under amd64 emulation: the
# preflight checks, network creation, config rendering, the registry and
# gateway coming up and answering, key generation through
# prepare-runtime.sh, and registry seeding, on both a first run and a rerun.
#
# Also verified: the backing services coming up ahead of the protocol servers,
# the RabbitMQ readiness wait, all six protocol servers reaching listening after
# a forced recreate, and the provider answering GET /healthz.
#
# UNVERIFIED: nothing in this file has been run on x86_64 Linux. No x86_64 host
# was available and none was contacted. Treat the first run on a real target as
# a first run.
#
# UNVERIFIED: the apt-get path in install_python_yq. This host has no apt.
#
# UNVERIFIED: the provider image build, because package-lock.json resolves from
# a private registry that a build container cannot reach. check_lockfile_registry
# below refuses to pretend otherwise.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

ALLOW_NON_X86=0
DO_BUILD=1

while (( $# )); do
  case "$1" in
    --yes|-y)        DEPLOY_ASSUME_YES=1 ;;
    --allow-non-x86) ALLOW_NON_X86=1 ;;
    --no-build)      DO_BUILD=0 ;;
    -h|--help)       sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               die "unknown argument '$1'. Try --help." ;;
  esac
  shift
done
export DEPLOY_ASSUME_YES="${DEPLOY_ASSUME_YES:-0}"

# ---------------------------------------------------------------------------

preflight() {
  step "Preflight"

  require_cmd docker "Install Docker Engine: https://docs.docker.com/engine/install/ubuntu/"
  require_cmd curl   "On Ubuntu: sudo apt-get install -y curl"
  require_cmd tar
  require_cmd python3 "On Ubuntu: sudo apt-get install -y python3"

  docker compose version >/dev/null 2>&1 \
    || die "the Docker Compose v2 plugin is missing. On Ubuntu: sudo apt-get install -y docker-compose-plugin"
  docker info >/dev/null 2>&1 \
    || die "cannot talk to the Docker daemon. Is it running, and is this user in the 'docker' group?"
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') and compose plugin present"

  local arch; arch="$(uname -m)"
  if [[ "${arch}" != "x86_64" ]]; then
    warn "this host is ${arch}, not x86_64."
    warn "Every image in this topology is pinned linux/amd64 and would run under emulation."
    warn "RabbitMQ has crashed twice under that emulation on this stack: 3.8 segfaulted,"
    warn "and 3.13 died with an Erlang {badmap,provided_by}. See README.md."
    if (( ALLOW_NON_X86 == 0 )); then
      die "refusing to continue on ${arch}. Pass --allow-non-x86 if you accept that the message queue may die."
    fi
    confirm "Continue on ${arch} anyway?" || die "stopped at the architecture check."
  else
    ok "x86_64 host; amd64 image pinning is native here"
  fi

  # Roughly 1.5 GB resident for the whole topology, measured under emulation.
  # Ask for headroom rather than the exact figure.
  if [[ -r /proc/meminfo ]]; then
    local total_mb; total_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
    if (( total_mb < 3000 )); then
      warn "this host reports ${total_mb} MB of RAM. The topology needs about 1500 MB resident plus room to build."
      confirm "Continue with ${total_mb} MB?" || die "stopped at the memory check."
    else
      ok "${total_mb} MB RAM, comfortably above the ~1500 MB the topology needs"
    fi
  else
    warn "cannot read /proc/meminfo; skipping the memory check. Budget about 1500 MB resident."
  fi

  if yq_is_python_flavour; then
    ok "yq present and is the python (kislyuk) flavour prepare-runtime.sh needs"
  else
    install_python_yq
  fi

  check_lockfile_registry
}

# The provider image is built from package-lock.json inside a container that
# has only public internet. If the lockfile pins its tarballs to a private
# registry, `npm ci` cannot reach it and hangs until npm's five minute fetch
# timeout, then dies with "Exit handler never called!" and no mention of a
# host. Say which host, here, before anything else is started.
check_lockfile_registry() {
  local lock="${REPO_ROOT}/package-lock.json"
  [[ -f "${lock}" ]] || die "no package-lock.json at the repository root."

  local private_hosts
  private_hosts="$(python3 -c '
import json, sys
from urllib.parse import urlparse

public = {"registry.npmjs.org"}
hosts = set()
for entry in json.load(open(sys.argv[1])).get("packages", {}).values():
    resolved = entry.get("resolved")
    if resolved and resolved.startswith("http"):
        host = urlparse(resolved).netloc
        if host not in public:
            hosts.add(host)
print(" ".join(sorted(hosts)))' "${lock}")"

  if [[ -z "${private_hosts}" ]]; then
    ok "package-lock.json resolves from the public npm registry"
    return 0
  fi

  warn "package-lock.json resolves its tarballs from: ${private_hosts}"
  warn "The provider image build runs 'npm ci' inside a container with only public"
  warn "internet. Unless this host can reach that registry, the build will hang for"
  warn "npm's five minute fetch timeout and then fail with 'Exit handler never called!'."
  warn ""
  warn "Fix it at the source, on a machine that can reach the public registry:"
  warn "    rm package-lock.json && npm install --registry=https://registry.npmjs.org"
  warn "then commit the regenerated lockfile."
  warn ""
  warn "Or build the provider image yourself and rerun this script with --no-build."

  confirm "Continue anyway? The build will probably fail." \
    || die "stopped at the lockfile registry check."
}

# stage-0/onix-sync/prepare-runtime.sh calls `yq -yi --arg`, which only the
# python yq understands. It does not declare the dependency, and it failed on a
# host without it. Declare and install it here; prepare-runtime.sh now also
# refuses to start without it rather than failing halfway through.
install_python_yq() {
  if command -v yq >/dev/null 2>&1; then
    warn "a 'yq' is installed but it is not the python (kislyuk) flavour."
    warn "prepare-runtime.sh calls 'yq -yi --arg', which the Go (mikefarah) yq does not support."
    die "install python-yq, e.g. 'sudo apt-get install -y yq' on Ubuntu, or 'pipx install yq', and put it ahead of the other one on PATH."
  fi

  warn "yq is not installed. stage-0/onix-sync/prepare-runtime.sh requires it."
  if ! command -v apt-get >/dev/null 2>&1; then
    die "install python-yq (https://github.com/kislyuk/yq) and rerun. On Ubuntu this is 'sudo apt-get install -y yq'."
  fi

  confirm "Install the 'yq' and 'jq' packages with apt-get? This changes system packages." \
    || die "yq is required. Install it and rerun."

  announce "apt-get install -y yq jq"
  local sudo_cmd=""
  [[ "$(id -u)" != "0" ]] && sudo_cmd="sudo"
  ${sudo_cmd} apt-get update -qq || die "apt-get update failed."
  ${sudo_cmd} apt-get install -y -qq yq jq || die "apt-get install of yq and jq failed."

  yq_is_python_flavour \
    || die "installed 'yq' still is not the python flavour. Install https://github.com/kislyuk/yq and put it first on PATH."
  ok "python-yq installed"
}

# ---------------------------------------------------------------------------

create_network() {
  step "Docker network"
  # stage-0/onix-sync/docker-compose.yml declares beckn_network as
  # `external: true` and nothing in the repository creates it. A fresh host has
  # no such network, so `docker compose up` fails before it starts anything.
  if docker network inspect "${BECKN_NETWORK}" >/dev/null 2>&1; then
    ok "network ${BECKN_NETWORK} already exists"
  else
    announce "creating network ${BECKN_NETWORK}"
    docker network create --driver bridge "${BECKN_NETWORK}" >/dev/null \
      || die "could not create the Docker network ${BECKN_NETWORK}."
    ok "network ${BECKN_NETWORK} created"
  fi
}

render_network_config() {
  step "Rendering registry and gateway configuration"

  local onix_src; onix_src="$(resolve_onix_src)"
  local onix_install="${onix_src}/install"
  [[ -f "${onix_install}/registry_data/config/swf.properties-sample" ]] \
    || die "beckn-onix at ${onix_src} has no registry_data/config/swf.properties-sample."
  ok "beckn-onix templates: ${onix_src}"

  local reg_out="${RUNTIME_DIR}/registry-config"
  local gw_out="${RUNTIME_DIR}/gateway-config"
  rm -rf "${reg_out}" "${gw_out}"
  mkdir -p "${reg_out}" "${gw_out}/networks"

  # Registry. Substitutions are exactly the installer's update_registry_details
  # with its no-argument defaults: host `registry`, port 3030, scheme http.
  cp "${onix_install}/registry_data/config/envvars" \
     "${onix_install}/registry_data/config/logger.properties" "${reg_out}/"
  sed -e 's|REGISTRY_URL|registry|g' \
      -e 's|REGISTRY_PORT|3030|g' \
      -e 's|PROTOCOL|http|g' \
      "${onix_install}/registry_data/config/swf.properties-sample" > "${reg_out}/swf.properties"
  if grep -q 'REGISTRY_URL\|REGISTRY_PORT' "${reg_out}/swf.properties"; then
    die "registry swf.properties still contains an unsubstituted placeholder."
  fi
  ok "registry config rendered to ${reg_out}"

  # Gateway. Substitutions are the installer's update_gateway_config and
  # update_network_json with their no-argument defaults. SUBSCRIBER_ID matters:
  # leave it and the gateway registers itself in the registry under the literal
  # string "SUBSCRIBER_ID", which looks like a working network until the first
  # signature check.
  cp "${onix_install}/gateway_data/config/envvars" \
     "${onix_install}/gateway_data/config/logger.properties" "${gw_out}/"
  sed -e 's|SUBSCRIBER_ID|gateway|g' \
      -e 's|GATEWAY_URL|gateway|g' \
      -e 's|GATEWAY_PORT|4030|g' \
      -e 's|PROTOCOL|http|g' \
      "${onix_install}/gateway_data/config/swf.properties-sample" > "${gw_out}/swf.properties"
  sed -e 's|GATEWAY_ID|gateway|g' \
      -e 's|REGISTRY_ID|registry|g' \
      -e 's|REGISTRY_URL|http://registry:3030|g' \
      "${onix_install}/gateway_data/config/networks/onix.json-sample" > "${gw_out}/networks/onix.json"
  add_gateway_domain "${gw_out}/networks/onix.json"
  if grep -q 'SUBSCRIBER_ID\|GATEWAY_URL\|GATEWAY_PORT' "${gw_out}/swf.properties"; then
    die "gateway swf.properties still contains an unsubstituted placeholder."
  fi
  if grep -q 'GATEWAY_ID\|REGISTRY_ID\|REGISTRY_URL' "${gw_out}/networks/onix.json"; then
    die "gateway onix.json still contains an unsubstituted placeholder."
  fi
  ok "gateway config rendered to ${gw_out}"
}

# beckn-onix's onix.json-sample declares a network with no domains in it and a
# core_version of 1.1.0. Neither is usable for ONDC:TRV11 2.0.1, and neither
# failure announces itself:
#
#   - With no matching entry in `domains`, the gateway throws
#     NullPointerException: Cannot invoke "NetworkAdaptor$Domain
#     .getExtensionPackage()" because ... Domains.get(String) is null
#     on POST /bg/search, before it looks anything up. The BAP still gets an
#     HTTP 200 with an empty `responses` array.
#
#   - With `domains` present but core_version left at 1.1.0, the gateway does
#     the registry lookup, finds both BPPs, logs the outbound curl for each,
#     and then never opens the connection. Nothing is logged as an error.
#     Setting core_version to the domain's version makes the fan-out go out on
#     the wire. That was established by pointing a BPP's registered
#     subscriber_url at a bare HTTP sink and watching it arrive or not.
#
# Both were manual steps in whatever install produced the Phase 2 evidence.
# Neither is written down anywhere upstream.
add_gateway_domain() {
  local file="$1"
  python3 - "${file}" "${ONDC_DOMAIN}" "${ONDC_CORE_VERSION:-2.0.1}" <<'PY'
import json, sys

path, domain, version = sys.argv[1], sys.argv[2], sys.argv[3]
config = json.load(open(path))
config["core_version"] = version
config["domains"] = [{
    "id": domain,
    "name": domain,
    "version": version,
    "extension_package": config.get("extension_package", "in.succinct.beckn.boc"),
}]
with open(path, "w") as fh:
    json.dump(config, fh, indent=4)
PY
  ok "gateway network declares ${ONDC_DOMAIN} at core_version ${ONDC_CORE_VERSION:-2.0.1}"
}

start_network() {
  step "Starting the registry and the gateway"
  log "  Two amd64 JVM containers. On a cold host they take about a minute each."
  docker compose -f "${DEPLOY_DIR}/network.compose.yml" up -d \
    || die "could not start the registry and gateway. Try: docker compose -f deploy/network.compose.yml logs"

  wait_until "the registry at ${REGISTRY_ADMIN_URL}" 300 \
    curl -fsS -m 5 -o /dev/null -H 'Content-Type: application/json' -d '{"type":"LREG"}' \
      "${REGISTRY_ADMIN_URL}/subscribers/lookup" \
    || die "the registry never answered POST /subscribers/lookup. Try: docker logs registry"
  ok "registry answering"

  # The gateway writes its own subscriber record into the registry on first
  # boot. Wait for that record rather than for the port, so seeding has
  # something to subscribe.
  wait_until "the gateway to register itself in the registry" 300 \
    bash -c "curl -fsS -m 5 -H 'Content-Type: application/json' -d '{\"type\":\"BG\"}' \
      '${REGISTRY_ADMIN_URL}/subscribers/lookup' | grep -q subscriber_id" \
    || die "the gateway never registered itself. Try: docker logs gateway"
  ok "gateway registered itself in the registry"
}

# ---------------------------------------------------------------------------

ensure_env_file() {
  step "Provider environment"
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    ok ".env already present; leaving it alone"
  else
    cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
    ok ".env created from .env.example"
  fi
}

generate_keys() {
  step "Generating ONIX signing keys"
  log "  stage-0/onix-sync/prepare-runtime.sh generates a fresh key pair per identity"
  log "  and renders the six ONIX configs. Private keys stay in ignored runtime files."
  bash "${REPO_ROOT}/stage-0/onix-sync/prepare-runtime.sh" \
    || die "prepare-runtime.sh failed. Its output is above."
  [[ -s "${REPO_ROOT}/stage-0/onix-sync/runtime/public-keys.tsv" ]] \
    || die "prepare-runtime.sh produced no public-keys.tsv."
  ok "six ONIX configs rendered, three key pairs generated"
}

seed_registry() {
  bash "${DEPLOY_DIR}/seed-registry.sh" \
    || die "registry seeding failed. Nothing downstream will work until it passes, because all six ONIX services run with auth: true."
}

start_stack() {
  step "Starting the six protocol servers and the provider"

  # Two things have to be right here and neither is free.
  #
  # First, --force-recreate. prepare-runtime.sh has just rewritten the six ONIX
  # config files in place. A protocol server reads its config once, at startup,
  # and those files are bind-mounted, so a plain `docker compose up -d` sees no
  # change and leaves an already-running container holding the previous private
  # key. The registry now holds the new public key, so every signed request
  # from that container would be rejected with a 401 that points nowhere near
  # the cause. Recreating costs nothing on a first run.
  #
  # Second, ordering. The protocol servers `depends_on` Mongo, Redis and
  # RabbitMQ, but depends_on without a condition only orders the start, it does
  # not wait for readiness. A protocol server that finds RabbitMQ still booting
  # logs MQ_ConnectionFailed and exits 0, which looks like a clean shutdown.
  # Recreating everything at once makes that near certain. So bring the backing
  # services up first, wait for the queue, and only then start the rest.
  announce "starting Mongo, Redis and RabbitMQ"
  ( cd "${REPO_ROOT}" && docker compose up -d --force-recreate sync-mongo sync-redis sync-rabbitmq ) \
    || die "could not start Mongo, Redis and RabbitMQ. Try: docker compose logs"

  if ! wait_until "RabbitMQ to accept connections" 300 \
      bash -c "cd '${REPO_ROOT}' && docker compose exec -T sync-rabbitmq rabbitmq-diagnostics -q check_port_connectivity"; then
    warn "Check 'docker compose logs sync-rabbitmq'. An Erlang {badmap,provided_by} or a"
    warn "segfault there is the ARM emulation failure the README's x86_64 section describes."
    die "RabbitMQ never came up. Without a queue the BPP protocol servers receive nothing."
  fi
  ok "RabbitMQ accepting connections"

  announce "starting the protocol servers and the provider"
  local recreate_args=(--force-recreate --no-deps)
  if (( DO_BUILD == 1 )); then
    recreate_args+=(--build)
  fi
  # The reserved intercity seller is a second pair of protocol servers on a
  # second domain, and it only comes up when the deployment has asked for it.
  # A run without RESERVED_ENABLED starts exactly the topology it started
  # before.
  local reserved_services=()
  if reserved_enabled; then
    reserved_services=(ksrtc-bpp-client ksrtc-bpp-network)
  fi
  ( cd "${REPO_ROOT}" && docker compose up -d "${recreate_args[@]}" \
      bap-client bap-network \
      bmtc-bpp-client bmtc-bpp-network \
      bmrcl-bpp-client bmrcl-bpp-network \
      ${reserved_services[@]+"${reserved_services[@]}"} \
      transit-bpp ) \
    || die "could not start the provider topology. Try: docker compose logs"

  local provider_port; provider_port="$(grep -E '^PROVIDER_PORT=' "${REPO_ROOT}/.env" | cut -d= -f2)"
  provider_port="${provider_port:-7001}"

  wait_until "the provider at http://127.0.0.1:${provider_port}/healthz" 180 \
    curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${provider_port}/healthz" \
    || die "the provider never became healthy. Try: docker compose logs transit-bpp"
  ok "provider healthy"

  # Each protocol server compiles the mounted TRV11 2.0.1 OpenAPI schema before
  # it opens its port. That took about 55 seconds per server here, and all six
  # do it at once, so the window has to be generous.
  local port
  for port in 5001 5002 6001 6002 6101 6102; do
    wait_until "ONIX port ${port}" "${ONIX_PORT_TIMEOUT_S:-900}" \
      bash -c "curl -sS -m 5 -o /dev/null 'http://127.0.0.1:${port}/' 2>/dev/null || curl -sS -m 5 -o /dev/null 'http://127.0.0.1:${port}/healthz' 2>/dev/null" \
      || die "ONIX port ${port} never opened. Try: docker compose logs"
  done
  ok "all six ONIX protocol servers listening"
}

# ---------------------------------------------------------------------------

main() {
  step "ONDC transit BPP: non-interactive bring-up"
  log "  This will, in order:"
  log "    1. check prerequisites and install python-yq if it is missing"
  log "    2. create the external Docker network ${BECKN_NETWORK}"
  log "    3. render and start the beckn-onix registry and gateway"
  log "    4. generate fresh ONIX signing keys"
  log "    5. seed the registry so those keys match"
  log "    6. build and start the six protocol servers and the provider"
  log "  Nothing here is destructive. To remove it all, run deploy/teardown.sh."

  mkdir -p "${RUNTIME_DIR}"

  preflight
  create_network
  render_network_config
  start_network
  ensure_env_file
  generate_keys
  seed_registry
  start_stack

  step "${C_GREEN}Bring-up complete${C_OFF}"
  log ""
  log "  registry   http://127.0.0.1:3030   (POST /subscribers/lookup)"
  log "  gateway    http://127.0.0.1:4030"
  log "  BAP client http://127.0.0.1:5001   (POST /search)"
  log "  provider   http://127.0.0.1:7001   (GET /healthz)"
  log ""
  log "  This says the stack started. It does not say the network works."
  log "  Run the script that proves that:"
  log ""
  log "      deploy/verify.sh"
  log ""
}

main "$@"
