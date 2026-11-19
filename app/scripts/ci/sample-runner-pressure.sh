#!/usr/bin/env bash
# Records the runner's CPU, I/O and memory state every few seconds until the job ends, so a slow or failed
# step is read against measured pressure instead of guessed: the CPU counters separate iowait and hypervisor
# steal from idle, procs_blocked counts tasks waiting on I/O, and Dirty/Writeback show write-back that a later
# step inherits. Columns are raw kernel counters; the reader takes deltas between samples and joins them to
# the job's step times.
#
# Usage: bash scripts/ci/sample-runner-pressure.sh <samples file>   (started in the background; the runner
# ends it with the job)
set -euo pipefail

output="${1:?the samples file is required}"
interval="${RUNNER_PRESSURE_INTERVAL:-2}"
sources=(/proc/stat /proc/loadavg /proc/meminfo /proc/diskstats)
for pressure in /proc/pressure/cpu /proc/pressure/io /proc/pressure/memory; do
  if [[ -r "$pressure" ]]; then
    sources+=("$pressure")
  fi
done

echo 'epoch user nice system idle iowait irq softirq steal running blocked load1 cpu_some10 io_some10 io_full10 mem_some10 available_kb dirty_kb writeback_kb read_sectors written_sectors io_ms' >"$output"
while :; do
  awk -v epoch="$(date +%s)" '
    FILENAME == "/proc/stat" && $1 == "cpu" { cpu = $2 " " $3 " " $4 " " $5 " " $6 " " $7 " " $8 " " $9 }
    FILENAME == "/proc/stat" && $1 == "procs_running" { running = $2 }
    FILENAME == "/proc/stat" && $1 == "procs_blocked" { blocked = $2 }
    FILENAME == "/proc/loadavg" { load = $1 }
    FILENAME == "/proc/meminfo" && $1 == "MemAvailable:" { available = $2 }
    FILENAME == "/proc/meminfo" && $1 == "Dirty:" { dirty = $2 }
    FILENAME == "/proc/meminfo" && $1 == "Writeback:" { writeback = $2 }
    FILENAME == "/proc/diskstats" && $3 ~ /^(sd[a-z]+|vd[a-z]+|nvme[0-9]+n[0-9]+)$/ { read += $6; written += $10; busy += $13 }
    FILENAME ~ /^\/proc\/pressure\// { split($2, average, "=") }
    FILENAME == "/proc/pressure/cpu" && $1 == "some" { cpu_some = average[2] }
    FILENAME == "/proc/pressure/io" && $1 == "some" { io_some = average[2] }
    FILENAME == "/proc/pressure/io" && $1 == "full" { io_full = average[2] }
    FILENAME == "/proc/pressure/memory" && $1 == "some" { mem_some = average[2] }
    END {
      print epoch, cpu, running, blocked, load, (cpu_some == "" ? "-" : cpu_some), (io_some == "" ? "-" : io_some),
        (io_full == "" ? "-" : io_full), (mem_some == "" ? "-" : mem_some), available, dirty, writeback,
        read + 0, written + 0, busy + 0
    }' "${sources[@]}" >>"$output"
  sleep "$interval"
done
