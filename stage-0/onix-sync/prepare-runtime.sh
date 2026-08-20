#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly IMAGE="fidedocker/protocol-server@sha256:4f15b3a82c32a0a9b7aac79cc692a029b85d8b845f2b0b6c10fbefd0327b8e23"

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

echo "Rendered runtime configs; private keys remain under ignored runtime/."
