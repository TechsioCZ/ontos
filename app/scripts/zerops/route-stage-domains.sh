#!/usr/bin/env bash
# Routes the stage hostnames to Zerops: a Zerops public HTTP routing per service (Let's Encrypt certificate) and
# DNS-only A and AAAA records in the Cloudflare zone, pointing at the shared Zerops IPv4 and the project IPv6.
# The records are not proxied: the zone's SSL mode is `flexible`, and proxying needs an SSL `full` rule that the
# stage token cannot create. A hostname still attached to a Worker custom domain is detached first (the Worker
# itself stays). Idempotent.
#
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ZONE_ID=… CLOUDFLARE_ACCOUNT_ID=… ZEROPS_TOKEN=… ZEROPS_PROJECT_ID=… \
#   ZEROPS_SHARED_IPV4=… route-stage-domains.sh <hostname> <zerops-service-id> <port> [<hostname> <service-id> <port> ...]
#
# ZEROPS_SHARED_IPV4 is the shared IPv4 address the Zerops dashboard shows for the project (the API does not).
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ZONE_ID:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${ZEROPS_TOKEN:?}" "${ZEROPS_PROJECT_ID:?}"
: "${ZEROPS_SHARED_IPV4:?}"
cf='https://api.cloudflare.com/client/v4'
zerops='https://api.app-prg1.zerops.io/api/rest/public'
cf_auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json')
z_auth=(-H "Authorization: Bearer $ZEROPS_TOKEN" -H 'content-type: application/json')

ipv6="$(curl -fsS "${z_auth[@]}" "$zerops/project/$ZEROPS_PROJECT_ID" | jq -er '.publicIpV6')"
routings="$(curl -fsS "${z_auth[@]}" "$zerops/project/$ZEROPS_PROJECT_ID/public-http-routing?limit=100&offset=0")"

while (($# >= 3)); do
  host="$1" service="$2" port="$3"
  shift 3
  # Zerops: one routing per hostname, path / to the service port.
  if jq -e --arg host "$host" '.list[]? | select(.domains | index($host))' <<<"$routings" >/dev/null; then
    echo "$host already has a Zerops routing"
  else
    jq -n --arg host "$host" --arg service "$service" --argjson port "$port" \
      '{domains: [$host], sslEnabled: true, locations: [{path: "/", port: $port, serviceStackId: $service}]}' |
      curl -fsS -X POST "${z_auth[@]}" "$zerops/project/$ZEROPS_PROJECT_ID/public-http-routing" -d @- >/dev/null
    echo "$host routed to Zerops service $service:$port"
  fi
  # Cloudflare: detach a Worker custom domain, then exactly one DNS-only A and AAAA.
  for domain in $(curl -fsS "${cf_auth[@]}" "$cf/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains?hostname=$host" |
    jq -r --arg host "$host" '.result[] | select(.hostname == $host) | .id'); do
    curl -fsS -X DELETE "${cf_auth[@]}" "$cf/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains/$domain" >/dev/null
    echo "$host detached from its Worker custom domain"
  done
  records="$(curl -fsS "${cf_auth[@]}" "$cf/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=$host")"
  for type_and_ip in "A $ZEROPS_SHARED_IPV4" "AAAA $ipv6"; do
    type="${type_and_ip% *}" ip="${type_and_ip#* }"
    for record in $(jq -r --arg type "$type" --arg ip "$ip" \
      '.result[] | select((.type == $type and (.content != $ip or .proxied)) or ($type == "A" and .type == "CNAME")) | .id' <<<"$records"); do
      curl -fsS -X DELETE "${cf_auth[@]}" "$cf/zones/$CLOUDFLARE_ZONE_ID/dns_records/$record" >/dev/null
    done
    if ! jq -e --arg type "$type" --arg ip "$ip" '.result[] | select(.type == $type and .content == $ip and (.proxied | not))' \
      <<<"$records" >/dev/null; then
      jq -n --arg type "$type" --arg host "$host" --arg ip "$ip" '{type: $type, name: $host, content: $ip, proxied: false, ttl: 60}' |
        curl -fsS -X POST "${cf_auth[@]}" "$cf/zones/$CLOUDFLARE_ZONE_ID/dns_records" -d @- >/dev/null
    fi
  done
  echo "$host → A $ZEROPS_SHARED_IPV4, AAAA $ipv6 (DNS only)"
done

curl -fsS -X PUT "${z_auth[@]}" "$zerops/project/$ZEROPS_PROJECT_ID/sync-public-http-routing" -d '{}' >/dev/null
echo 'Zerops public HTTP routing synchronized'
