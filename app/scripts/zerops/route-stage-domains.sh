#!/usr/bin/env bash
# Routes the stage hostnames to Zerops: a Zerops public HTTP routing per service (Let's Encrypt certificate) and a
# proxied AAAA record to the project IPv6 in the Cloudflare zone, which keeps Cloudflare's WAF and Access in front.
# A hostname still attached to a Worker custom domain is detached first (the Worker itself stays). Idempotent.
#
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ZONE_ID=… ZEROPS_TOKEN=… ZEROPS_PROJECT_ID=… CLOUDFLARE_ACCOUNT_ID=… \
#     route-stage-domains.sh <hostname> <zerops-service-id> <port> [<hostname> <service-id> <port> ...]
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ZONE_ID:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${ZEROPS_TOKEN:?}" "${ZEROPS_PROJECT_ID:?}"
cf='https://api.cloudflare.com/client/v4'
zerops='https://api.app-prg1.zerops.io/api/rest/public'
cf_auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json')
z_auth=(-H "Authorization: Bearer $ZEROPS_TOKEN" -H 'content-type: application/json')

# Zerops terminates TLS itself, so Cloudflare must reach it over HTTPS ("full"); the zone default is "flexible".
# One page rule covers every ontos-stage* hostname.
ssl_target='ontos-stage*.web-revolution.cz/*'
if ! curl -fsS "${cf_auth[@]}" "$cf/zones/$CLOUDFLARE_ZONE_ID/pagerules" |
  jq -e --arg target "$ssl_target" '.result[] | select(.targets[0].constraint.value == $target)' >/dev/null; then
  jq -n --arg target "$ssl_target" \
    '{targets: [{target: "url", constraint: {operator: "matches", value: $target}}], actions: [{id: "ssl", value: "full"}], status: "active"}' |
    curl -fsS -X POST "${cf_auth[@]}" "$cf/zones/$CLOUDFLARE_ZONE_ID/pagerules" -d @- >/dev/null
  echo "Cloudflare reaches $ssl_target over HTTPS (SSL full)"
fi

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
  # Cloudflare: detach a Worker custom domain, then one proxied AAAA to the project IPv6.
  for domain in $(curl -fsS "${cf_auth[@]}" "$cf/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains?hostname=$host" |
    jq -r --arg host "$host" '.result[] | select(.hostname == $host) | .id'); do
    curl -fsS -X DELETE "${cf_auth[@]}" "$cf/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains/$domain" >/dev/null
    echo "$host detached from its Worker custom domain"
  done
  records="$(curl -fsS "${cf_auth[@]}" "$cf/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=$host")"
  for record in $(jq -r --arg ip "$ipv6" '.result[] | select((.type == "A" or .type == "AAAA" or .type == "CNAME") and .content != $ip) | .id' <<<"$records"); do
    curl -fsS -X DELETE "${cf_auth[@]}" "$cf/zones/$CLOUDFLARE_ZONE_ID/dns_records/$record" >/dev/null
  done
  if ! jq -e --arg ip "$ipv6" '.result[] | select(.type == "AAAA" and .content == $ip)' <<<"$records" >/dev/null; then
    jq -n --arg host "$host" --arg ip "$ipv6" '{type: "AAAA", name: $host, content: $ip, proxied: true, ttl: 1}' |
      curl -fsS -X POST "${cf_auth[@]}" "$cf/zones/$CLOUDFLARE_ZONE_ID/dns_records" -d @- >/dev/null
  fi
  echo "$host → AAAA $ipv6 (proxied)"
done

curl -fsS -X PUT "${z_auth[@]}" "$zerops/project/$ZEROPS_PROJECT_ID/sync-public-http-routing" -d '{}' >/dev/null
echo 'Zerops public HTTP routing synchronized'
