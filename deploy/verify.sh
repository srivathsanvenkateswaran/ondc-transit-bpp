#!/usr/bin/env bash
#
# Prove the one thing the demonstration depends on:
#
#   ONE POST /search, routed through the gateway, comes back with TWO on_search
#   callbacks carrying TWO DISTINCT BPP subscriber IDs under ONE transaction ID.
#
# Anything less than that is a failure and this script exits non-zero. A stack
# that is "up" but returns one callback, or zero, is a stack that cannot be
# demonstrated.
#
# The request is not invented. It is
# phase-2/evidence/stack-smoke-search-request.json, the broad search the author
# captured, with a fresh transaction_id, message_id and timestamp so the run is
# genuinely new rather than served from a cached response. Nothing in
# phase-1/ or phase-2/ is written to.
#
# Usage:
#     deploy/verify.sh [--keep N]
#
#   --keep N   keep the N most recent runs under deploy/runtime/verify
#              (default 10).
#
# Raw request and response bodies land in
# deploy/runtime/verify/<timestamp>/ and are not committed.
#
# Verification status
# -------------------
# VERIFIED by running: the precheck, the request build with fresh IDs, the
# request going out through the BAP and the gateway, the raw capture, every
# assertion, and a loud non-zero failure with the correct diagnosis when the
# network was not ready.
#
# UNVERIFIED: a passing run. This script has never printed VERIFICATION PASSED,
# because the only host available was arm64 under amd64 emulation and the stack
# did not complete the last hop there. The README section "What was verified,
# and what was not" says exactly where it stopped and why. A green result here
# has not been observed, so treat the first pass on a real x86_64 host as the
# first real evidence, not as a regression check.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

BAP_CLIENT_URL="${BAP_CLIENT_URL:-http://127.0.0.1:5001}"
PROVIDER_URL="${PROVIDER_URL:-http://127.0.0.1:7001}"
SEARCH_TEMPLATE="${REPO_ROOT}/phase-2/evidence/stack-smoke-search-request.json"
KEEP_RUNS=10

while (( $# )); do
  case "$1" in
    --keep) KEEP_RUNS="${2:?--keep needs a number}"; shift ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1'. Try --help." ;;
  esac
  shift
done

RUN_DIR="${RUNTIME_DIR}/verify/$(date -u +%Y%m%dT%H%M%SZ)"

precheck() {
  step "Precheck"
  require_cmd curl
  require_cmd python3

  [[ -f "${SEARCH_TEMPLATE}" ]] \
    || die "missing ${SEARCH_TEMPLATE}. This script reuses the author's captured broad search rather than inventing one."

  curl -fsS -m 10 -o /dev/null "${PROVIDER_URL}/healthz" \
    || die "the provider is not healthy at ${PROVIDER_URL}/healthz. Run deploy/bring-up.sh first."
  ok "provider healthy"

  curl -fsS -m 10 -o /dev/null -H 'Content-Type: application/json' -d '{}' \
    "${REGISTRY_ADMIN_URL}/subscribers/lookup" \
    || die "the registry is not answering at ${REGISTRY_ADMIN_URL}. Run deploy/bring-up.sh first."
  ok "registry answering"

  # A search that names a bpp_id would go straight to that BPP and would prove
  # nothing about the gateway. Refuse to run one.
  python3 -c '
import json, sys
ctx = json.load(open(sys.argv[1]))["context"]
if ctx.get("bpp_id") or ctx.get("bpp_uri"):
    sys.exit("the search template names a bpp_id or bpp_uri, so it would bypass the gateway")
' "${SEARCH_TEMPLATE}" || die "$(cat <<'EOF'
the search template addresses a BPP directly. This script must exercise the
gateway, which only happens when the context carries no bpp_id and no bpp_uri.
EOF
)"
  ok "search template carries no bpp_id, so the BAP must route it through the gateway"
}

build_request() {
  mkdir -p "${RUN_DIR}"
  python3 - "${SEARCH_TEMPLATE}" "${RUN_DIR}/search-request.json" <<'PY'
import datetime, json, sys, uuid

template, out = sys.argv[1], sys.argv[2]
body = json.load(open(template))
body["context"]["transaction_id"] = str(uuid.uuid4())
body["context"]["message_id"] = str(uuid.uuid4())
body["context"]["timestamp"] = (
    datetime.datetime.now(datetime.timezone.utc)
    .strftime("%Y-%m-%dT%H:%M:%S.000Z")
)
with open(out, "w") as fh:
    json.dump(body, fh, indent=2)
print(body["context"]["transaction_id"])
PY
}

main() {
  step "Verifying the local ONDC network"
  log "  One POST /search through the gateway must return two on_search callbacks"
  log "  from two distinct BPP subscriber IDs. Nothing less passes."

  precheck

  step "Sending the search"
  local transaction_id
  transaction_id="$(build_request)"
  log "  transaction_id ${transaction_id}"
  log "  request        ${RUN_DIR}/search-request.json"

  # Snapshot the gateway log position so the window below covers only this run.
  local gateway_log_before=0
  if docker ps --format '{{.Names}}' | grep -qx gateway; then
    gateway_log_before="$(docker logs gateway 2>&1 | wc -l | tr -d ' ')"
  fi

  local raw="${RUN_DIR}/search-response.raw.json"
  local timing="${RUN_DIR}/search-timing.txt"
  local http_status=""
  set +e
  http_status="$(curl -sS -m 90 -o "${raw}" \
    -w '%{http_code} %{time_total}' \
    -H 'Content-Type: application/json' \
    --data-binary @"${RUN_DIR}/search-request.json" \
    "${BAP_CLIENT_URL}/search")"
  local curl_status=$?
  set -e
  printf '%s\n' "${http_status}" > "${timing}"

  if (( curl_status != 0 )); then
    die "the search request to ${BAP_CLIENT_URL}/search failed at the transport level (curl exit ${curl_status}). Try: docker compose logs bap-client"
  fi
  log "  HTTP ${http_status%% *} in ${http_status##* }s"
  log "  response       ${raw}"

  # Capture the gateway's log window for this run as supporting evidence.
  local gateway_log="${RUN_DIR}/gateway-window.raw.txt"
  if docker ps --format '{{.Names}}' | grep -qx gateway; then
    docker logs gateway 2>&1 | tail -n +"$(( gateway_log_before + 1 ))" > "${gateway_log}" || true
  fi

  step "Assertions"
  if ! python3 - "${RUN_DIR}/search-request.json" "${raw}" "${http_status%% *}" <<'PY'
import json, sys

request_path, response_path, http_status = sys.argv[1], sys.argv[2], sys.argv[3]
request = json.load(open(request_path))
expected_txn = request["context"]["transaction_id"]

failures = []
checks = []


def check(ok_, label, detail=""):
    checks.append((ok_, label, detail))
    if not ok_:
        failures.append(f"{label}{': ' + detail if detail else ''}")


check(http_status == "200", "HTTP 200 from the BAP synchronous client",
      f"got HTTP {http_status}")

try:
    body = json.load(open(response_path))
except Exception as exc:                                  # noqa: BLE001
    print(f"  FAIL  response body is not JSON: {exc}", file=sys.stderr)
    print(f"        raw body kept at {response_path}", file=sys.stderr)
    sys.exit(1)

responses = body.get("responses")
check(isinstance(responses, list), "the response carries a `responses` array",
      f"got {type(responses).__name__}")
responses = responses if isinstance(responses, list) else []

check(len(responses) == 2, "exactly two callbacks came back",
      f"got {len(responses)}")

actions = [r.get("context", {}).get("action") for r in responses]
check(all(a == "on_search" for a in actions) and actions,
      "every callback is an on_search", f"actions were {actions}")

bpp_ids = [r.get("context", {}).get("bpp_id") for r in responses]
distinct = sorted({b for b in bpp_ids if b})
check(len(distinct) == 2,
      "the two callbacks come from two distinct BPP subscriber IDs",
      f"bpp_ids were {bpp_ids}")

txns = {r.get("context", {}).get("transaction_id") for r in responses}
check(txns == {expected_txn},
      "both callbacks carry the transaction ID that was sent",
      f"sent {expected_txn}, callbacks carried {sorted(t for t in txns if t)}")

# A callback that arrives with an empty catalogue is not a demonstrable result.
for response in responses:
    bpp = response.get("context", {}).get("bpp_id", "<no bpp_id>")
    providers = (
        response.get("message", {})
        .get("catalog", {})
        .get("providers", [])
    )
    check(bool(providers), f"{bpp} returned a non-empty catalogue",
          "its catalog.providers is empty")

    error = response.get("error")
    check(not error, f"{bpp} returned no error", json.dumps(error))

width = max(len(label) for _, label, _ in checks)
for ok_, label, detail in checks:
    mark = "PASS" if ok_ else "FAIL"
    line = f"  {mark}  {label.ljust(width)}"
    if not ok_ and detail:
        line += f"   {detail}"
    print(line)

if failures:
    sys.exit(1)

print()
print("  Two on_search callbacks, from:")
for bpp in distinct:
    print(f"    {bpp}")
print(f"  Both under transaction_id {expected_txn}")
PY
  then
    log ""
    die "VERIFICATION FAILED. The raw request and response are in ${RUN_DIR}. Start with: docker compose logs bap-client bmtc-bpp-client bmrcl-bpp-client transit-bpp"
  fi

  # Supporting, not decisive: the gateway's own log for this window. The
  # decisive proof of gateway routing is that the request named no bpp_id and
  # two different BPPs answered it.
  if [[ -s "${gateway_log:-}" ]]; then
    local lookups fanouts
    lookups="$(grep -ci 'lookup' "${gateway_log}" || true)"
    fanouts="$(grep -oEi 'https?://[a-z0-9._-]*bpp[a-z0-9._-]*(:[0-9]+)?' "${gateway_log}" | sort -u | wc -l | tr -d ' ')"
    log ""
    log "  gateway window ${gateway_log}"
    log "  ${lookups} registry lookup line(s), ${fanouts} distinct BPP URI(s) mentioned"
  fi

  # Keep the working directory from growing without bound.
  if [[ "${KEEP_RUNS}" =~ ^[0-9]+$ ]] && (( KEEP_RUNS > 0 )); then
    ( cd "${RUNTIME_DIR}/verify" && ls -1 | sort -r | tail -n +$(( KEEP_RUNS + 1 )) | xargs -r rm -rf ) || true
  fi

  step "${C_GREEN}VERIFICATION PASSED${C_OFF}"
  log ""
  log "  Evidence for this run: ${RUN_DIR}"
  log ""
}

main "$@"
