/**
 * The phases a module owner reports of its own request in `server-timing` (Core's ReadPhase names and its
 * `owner-…` request phases), reduced to fixed names and numbers for the Shell's log line. The owner's header itself
 * never leaves the Shell: per-request gate, SpiceDB and SQL timings are a side channel no client needs.
 */

const MAX_OWNER_PHASES = 64;
const MAX_OWNER_HEADER_LENGTH = 4096;
// Mirror Core's fixed ReadPhase names and its owner request phases (`owner-…`, `owner-…-count`) without importing
// another deployment's private implementation.
const ownerPhase =
  /^(?<phase>read-authentication|read-admission|read-scope|read-module|read-permission|read-prepare|read-transaction|read-authority|read-rls|read-owner|read-validation|read-audit|read-encode|owner-total|owner-(?:gate|spicedb|evidence|sql|transaction|remote)(?:-count)?)\s*;\s*dur=(?<duration>\d+(?:\.\d+)?)$/u;

// Commas inside quoted descriptions are data, never metric separators (including escaped quotes).
const timingMetrics = (header: string): readonly string[] => {
  const metrics: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      metrics.push(header.slice(start, index));
      if (metrics.length === MAX_OWNER_PHASES) {
        return metrics;
      }
      start = index + 1;
    }
  }
  if (quoted) {
    return [];
  }
  metrics.push(header.slice(start));
  return metrics;
};

/** The owner's fixed-name, finite numeric phases, for the Shell's own log only; never relayed to a client. */
export const ownerServerTimings = (header: string): readonly string[] => {
  if (header.length > MAX_OWNER_HEADER_LENGTH) {
    return [];
  }
  const timings: string[] = [];
  for (const metric of timingMetrics(header)) {
    const groups = ownerPhase.exec(metric.trim())?.groups;
    if (groups !== undefined && Number.isFinite(Number(groups['duration']))) {
      timings.push(`${groups['phase']};dur=${groups['duration']}`);
    }
  }
  return timings;
};
