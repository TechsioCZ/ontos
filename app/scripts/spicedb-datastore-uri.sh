#!/bin/sh
# Print SpiceDB's PostgreSQL datastore URI, built from structured parts rather than accepted as an
# external URL string. The `spicedb` login and database are fixed; SPICEDB_DATABASE_HOST,
# SPICEDB_DATABASE_PORT and SPICEDB_DATABASE_PASSWORD come from the deployment. Every password byte
# is percent-encoded and IPv6 hosts are bracketed, so SpiceDB's Go parser and libpq read the URI
# back to exactly these parts by construction.
set -eu

host="${SPICEDB_DATABASE_HOST:?SPICEDB_DATABASE_HOST is required}"
port="${SPICEDB_DATABASE_PORT:?SPICEDB_DATABASE_PORT is required}"
password="${SPICEDB_DATABASE_PASSWORD:?SPICEDB_DATABASE_PASSWORD is required}"

case "$port" in
  '' | *[!0-9]*)
    echo 'SPICEDB_DATABASE_PORT must be a decimal port number' >&2
    exit 1
    ;;
esac
if [ "${#port}" -gt 5 ] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  echo 'SPICEDB_DATABASE_PORT must be between 1 and 65535' >&2
  exit 1
fi

case "$host" in
  *:*)
    # An IPv6 literal: hexadecimal groups, colons and an optional embedded IPv4 tail.
    case "$host" in
      *[!0-9A-Fa-f:.]*)
        echo 'SPICEDB_DATABASE_HOST must be a hostname or an IP address' >&2
        exit 1
        ;;
    esac
    authority_host="[$host]"
    ;;
  *)
    case "$host" in
      # A single trailing dot marks an absolute DNS name and is kept.
      *[!0-9A-Za-z.-]* | -* | *- | *-. | .* | *..*)
        echo 'SPICEDB_DATABASE_HOST must be a hostname or an IP address' >&2
        exit 1
        ;;
    esac
    authority_host="$host"
    ;;
esac

encoded_password="$(printf '%s' "$password" | od -An -v -tx1 | tr -d ' \n' | sed 's/../%&/g')"

printf 'postgresql://spicedb:%s@%s:%s/spicedb\n' "$encoded_password" "$authority_host" "$port"
