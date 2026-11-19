#!/usr/bin/env bash
# Keep the existing finite workflow deadline. Separate apt from the browser CDN and retain package provenance.
set -euo pipefail
started=$SECONDS
phase=seed-cache
phase_started=$SECONDS
log="${RUNNER_TEMP:?}/chromium-install"
mkdir -p "$log"
dpkg-query -W -f='${Package}:${Architecture}\t${Version}\n' | sort > "$log/before.tsv"
: > "$log/cache.tsv"
: > "$log/apt.log"
phase_event() { printf '%s\n' "$*" | tee -a "$log/phases.log"; }
finish() {
  status=$?
  phase_event "Chromium phase end: $phase elapsed=$((SECONDS - phase_started))s total=$((SECONDS - started))s status=$status"
  # apt prints Get: only for network transfers (including indexes); the complete output remains in the step log.
  if [[ -f "$log/apt.log" ]]; then
    awk '/^Get:[0-9]+ / {print "apt network: " $0}' "$log/apt.log"
  fi
  dpkg-query -W -f='${Package}:${Architecture}\t${Version}\n' | sort > "$log/after.tsv"
  : >> "$log/apt.log"
  awk '
    /^Get:[0-9]+ https?:/ && $6 ~ /^(all|amd64|arm64|i386)$/ {print $5 ":" $6 "\t" $7}
  ' "$log/apt.log" > "$log/network.tsv"
  awk -F '\t' '
    FILENAME == ARGV[1] {before[$1]=$2; next}
    FILENAME == ARGV[2] {cached[$1]=$2; next}
    FILENAME == ARGV[3] {network[$1]=$2; next}
    before[$1] != $2 {printf "apt installed: %s version=%s source=%s\n", $1, $2,
      (network[$1] == $2 ? "network" : cached[$1] == $2 ? "cache" : "unresolved (see apt log)" )}
  ' "$log/before.tsv" "$log/cache.tsv" "$log/network.tsv" "$log/after.tsv"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
phase_event "Chromium phase start: $phase"
if [[ -d ~/.cache/playwright-apt-debs ]]; then
  while IFS= read -r -d '' archive; do
    dpkg-deb -W --showformat='${Package}:${Architecture}\t${Version}\n' "$archive" >> "$log/cache.tsv"
    sudo cp "$archive" /var/cache/apt/archives/
  done < <(find ~/.cache/playwright-apt-debs -maxdepth 1 -name '*.deb' -print0)
fi
printf 'apt cache-seeded packages:\n'
cat "$log/cache.tsv"
phase_event "Chromium phase end: $phase elapsed=$((SECONDS - phase_started))s"
phase=apt-runtime-dependencies
phase_started=$SECONDS
phase_event "Chromium phase start: $phase"
mise exec -- pnpm --filter @app/shell-super-app exec playwright install-deps chromium 2>&1 | tee "$log/apt.log"
phase_event "Chromium phase end: $phase elapsed=$((SECONDS - phase_started))s"
# Gates previously only restored the broad prefix; persist downloads under this exact OS/version key.
mkdir -p ~/.cache/playwright-apt-debs
find /var/cache/apt/archives -maxdepth 1 -name '*.deb' -exec cp {} ~/.cache/playwright-apt-debs/ \;
phase=chromium-browser
phase_started=$SECONDS
phase_event "Chromium phase start: $phase cache-hit=${CHROMIUM_CACHED:-false}"
if [[ "${CHROMIUM_CACHED:-}" != true ]]; then
  mise exec -- pnpm --filter @app/shell-super-app exec playwright install chromium
fi
