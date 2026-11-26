// The stable maintenance ingress gate at the Cloudflare edge: one WAF custom rule that blocks every request to the four
// stable origin hostnames except from the listed verifier IPs. The Zerops public routings and their certificates stay
// as they are; the app keeps all its features. The rule is the project's own (`ref` ontos-stable-maintenance-<projectId>)
// in the zone's http_request_firewall_custom entry point ruleset, created and changed one rule at a time: no other
// rule, ruleset or project is touched. Leaving maintenance disables the rule; entering enables it again.
//
// The gate only holds for traffic Cloudflare proxies, so every A, AAAA and CNAME record of the four hostnames must be
// proxied (orange cloud). Proxied stable hostnames are an operator prerequisite this tool checks, never changes: the
// zone's SSL/TLS mode must be Full (strict) so Cloudflare reaches the Zerops routings over HTTPS (Flexible would speak
// HTTP to them), and the published stage hostnames stay DNS-only. The workloads' native zerops.app subdomains bypass
// Cloudflare, so maintenance.mjs keeps them disabled.
//
// Settings file (STABLE_EDGE_FILE, private): {"schemaVersion":1,"projectId":"…","zoneId":"<32 hex>",
//   "verifierIps":["203.0.113.7","2001:db8::7"]}  (literal addresses of the machines that run verify.mjs, no ranges)
// Token: CLOUDFLARE_API_TOKEN with Zone WAF Write, DNS Read and Zone Read on that zone. It goes only into the
// Authorization header; errors carry the HTTP status and Cloudflare's error codes.
//
// Endpoints (Cloudflare API v4, developers.cloudflare.com ruleset-engine and WAF custom rules docs):
//   GET   /zones/{zone}                                                       zone name
//   GET   /zones/{zone}/dns_records?name={host}                               proxied records
//   GET   /zones/{zone}/rulesets/phases/http_request_firewall_custom/entrypoint   404 when the zone has none yet
//   POST  /zones/{zone}/rulesets                                              create that entry point with the rule
//   POST  /zones/{zone}/rulesets/{ruleset}/rules                              add the rule
//   PATCH /zones/{zone}/rulesets/{ruleset}/rules/{rule}                       redefine it (full definition)
import { lstat, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

export class EdgeError extends Error {
  name = 'EdgeError';
}

/** Reads a private JSON file: a regular file only its owner can read. */
export const readPrivateJson = async (file, label) => {
  const stat = await lstat(file).catch(() => undefined);
  if (stat === undefined || !stat.isFile()) throw new EdgeError(`${label} ${file} is not a regular file`);
  if ((stat.mode & 0o077) !== 0) throw new EdgeError(`${label} ${file} is readable by others; chmod 600 it`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new EdgeError(`${label} ${file} is not JSON`);
  }
};

export const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';
export const FIREWALL_PHASE = 'http_request_firewall_custom';
/** The stable origins the gate covers (config.origins keys). */
export const GATED_ORIGINS = Object.freeze(['shell', 'storefront', 'shop', 'n1']);
const ZONE_ID = /^[\da-f]{32}$/u;
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME']);

/** Validates the edge settings against the stable config. Messages name the field, never a value. */
export const validateEdgeSettings = (value, config) => {
  const keys = ['schemaVersion', 'projectId', 'zoneId', 'verifierIps'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new EdgeError('edge settings must be an object');
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new EdgeError(`edge settings have unknown keys ${unknown.join(', ')}`);
  if (value.schemaVersion !== 1) throw new EdgeError('edge settings schemaVersion must be 1');
  if (value.projectId !== config.projectId) throw new EdgeError('edge settings projectId is not the stable config projectId');
  if (typeof value.zoneId !== 'string' || !ZONE_ID.test(value.zoneId)) throw new EdgeError('edge settings zoneId must be a Cloudflare zone id');
  const ips = value.verifierIps;
  if (!Array.isArray(ips) || ips.length === 0) throw new EdgeError('edge settings verifierIps must list at least one address');
  for (const [index, ip] of ips.entries()) {
    if (typeof ip !== 'string' || isIP(ip) === 0) throw new EdgeError(`edge settings verifierIps[${String(index)}] must be one literal IPv4 or IPv6 address`);
  }
  if (new Set(ips.map((ip) => ip.toLowerCase())).size !== ips.length) throw new EdgeError('edge settings verifierIps must be unique');
  return Object.freeze({ schemaVersion: 1, projectId: value.projectId, zoneId: value.zoneId, verifierIps: Object.freeze([...ips]) });
};

export const loadEdgeSettings = async (file, config) => validateEdgeSettings(await readPrivateJson(file, 'edge settings'), config);

export const edgeSettingsFromEnv = (config, env = process.env) => {
  if (!env.STABLE_EDGE_FILE) throw new EdgeError('STABLE_EDGE_FILE is required');
  return loadEdgeSettings(env.STABLE_EDGE_FILE, config);
};

export const gatedHosts = (config) => GATED_ORIGINS.map((origin) => ({ origin, host: new URL(config.origins[origin]).hostname }));

export const ruleRef = (config) => `ontos-stable-maintenance-${config.projectId}`;

/** The rule's full definition: block the four hosts for every source but the verifiers. */
export const maintenanceRule = (config, settings, enabled) => ({
  ref: ruleRef(config),
  description: `OntOS stable maintenance gate for Zerops project ${config.projectId}`,
  expression: `(http.host in {${gatedHosts(config).map(({ host }) => `"${host}"`).join(' ')}} and not ip.src in {${settings.verifierIps.join(' ')}})`,
  action: 'block',
  enabled,
});

export const createCloudflareClient = ({ token, apiUrl = CLOUDFLARE_API_URL, fetchImpl = fetch }) => {
  if (typeof token !== 'string' || token.length === 0) throw new EdgeError('CLOUDFLARE_API_TOKEN is required');
  const request = async (method, route, label, { body, allowNotFound = false } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${route}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new EdgeError(`Cloudflare ${label} failed: ${error.name}`);
    }
    if (allowNotFound && response.status === 404) return undefined;
    const answer = await response.json().catch(() => undefined);
    if (!response.ok || answer?.success !== true) {
      const codes = Array.isArray(answer?.errors) ? answer.errors.map(({ code }) => code).filter((code) => code !== undefined) : [];
      throw new EdgeError(`Cloudflare ${label} failed: HTTP ${String(response.status)}${codes.length > 0 ? ` codes ${codes.join(',')}` : ''}`);
    }
    return answer.result;
  };
  const zone = (zoneId) => `/zones/${encodeURIComponent(zoneId)}`;
  return {
    zone: (zoneId) => request('GET', zone(zoneId), 'zone read'),
    dnsRecords: (zoneId, host) => request('GET', `${zone(zoneId)}/dns_records?name=${encodeURIComponent(host)}`, 'DNS record list'),
    entrypoint: (zoneId) => request('GET', `${zone(zoneId)}/rulesets/phases/${FIREWALL_PHASE}/entrypoint`, 'firewall entry point read', { allowNotFound: true }),
    createEntrypoint: (zoneId, rule) =>
      request('POST', `${zone(zoneId)}/rulesets`, 'firewall entry point create', {
        body: { name: 'default', kind: 'zone', phase: FIREWALL_PHASE, rules: [rule] },
      }),
    createRule: (zoneId, rulesetId, rule) =>
      request('POST', `${zone(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}/rules`, 'firewall rule create', { body: rule }),
    updateRule: (zoneId, rulesetId, ruleId, rule) =>
      request('PATCH', `${zone(zoneId)}/rulesets/${encodeURIComponent(rulesetId)}/rules/${encodeURIComponent(ruleId)}`, 'firewall rule update', { body: rule }),
  };
};

export const cloudflareClientFromEnv = (env = process.env) => createCloudflareClient({ token: env.CLOUDFLARE_API_TOKEN });

const sameRule = (actual, wanted) =>
  ['ref', 'description', 'expression', 'action', 'enabled'].every((key) => actual?.[key] === wanted[key]);

/**
 * edgeStatus(config, settings, { cloudflare }) → { zone, hosts: [{ origin, host, proxied }], rule: { state, rulesetId,
 * ruleId } , closed }. `rule.state` is `missing`, `enabled` (current definition, blocking), `disabled` (current
 * definition, off) or `drifted` (a rule with our ref and another definition). `closed` means every host proxied and our
 * rule enabled.
 */
export const edgeStatus = async (config, settings, { cloudflare }) => {
  const zone = await cloudflare.zone(settings.zoneId);
  if (zone?.id !== settings.zoneId || typeof zone.name !== 'string') throw new EdgeError('Cloudflare returned another zone');
  const hosts = [];
  for (const { origin, host } of gatedHosts(config)) {
    if (host !== zone.name && !host.endsWith(`.${zone.name}`)) throw new EdgeError(`origins.${origin} is not in the configured Cloudflare zone`);
    const records = (await cloudflare.dnsRecords(settings.zoneId, host)).filter((record) => record?.name === host && PROXIABLE.has(record.type));
    hosts.push({ origin, host, records: records.length, proxied: records.length > 0 && records.every((record) => record.proxied === true) });
  }
  const ruleset = await cloudflare.entrypoint(settings.zoneId);
  const ours = (ruleset?.rules ?? []).filter((rule) => rule?.ref === ruleRef(config));
  if (ours.length > 1) throw new EdgeError('the firewall entry point holds the maintenance rule twice');
  const [rule] = ours;
  let state = 'missing';
  if (rule !== undefined) {
    if (sameRule(rule, maintenanceRule(config, settings, true))) state = 'enabled';
    else if (sameRule(rule, maintenanceRule(config, settings, false))) state = 'disabled';
    else state = 'drifted';
  }
  return {
    zone: zone.name,
    hosts,
    rule: { state, rulesetId: ruleset?.id, ruleId: rule?.id },
    closed: hosts.every(({ proxied }) => proxied) && state === 'enabled',
  };
};

/** Writes the rule with `enabled`, adding it (and the entry point) only when missing, and reads the edge back. */
const setRule = async (config, settings, cloudflare, enabled, log) => {
  const before = await edgeStatus(config, settings, { cloudflare });
  const wanted = maintenanceRule(config, settings, enabled);
  const target = enabled ? 'enabled' : 'disabled';
  if (before.rule.state === target) return before;
  if (before.rule.state === 'missing' && !enabled) return before;
  if (before.rule.state === 'missing') {
    log('adding the maintenance rule to the Cloudflare firewall');
    if (before.rule.rulesetId === undefined) await cloudflare.createEntrypoint(settings.zoneId, wanted);
    else await cloudflare.createRule(settings.zoneId, before.rule.rulesetId, wanted);
  } else {
    log(`${enabled ? 'enabling' : 'disabling'} the maintenance rule in the Cloudflare firewall`);
    await cloudflare.updateRule(settings.zoneId, before.rule.rulesetId, before.rule.ruleId, wanted);
  }
  const after = await edgeStatus(config, settings, { cloudflare });
  if (after.rule.state !== target) throw new EdgeError(`the maintenance rule reads back ${after.rule.state}, not ${target}`);
  return after;
};

/**
 * closeEdge(config, settings, { cloudflare, log? }) → edge status. Refuses unless every gated host is proxied by the
 * configured zone, then enables the project's maintenance rule (adding it when missing) and reads the edge back closed.
 */
export const closeEdge = async (config, settings, { cloudflare, log = () => {} }) => {
  const before = await edgeStatus(config, settings, { cloudflare });
  const unproxied = before.hosts.filter(({ proxied }) => !proxied).map(({ host }) => host);
  if (unproxied.length > 0) throw new EdgeError(`not proxied by Cloudflare, so the gate cannot hold: ${unproxied.join(', ')}`);
  const after = await setRule(config, settings, cloudflare, true, log);
  if (!after.closed) throw new EdgeError('the edge does not read back closed');
  return after;
};

/** openEdge(config, settings, { cloudflare, log? }) → edge status. Disables only the project's maintenance rule. */
export const openEdge = async (config, settings, { cloudflare, log = () => {} }) => setRule(config, settings, cloudflare, false, log);
