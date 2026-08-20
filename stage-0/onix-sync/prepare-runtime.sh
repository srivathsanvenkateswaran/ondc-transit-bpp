#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly IMAGE="fidedocker/protocol-server@sha256:4f15b3a82c32a0a9b7aac79cc692a029b85d8b845f2b0b6c10fbefd0327b8e23"

if [[ -f "${ROOT_DIR}/../../.env" ]]; then
  set -a
  source "${ROOT_DIR}/../../.env"
  set +a
fi

readonly BAP_ID_VALUE="${BAP_ID:-bap.transit.localhost}"
readonly BAP_NETWORK_PORT_VALUE="${BAP_NETWORK_PORT:-5002}"
readonly BAP_URI_VALUE="${BAP_URI:-http://bap-network:${BAP_NETWORK_PORT_VALUE}}"
readonly BMTC_BPP_ID_VALUE="${BMTC_BPP_ID:-bmtc.bpp.transit.localhost}"
readonly BMTC_BPP_NETWORK_PORT_VALUE="${BMTC_BPP_NETWORK_PORT:-6002}"
readonly BMTC_BPP_URI_VALUE="${BMTC_BPP_URI:-http://bmtc-bpp-network:${BMTC_BPP_NETWORK_PORT_VALUE}}"
readonly BMRCL_BPP_ID_VALUE="${BMRCL_BPP_ID:-bmrcl.bpp.transit.localhost}"
readonly BMRCL_BPP_NETWORK_PORT_VALUE="${BMRCL_BPP_NETWORK_PORT:-6102}"
readonly BMRCL_BPP_URI_VALUE="${BMRCL_BPP_URI:-http://bmrcl-bpp-network:${BMRCL_BPP_NETWORK_PORT_VALUE}}"
readonly PROVIDER_PORT_VALUE="${PROVIDER_PORT:-7001}"
readonly BMTC_WEBHOOK_URL_VALUE="${BMTC_WEBHOOK_URL:-http://transit-bpp:${PROVIDER_PORT_VALUE}/bmtc/search}"
readonly BMRCL_WEBHOOK_URL_VALUE="${BMRCL_WEBHOOK_URL:-http://transit-bpp:${PROVIDER_PORT_VALUE}/bmrcl/search}"
readonly SEARCH_TTL_VALUE="${SEARCH_TTL:-PT4S}"

mkdir -p "${ROOT_DIR}/runtime/config"

generate_pair() {
  local output public_key private_key
  output="$(docker run --rm --platform linux/amd64 --entrypoint node "${IMAGE}" scripts/generate-keys.js)"
  public_key="$(awk '/Your Public Key/{getline; gsub(/^ +| +$/, ""); print}' <<<"${output}")"
  private_key="$(awk '/Your Private Key/{getline; gsub(/^ +| +$/, ""); print}' <<<"${output}")"
  printf '%s\t%s\n' "${public_key}" "${private_key}"
}

render_pair() {
  local prefix public_key private_key source destination
  prefix="$1"
  public_key="$2"
  private_key="$3"
  shift 3

  for source in "$@"; do
    destination="${ROOT_DIR}/runtime/config/$(basename "${source}")"
    cp "${ROOT_DIR}/config/${source}" "${destination}"
    yq -yi --arg public_key "${public_key}" --arg private_key "${private_key}" \
      '.app.publicKey = $public_key | .app.privateKey = $private_key' "${destination}"

    case "${prefix}" in
      bap)
        yq -yi --arg subscriber_id "${BAP_ID_VALUE}" --arg subscriber_uri "${BAP_URI_VALUE}" \
          --arg ttl "${SEARCH_TTL_VALUE}" \
          '.app.subscriberId = $subscriber_id | .app.subscriberUri = $subscriber_uri | .app.actions.requests.search.ttl = $ttl | .app.actions.responses.on_search.ttl = $ttl' "${destination}"
        ;;
      bmtc)
        yq -yi --arg subscriber_id "${BMTC_BPP_ID_VALUE}" --arg subscriber_uri "${BMTC_BPP_URI_VALUE}" \
          --arg ttl "${SEARCH_TTL_VALUE}" \
          '.app.subscriberId = $subscriber_id | .app.subscriberUri = $subscriber_uri | .app.actions.requests.search.ttl = $ttl | .app.actions.responses.on_search.ttl = $ttl' "${destination}"
        ;;
      bmrcl)
        yq -yi --arg subscriber_id "${BMRCL_BPP_ID_VALUE}" --arg subscriber_uri "${BMRCL_BPP_URI_VALUE}" \
          --arg ttl "${SEARCH_TTL_VALUE}" \
          '.app.subscriberId = $subscriber_id | .app.subscriberUri = $subscriber_uri | .app.actions.requests.search.ttl = $ttl | .app.actions.responses.on_search.ttl = $ttl' "${destination}"
        ;;
    esac
  done

  printf '%s\t%s\n' "${prefix}" "${public_key}" >>"${ROOT_DIR}/runtime/public-keys.tsv"
}

: >"${ROOT_DIR}/runtime/public-keys.tsv"

IFS=$'\t' read -r bap_public bap_private < <(generate_pair)
render_pair bap "${bap_public}" "${bap_private}" bap-client.yml bap-network.yml

IFS=$'\t' read -r bmtc_public bmtc_private < <(generate_pair)
render_pair bmtc "${bmtc_public}" "${bmtc_private}" bmtc-bpp-client.yml bmtc-bpp-network.yml

IFS=$'\t' read -r bmrcl_public bmrcl_private < <(generate_pair)
render_pair bmrcl "${bmrcl_public}" "${bmrcl_private}" bmrcl-bpp-client.yml bmrcl-bpp-network.yml

yq -yi --arg port "${BAP_CLIENT_PORT:-5001}" '.server.port = ($port | tonumber)' "${ROOT_DIR}/runtime/config/bap-client.yml"
yq -yi --arg port "${BAP_NETWORK_PORT_VALUE}" '.server.port = ($port | tonumber)' "${ROOT_DIR}/runtime/config/bap-network.yml"
yq -yi --arg port "${BMTC_BPP_CLIENT_PORT:-6001}" --arg webhook "${BMTC_WEBHOOK_URL_VALUE}" '.server.port = ($port | tonumber) | .client.webhook.url = $webhook' "${ROOT_DIR}/runtime/config/bmtc-bpp-client.yml"
yq -yi --arg port "${BMTC_BPP_NETWORK_PORT_VALUE}" '.server.port = ($port | tonumber)' "${ROOT_DIR}/runtime/config/bmtc-bpp-network.yml"
yq -yi --arg port "${BMRCL_BPP_CLIENT_PORT:-6101}" --arg webhook "${BMRCL_WEBHOOK_URL_VALUE}" '.server.port = ($port | tonumber) | .client.webhook.url = $webhook' "${ROOT_DIR}/runtime/config/bmrcl-bpp-client.yml"
yq -yi --arg port "${BMRCL_BPP_NETWORK_PORT_VALUE}" '.server.port = ($port | tonumber)' "${ROOT_DIR}/runtime/config/bmrcl-bpp-network.yml"

echo "Rendered runtime configs; private keys remain under ignored runtime/."
