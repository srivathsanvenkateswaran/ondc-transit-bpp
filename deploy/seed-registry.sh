#!/usr/bin/env bash
#
# Seed the local beckn-onix registry with the four subscribers this network
# needs, using the signing public keys that
# stage-0/onix-sync/prepare-runtime.sh just generated.
#
# Why this exists
# ---------------
# phase-2/RESULTS.md marks acceptance criterion 1 PARTIAL in the author's own
# words: "it has no `make seed` target". All six ONIX services now run with
# `auth: true`, so every request between participants is signed. If the public
# key in the registry is not byte-identical to the private key the protocol
# server holds, every signed request is rejected and the demo produces nothing
# but 401s. This script is what makes those two agree.
#
# What it does, in order
# ----------------------
#   1. Log in to the registry admin API and take an ApiKey.
#   2. Create the ONDC:TRV11 network domain if it is missing, and, when
#      RESERVED_ENABLED=true, the TRANSIT.LOCALHOST:INTERCITY domain as well.
#      The registry rejects `POST /subscribers/register` with "Invalid domain"
#      until the domain exists, and nothing in beckn-onix's option-4 path
#      creates it. The domain row is also the gateway's routing entry: the
#      gateway has no routing table of its own, and fans a search out to the
#      subscribers the registry returns for that search's own domain.
#   3. Register the BAP and the two BPP subscribers, or update their keys if
#      they are already there, plus the reserved intercity seller when it is
#      enabled.
#   4. Move each of them, and the gateway's own self-registered record, from
#      INITIATED to SUBSCRIBED. The registry creates every record INITIATED and
#      the gateway lookup only returns SUBSCRIBED ones.
#   5. Prove, through the same `POST /subscribers/lookup` the gateway uses,
#      that all four are SUBSCRIBED and that each signing public key matches
#      the generated runtime key exactly.
#
# It is idempotent. Running it twice is a no-op; running it after
# prepare-runtime.sh regenerates keys rotates the registry's copy to match.
#
# Verification status
# -------------------
# VERIFIED by running, against fidedocker/registry:latest
# (sha256:17f42783b7571439c28f990a813a7012319fcbbf7c9761d4bd57c6cead7b6bb2)
# under amd64 emulation on an arm64 macOS host:
#   - login, domain creation, all three registrations, the INITIATED to
#     SUBSCRIBED transition, and both lookup assertions, on an empty registry;
#   - a second run after prepare-runtime.sh regenerated every key, which took
#     the "Cannot modify key attributes" path and rotated all three stored keys.
#
# UNVERIFIED on x86_64 Linux. No x86_64 host was available and none was
# contacted. Nothing here is architecture-specific, but the first run on a real
# target should be treated as a first run.

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

RUNTIME_CONFIG_DIR="${REPO_ROOT}/stage-0/onix-sync/runtime/config"
PUBLIC_KEYS_TSV="${REPO_ROOT}/stage-0/onix-sync/runtime/public-keys.tsv"

# Validity window written on each registered key. Long, because these are local
# test identities under a reserved .localhost name, and an expired key in a
# demo looks exactly like a broken signature.
VALID_FROM="${VALID_FROM:-$(date -u -d '-1 day' +'%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || date -u -v-1d +'%Y-%m-%dT%H:%M:%S.000Z')}"
VALID_UNTIL="${VALID_UNTIL:-$(date -u -d '+5 years' +'%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || date -u -v+5y +'%Y-%m-%dT%H:%M:%S.000Z')}"

API_KEY=""

registry_login() {
  announce "logging in to ${REGISTRY_ADMIN_URL} as ${REGISTRY_ADMIN_USER}"
  local body
  body="$(curl -fsS -m 30 \
    -H 'Accept: application/json' -H 'Content-Type: application/json' \
    -d "{\"Name\":\"${REGISTRY_ADMIN_USER}\",\"Password\":\"${REGISTRY_ADMIN_PASSWORD}\"}" \
    "${REGISTRY_ADMIN_URL}/login")" \
    || die "registry login failed. Is the registry up? Try: docker logs registry"
  API_KEY="$(printf '%s' "${body}" | json_field api_key)" \
    || die "registry login returned no api_key. Response was: ${body}"
  ok "registry admin API key obtained"
}

# GET a registry admin collection as JSON.
registry_get() {
  curl -fsS -m 30 -H "ApiKey:${API_KEY}" -H 'Accept: application/json' "${REGISTRY_ADMIN_URL}/$1"
}

# POST a JSON body to a registry admin model's save action. The registry accepts
# snake_case JSON here; the form-encoded variant the admin UI uses tries to
# INSERT rather than UPDATE and fails on a NOT NULL column.
registry_save() {
  curl -fsS -m 30 -X POST \
    -H "ApiKey:${API_KEY}" -H 'Accept: application/json' -H 'Content-Type: application/json' \
    -d "$2" "${REGISTRY_ADMIN_URL}/$1"
}

ensure_domain() {
  local domain="$1" description="$2" existing
  existing="$(registry_get network_domains | python3 -c '
import json, sys
want = sys.argv[1]
print("yes" if any(d.get("name") == want for d in json.load(sys.stdin)) else "no")' "${domain}")" \
    || die "could not read network_domains from the registry."

  if [[ "${existing}" == "yes" ]]; then
    ok "network domain ${domain} already present"
    return 0
  fi

  announce "creating network domain ${domain}"
  curl -fsS -m 30 -o /dev/null -X POST -H "ApiKey:${API_KEY}" \
    --data-urlencode "Name=${domain}" \
    --data-urlencode "Description=${description}" \
    "${REGISTRY_ADMIN_URL}/network_domains/save" \
    || die "could not create network domain ${domain}."

  registry_get network_domains | python3 -c '
import json, sys
want = sys.argv[1]
if not any(d.get("name") == want for d in json.load(sys.stdin)):
    sys.exit(1)' "${domain}" \
    || die "created network domain ${domain} but the registry does not list it."
  ok "network domain ${domain} created"
}

# Read one `app.<key>: <value>` line out of a rendered ONIX runtime config.
# Reading these rather than restating them is what keeps the registry record
# and the running protocol server from drifting apart.
# yq writes YAML, so values containing a colon come back quoted:
# `subscriberUri: 'http://bap-network:5002'`. Strip the quotes and any trailing
# carriage return before using the value.
onix_config_value() {
  local file="$1" key="$2" value
  [[ -f "${file}" ]] || die "expected rendered ONIX config ${file}. Run stage-0/onix-sync/prepare-runtime.sh first."
  value="$(sed -n "s/^[[:space:]]*${key}:[[:space:]]*//p" "${file}" | head -n1)"
  value="${value%$'\r'}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value#[\"\']}"
  value="${value%[\"\']}"
  [[ -n "${value}" ]] || die "no '${key}' found in ${file}."
  printf '%s\n' "${value}"
}

public_key_for() {
  local prefix="$1" value
  [[ -f "${PUBLIC_KEYS_TSV}" ]] || die "expected ${PUBLIC_KEYS_TSV}. Run stage-0/onix-sync/prepare-runtime.sh first."
  value="$(awk -F'\t' -v p="${prefix}" '$1 == p { print $2; exit }' "${PUBLIC_KEYS_TSV}")"
  [[ -n "${value}" ]] || die "no public key for '${prefix}' in ${PUBLIC_KEYS_TSV}."
  printf '%s\n' "${value}"
}

# Register one subscriber, or bring an existing record's key up to date.
seed_subscriber() {
  local prefix="$1" type="$2" network_config="$3" domain="${4:-${ONDC_DOMAIN}}"
  local subscriber_id unique_key subscriber_uri country city public_key

  subscriber_id="$(onix_config_value "${network_config}" subscriberId)"
  subscriber_uri="$(onix_config_value "${network_config}" subscriberUri)"
  unique_key="$(onix_config_value "${network_config}" uniqueKey)"
  country="$(onix_config_value "${network_config}" country)"
  city="$(onix_config_value "${network_config}" city)"
  public_key="$(public_key_for "${prefix}")"

  announce "${type} ${subscriber_id} key=${unique_key} uri=${subscriber_uri} domain=${domain}"

  local payload
  payload="$(python3 -c '
import json, sys
sid, kid, url, domain, key, vf, vu, typ, country, city = sys.argv[1:]
print(json.dumps({
    "subscriber_id": sid,
    "pub_key_id": kid,
    "unique_key_id": kid,
    "subscriber_url": url,
    "domain": domain,
    "extended_attributes": {"domains": []},
    "encr_public_key": key,
    "signing_public_key": key,
    "valid_from": vf,
    "valid_until": vu,
    "type": typ,
    "country": country,
    "city": city,
    "status": "SUBSCRIBED",
}))' "${subscriber_id}" "${unique_key}" "${subscriber_uri}" "${ONDC_DOMAIN}" \
     "${public_key}" "${VALID_FROM}" "${VALID_UNTIL}" "${type}" "${country}" "${city}")"

  local response http_status
  response="$(curl -sS -m 60 -w $'\n%{http_code}' -X POST \
    -H "ApiKey:${API_KEY}" -H 'Content-Type: application/json' \
    --data-raw "${payload}" "${REGISTRY_ADMIN_URL}/subscribers/register")"
  http_status="${response##*$'\n'}"
  response="${response%$'\n'*}"

  if [[ "${http_status}" == "200" ]]; then
    ok "${subscriber_id} registered"
  elif grep -q 'Cannot modify key attributes' <<<"${response}"; then
    # The registry refuses to change a key through /register once a record
    # exists. That is the exact wall the README warns about after a rerun of
    # prepare-runtime.sh. Rotate the stored key instead of failing.
    announce "${subscriber_id} already registered; rotating its stored key"
    rotate_participant_key "${unique_key}" "${public_key}"
  else
    die "registering ${subscriber_id} failed with HTTP ${http_status}: ${response}"
  fi

  subscribe_network_role "${subscriber_id}"
}

rotate_participant_key() {
  local unique_key="$1" public_key="$2" key_row_id
  key_row_id="$(registry_get participant_keys | python3 -c '
import json, sys
want = sys.argv[1]
for row in json.load(sys.stdin):
    if row.get("key_id") == want:
        print(row["id"]); break
else:
    sys.exit(1)' "${unique_key}")" \
    || die "the registry has no participant key '${unique_key}' to rotate."

  registry_save participant_keys/save \
    "$(python3 -c '
import json, sys
print(json.dumps({"id": sys.argv[1], "signing_public_key": sys.argv[2], "encr_public_key": sys.argv[2]}))' \
      "${key_row_id}" "${public_key}")" >/dev/null \
    || die "could not rotate participant key '${unique_key}'."
  ok "participant key ${unique_key} rotated to the generated runtime key"
}

# Every record the registry creates starts INITIATED, including the one the
# gateway writes for itself at boot. The gateway's own lookup only returns
# SUBSCRIBED records, so without this step a search finds nobody.
subscribe_network_role() {
  local subscriber_id="$1" row
  row="$(registry_get network_roles | python3 -c '
import json, sys
want = sys.argv[1]
for r in json.load(sys.stdin):
    if r.get("subscriber_id") == want:
        print(r["id"], r.get("status", "")); break
else:
    sys.exit(1)' "${subscriber_id}")" \
    || die "the registry has no network role for ${subscriber_id}."

  local row_id="${row%% *}" status="${row##* }"
  if [[ "${status}" == "SUBSCRIBED" ]]; then
    ok "${subscriber_id} already SUBSCRIBED"
    return 0
  fi

  registry_save network_roles/save \
    "$(python3 -c 'import json,sys; print(json.dumps({"id": sys.argv[1], "status": "SUBSCRIBED"}))' "${row_id}")" >/dev/null \
    || die "could not move ${subscriber_id} from ${status} to SUBSCRIBED."
  ok "${subscriber_id} moved ${status} -> SUBSCRIBED"
}

# The gateway registers itself in the registry when it first boots, with
# whatever signing key it generated into its own database. We never supply that
# key; we only have to subscribe the record it wrote.
seed_gateway() {
  local gateway_subscriber_id
  gateway_subscriber_id="$(registry_get network_roles | python3 -c '
import json, sys
for r in json.load(sys.stdin):
    if r.get("type") == "BG":
        print(r["subscriber_id"]); break
else:
    sys.exit(1)')" \
    || die "the gateway has not registered itself in the registry yet. Try: docker logs gateway"

  if [[ "${gateway_subscriber_id}" == "SUBSCRIBER_ID" ]]; then
    die "the gateway registered itself as the literal placeholder 'SUBSCRIBER_ID'. Its swf.properties was rendered without substituting SUBSCRIBER_ID. Run deploy/teardown.sh and then deploy/bring-up.sh again."
  fi

  announce "BG ${gateway_subscriber_id} (self-registered)"
  subscribe_network_role "${gateway_subscriber_id}"
}

# The proof. This is the same POST the gateway itself makes during search, so a
# pass here means the gateway will find these subscribers.
verify_lookup() {
  local expected_bap expected_bmtc expected_bmrcl
  expected_bap="$(public_key_for bap)"
  expected_bmtc="$(public_key_for bmtc)"
  expected_bmrcl="$(public_key_for bmrcl)"

  local bap_id bmtc_id bmrcl_id
  bap_id="$(onix_config_value "${RUNTIME_CONFIG_DIR}/bap-network.yml" subscriberId)"
  bmtc_id="$(onix_config_value "${RUNTIME_CONFIG_DIR}/bmtc-bpp-network.yml" subscriberId)"
  bmrcl_id="$(onix_config_value "${RUNTIME_CONFIG_DIR}/bmrcl-bpp-network.yml" subscriberId)"

  local reserved_args=()
  if reserved_enabled; then
    reserved_args=(
      "$(onix_config_value "${RUNTIME_CONFIG_DIR}/ksrtc-bpp-network.yml" subscriberId)"
      "$(public_key_for ksrtc)"
    )
  fi

  mkdir -p "${RUNTIME_DIR}"
  local lookup_raw="${RUNTIME_DIR}/registry-lookup.raw.json"
  curl -fsS -m 30 -H 'Content-Type: application/json' -d '{}' \
    "${REGISTRY_ADMIN_URL}/subscribers/lookup" -o "${lookup_raw}" \
    || die "POST /subscribers/lookup failed."

  if ! python3 - "${lookup_raw}" \
    "${bap_id}" "${expected_bap}" \
    "${bmtc_id}" "${expected_bmtc}" \
    "${bmrcl_id}" "${expected_bmrcl}" \
    ${reserved_args[@]+"${reserved_args[@]}"} <<'PY'
import json, sys

path = sys.argv[1]
pairs = list(zip(sys.argv[2::2], sys.argv[3::2]))
records = {r.get("subscriber_id"): r for r in json.load(open(path))}

problems = []
for subscriber_id, expected_key in pairs:
    record = records.get(subscriber_id)
    if record is None:
        problems.append(f"{subscriber_id}: not in the registry lookup at all")
        continue
    if record.get("status") != "SUBSCRIBED":
        problems.append(f"{subscriber_id}: status is {record.get('status')}, not SUBSCRIBED")
    if record.get("signing_public_key") != expected_key:
        problems.append(
            f"{subscriber_id}: registry signing_public_key does not match the generated "
            f"runtime key. Registry has {record.get('signing_public_key')!r}, "
            f"prepare-runtime.sh generated {expected_key!r}. Every signed request "
            f"from this subscriber would be rejected."
        )

gateways = [r for r in records.values() if r.get("type") == "BG"]
if not gateways:
    problems.append("no BG (gateway) record in the registry")
elif not any(g.get("status") == "SUBSCRIBED" for g in gateways):
    problems.append("the gateway record is not SUBSCRIBED")

if problems:
    print("\n".join("  - " + p for p in problems), file=sys.stderr)
    sys.exit(1)

print(f"  {len(pairs) + 1} subscribers SUBSCRIBED with matching signing keys "
      "(BAP, 2x BPP, gateway)")
PY
  then
    die "registry seeding did not produce a usable network. See the list above. Raw lookup: ${lookup_raw}"
  fi
  ok "registry lookup verified; raw response saved to ${lookup_raw}"

  # The unfiltered lookup above proves the records exist. This one is the
  # narrower query the gateway actually issues when it fans a search out, and
  # it is the one that decides whether the search reaches two BPPs or none.
  local country city bpp_lookup_raw
  country="$(onix_config_value "${RUNTIME_CONFIG_DIR}/bmtc-bpp-network.yml" country)"
  city="$(onix_config_value "${RUNTIME_CONFIG_DIR}/bmtc-bpp-network.yml" city)"
  bpp_lookup_raw="${RUNTIME_DIR}/registry-bpp-lookup.raw.json"
  curl -fsS -m 30 -H 'Content-Type: application/json' \
    -d "{\"type\":\"BPP\",\"domain\":\"${ONDC_DOMAIN}\",\"country\":\"${country}\",\"city\":\"${city}\"}" \
    "${REGISTRY_ADMIN_URL}/subscribers/lookup" -o "${bpp_lookup_raw}" \
    || die "the gateway's own BPP lookup failed."

  python3 -c '
import json, sys
records = json.load(open(sys.argv[1]))
ids = sorted({r.get("subscriber_id") for r in records if r.get("status") == "SUBSCRIBED"})
if len(ids) != 2:
    sys.exit(
        "the gateway BPP lookup returned "
        f"{len(ids)} subscribed BPP(s) ({ids}), not 2. A search would fan out to "
        f"{len(ids)} seller(s)."
    )
print("  gateway BPP lookup returns 2 subscribed sellers: " + ", ".join(ids))
' "${bpp_lookup_raw}" \
    || die "registry seeding left the gateway unable to find two sellers. Raw lookup: ${bpp_lookup_raw}"
  ok "gateway BPP lookup verified; raw response saved to ${bpp_lookup_raw}"

  # The two domains have to stay apart, and this is where that is provable
  # rather than asserted. A search on one domain must reach the sellers on
  # that domain and nobody else: a reserved item appearing in an unreserved
  # search, or the reverse, is the failure the whole domain split exists to
  # prevent.
  if ! reserved_enabled; then
    return 0
  fi
  local reserved_lookup_raw="${RUNTIME_DIR}/registry-reserved-lookup.raw.json"
  curl -fsS -m 30 -H 'Content-Type: application/json' \
    -d "{\"type\":\"BPP\",\"domain\":\"${RESERVED_DOMAIN}\",\"country\":\"${country}\",\"city\":\"${city}\"}" \
    "${REGISTRY_ADMIN_URL}/subscribers/lookup" -o "${reserved_lookup_raw}" \
    || die "the gateway's own BPP lookup for ${RESERVED_DOMAIN} failed."

  python3 -c '
import json, sys
records = json.load(open(sys.argv[1]))
ids = sorted({r.get("subscriber_id") for r in records if r.get("status") == "SUBSCRIBED"})
if ids != [sys.argv[2]]:
    sys.exit(
        "the reserved domain lookup returned "
        f"{ids}, not exactly [{sys.argv[2]!r}]. A search on the reserved domain "
        "would reach the wrong set of sellers."
    )
print("  reserved domain lookup returns exactly its own seller: " + ids[0])
' "${reserved_lookup_raw}" "${reserved_args[0]}" \
    || die "the two domains are not separated in the registry. Raw lookup: ${reserved_lookup_raw}"
  ok "domain separation verified; raw response saved to ${reserved_lookup_raw}"
}

main() {
  require_cmd curl
  require_cmd python3 "On Ubuntu: sudo apt-get install -y python3"

  step "Seeding the registry at ${REGISTRY_ADMIN_URL}"
  log "  This will create or update 3 subscriber records and subscribe 4."

  registry_login
  ensure_domain "${ONDC_DOMAIN}" "ONDC unreserved transit ticketing, local test network"
  seed_subscriber bap   BAP "${RUNTIME_CONFIG_DIR}/bap-network.yml"
  seed_subscriber bmtc  BPP "${RUNTIME_CONFIG_DIR}/bmtc-bpp-network.yml"
  seed_subscriber bmrcl BPP "${RUNTIME_CONFIG_DIR}/bmrcl-bpp-network.yml"
  if reserved_enabled; then
    ensure_domain "${RESERVED_DOMAIN}" \
      "Reserved intercity coach seats, local specimen domain. Not administered by any network."
    seed_subscriber ksrtc BPP "${RUNTIME_CONFIG_DIR}/ksrtc-bpp-network.yml" "${RESERVED_DOMAIN}"
  else
    log "  (RESERVED_ENABLED is not true) skipping the reserved intercity domain and seller"
  fi
  seed_gateway

  step "Verifying the registry the way the gateway reads it"
  verify_lookup
}

main "$@"
