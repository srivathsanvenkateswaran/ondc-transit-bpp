#!/usr/bin/env bash
# Shared helpers for the deploy/ scripts.
#
# Sourced, never executed. Every function here either succeeds or prints a
# named reason and returns non-zero. Nothing continues on a bad assumption.

# Repository root, derived from this file's location.
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"
RUNTIME_DIR="${DEPLOY_DIR}/runtime"

# beckn-onix revision. This is the revision stage-0/onix-sync/RESULTS.md records
# as the one that was installed, and the registry and gateway configuration
# templates are read from it rather than copied into this repository.
ONIX_REVISION="${ONIX_REVISION:-6f5aaede1994d4293a6bc992e6ee14f63cc63d29}"
ONIX_TARBALL_URL="${ONIX_TARBALL_URL:-https://codeload.github.com/beckn/beckn-onix/tar.gz/${ONIX_REVISION}}"

# Network the whole topology shares. stage-0/onix-sync/docker-compose.yml
# declares it `external: true`, so something has to create it. That something
# is deploy/bring-up.sh.
BECKN_NETWORK="${BECKN_NETWORK:-beckn_network}"

# Registry and gateway addresses as seen from the host.
REGISTRY_ADMIN_URL="${REGISTRY_ADMIN_URL:-http://127.0.0.1:3030}"
GATEWAY_ADMIN_URL="${GATEWAY_ADMIN_URL:-http://127.0.0.1:4030}"

# beckn-onix ships the registry and the gateway with these credentials, and the
# installer logs in with them non-interactively. They are local test
# credentials for a `.localhost` network that cannot resolve on the internet.
# Override both before exposing any of this beyond a private host.
REGISTRY_ADMIN_USER="${REGISTRY_ADMIN_USER:-root}"
REGISTRY_ADMIN_PASSWORD="${REGISTRY_ADMIN_PASSWORD:-root}"

# The domain the unreserved transit sellers are registered under.
ONDC_DOMAIN="${ONDC_DOMAIN:-ONDC:TRV11}"

# The domain the reserved intercity seller is registered under. A local,
# Beckn-shaped string under a reserved and unresolvable name; it claims
# conformance to nothing and sits in no namespace anybody else administers.
# See docs/reserved-intercity.md section 2.
#
# The gateway has no routing table of its own: it fans a search out to the
# subscribers the registry returns for the search's own domain. So the
# registry's network-domain row and the subscription under it are the routing
# entry, and there is nothing else to configure.
RESERVED_DOMAIN="${RESERVED_DOMAIN:-TRANSIT.LOCALHOST:INTERCITY}"

# Whether the reserved intercity seller is part of this deployment. Off unless
# asked for, so that a deployment that has not asked for a second domain gets
# exactly the network it got before.
#
# Compose reads .env for its own ${...} interpolation and these scripts do not,
# so the flag is read from the environment first and from .env second. Without
# that, the provider could come up with the category enabled while the scripts
# never started its protocol servers or registered it, which is the most
# confusing possible way for this to be half on.
reserved_enabled() {
  if [[ -n "${RESERVED_ENABLED:-}" ]]; then
    [[ "${RESERVED_ENABLED}" == "true" ]]
    return
  fi
  local value
  value="$(sed -n 's/^RESERVED_ENABLED=//p' "${REPO_ROOT}/.env" 2>/dev/null | head -n1 | tr -d '[:space:]')"
  [[ "${value}" == "true" ]]
}

if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BOLD=""; C_OFF=""
fi

log()   { printf '%s\n' "$*"; }
step()  { printf '\n%s==> %s%s\n' "${C_BOLD}" "$*" "${C_OFF}"; }
ok()    { printf '%s  ok%s   %s\n' "${C_GREEN}" "${C_OFF}" "$*"; }
warn()  { printf '%s  warn%s %s\n' "${C_YELLOW}" "${C_OFF}" "$*" >&2; }
die()   { printf '\n%sFAILED%s %s\n' "${C_RED}${C_BOLD}" "${C_OFF}" "$*" >&2; exit 1; }

# Announce a step before doing it, so a script that hangs says what it hung on.
announce() { printf '  .. %s\n' "$*"; }

require_cmd() {
  local cmd="$1" hint="${2:-}"
  command -v "${cmd}" >/dev/null 2>&1 && return 0
  if [[ -n "${hint}" ]]; then
    die "required command '${cmd}' is not installed. ${hint}"
  fi
  die "required command '${cmd}' is not installed."
}

# python-yq (kislyuk) and Go yq (mikefarah) share a binary name and share no
# syntax. stage-0/onix-sync/prepare-runtime.sh needs the python one: it calls
# `yq -yi --arg`, which the Go one does not understand. Test the flavour rather
# than the name.
yq_is_python_flavour() {
  command -v yq >/dev/null 2>&1 || return 1
  printf 'a: 1\n' | yq -y '.a' >/dev/null 2>&1
}

# Wait until a command succeeds. Prints one dot per attempt so a slow start
# looks like progress rather than a hang.
wait_until() {
  local label="$1" timeout_s="$2"; shift 2
  local waited=0 interval=3
  printf '  .. waiting for %s ' "${label}"
  while (( waited < timeout_s )); do
    if "$@" >/dev/null 2>&1; then
      printf ' ready after %ss\n' "${waited}"
      return 0
    fi
    printf '.'
    sleep "${interval}"
    waited=$(( waited + interval ))
  done
  printf ' TIMEOUT after %ss\n' "${timeout_s}"
  return 1
}

# Read a single top-level scalar out of a JSON document on stdin.
json_field() {
  python3 -c 'import json,sys
d = json.load(sys.stdin)
v = d.get(sys.argv[1])
if v is None:
    sys.exit(1)
print(v)' "$1"
}

# Ask before doing something destructive. Honours DEPLOY_ASSUME_YES=1 so the
# scripts can run from CI, but never assumes it.
confirm() {
  local prompt="$1"
  if [[ "${DEPLOY_ASSUME_YES:-0}" == "1" ]]; then
    log "  (--yes given) ${prompt}"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "${prompt} -- refusing, stdin is not a terminal and --yes was not given."
  fi
  local reply=""
  read -r -p "${prompt} Type 'yes' to continue: " reply
  [[ "${reply}" == "yes" ]]
}

# Fetch and unpack the pinned beckn-onix revision under deploy/runtime, unless
# ONIX_SRC already points at a checkout. Nothing is vendored into the
# repository; the templates are read from the upstream tree at the pinned
# revision so they cannot drift from what stage-0 recorded.
resolve_onix_src() {
  if [[ -n "${ONIX_SRC:-}" ]]; then
    [[ -d "${ONIX_SRC}/install" ]] || die "ONIX_SRC=${ONIX_SRC} does not look like a beckn-onix checkout (no install/ directory)."
    printf '%s\n' "${ONIX_SRC}"
    return 0
  fi

  local dest="${RUNTIME_DIR}/beckn-onix-${ONIX_REVISION}"
  if [[ -d "${dest}/install" ]]; then
    printf '%s\n' "${dest}"
    return 0
  fi

  announce "downloading beckn-onix ${ONIX_REVISION:0:12} (MIT, github.com/beckn/beckn-onix)" >&2
  mkdir -p "${dest}"
  local tarball="${RUNTIME_DIR}/beckn-onix-${ONIX_REVISION}.tar.gz"
  curl -fsSL -o "${tarball}" "${ONIX_TARBALL_URL}" \
    || die "could not download beckn-onix from ${ONIX_TARBALL_URL}. Set ONIX_SRC=/path/to/beckn-onix to use a local checkout instead."
  tar xzf "${tarball}" -C "${dest}" --strip-components=1 \
    || die "could not unpack ${tarball}."
  rm -f "${tarball}"
  [[ -d "${dest}/install" ]] || die "unpacked beckn-onix has no install/ directory."
  printf '%s\n' "${dest}"
}
