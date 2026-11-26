// Test fixture: a stable config, edge settings, and in-memory Zerops and Cloudflare APIs behind fetch functions, with
// the request shapes maintenance.mjs and edge.mjs send.
import { createCloudflareClient } from './edge.mjs';
import { createZeropsClient } from './maintenance.mjs';

export const ZONE_ID = 'a'.repeat(32);

export const fixtureConfig = () => ({
  schemaVersion: 1,
  projectId: 'STABLEproject000000000',
  demoProjectId: 'DEMOproject00000000000',
  services: {
    app: 'STABLEapp0000000000000',
    storefront: 'STABLEstorefront000000',
    shop: 'STABLEshop000000000000',
    n1: 'STABLEn10000000000000',
    spicedb: 'STABLEspicedb000000000',
    db18: 'STABLEdb18000000000000',
  },
  origins: {
    shell: 'https://ontos.example.com',
    storefront: 'https://akros.example.com',
    shop: 'https://shop.example.com',
    n1: 'https://n1.example.com',
  },
  variables: {},
});

export const fixtureEdge = (config = fixtureConfig()) => ({
  schemaVersion: 1,
  projectId: config.projectId,
  zoneId: ZONE_ID,
  verifierIps: ['203.0.113.7', '2001:db8::7'],
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An open stable project: every service ACTIVE, subdomains on for the workloads as zerops-import.yaml creates them. */
export const createFakeZerops = (config = fixtureConfig()) => {
  const workloads = new Set(['app', 'storefront', 'shop', 'n1']);
  const services = new Map(
    Object.entries(config.services).map(([name, id]) => [id, { id, projectId: config.projectId, name, status: 'ACTIVE', subdomainAccess: workloads.has(name) }]),
  );
  const state = {
    calls: [],
    failProcess: new Set(),
    envFile: 'db18_hostname="db18"\ndb18_port="5432"\ndb18_dbName="db18"\ndb18_superUserPassword="REDACTED"\n',
  };
  const processes = new Map();
  let counter = 0;
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname.replace(/^\/api/u, '');
    state.calls.push(`${init.method} ${route}`);
    if (init.headers.authorization !== 'Bearer zerops-token') return json(401, { error: { code: 'unauthorized' } });
    let match;
    if (init.method === 'GET' && (match = /^\/project\/([^/]+)$/u.exec(route))) {
      return match[1] === config.projectId ? json(200, { id: match[1] }) : json(400, { error: { code: 'projectNotFound' } });
    }
    if (init.method === 'GET' && (match = /^\/service-stack\/([^/]+)$/u.exec(route))) {
      const service = services.get(match[1]);
      return service ? json(200, { ...service }) : json(400, { error: { code: 'serviceStackNotFound' } });
    }
    if (init.method === 'PUT' && (match = /^\/service-stack\/([^/]+)\/(stop|start|disable-subdomain-access)$/u.exec(route))) {
      const service = services.get(match[1]);
      const id = `process-${String((counter += 1))}`;
      const failed = state.failProcess.has(`${match[2]}:${service.name}`);
      if (!failed) {
        if (match[2] === 'stop') service.status = 'STOPPED';
        else if (match[2] === 'start') service.status = 'ACTIVE';
        else service.subdomainAccess = false;
      }
      processes.set(id, failed ? 'FAILED' : 'FINISHED');
      return json(200, { id, status: 'PENDING' });
    }
    if (init.method === 'GET' && (match = /^\/process\/([^/]+)$/u.exec(route))) return json(200, { id: match[1], status: processes.get(match[1]) });
    if (init.method === 'GET' && /^\/project\/[^/]+\/env-file$/u.test(route)) return json(200, { envFile: state.envFile });
    return json(404, { error: { code: 'notFound' } });
  };
  const client = createZeropsClient({ token: 'zerops-token', apiUrl: 'https://zerops.test/api', fetchImpl, pollMs: 1, settleTimeoutMs: 50 });
  return { state, client, byName: (name) => services.get(config.services[name]), config };
};

/**
 * A Cloudflare zone `example.com` with proxied records for the four stable hosts, a DNS-only record for another host,
 * and an http_request_firewall_custom entry point that already holds another project's rule.
 */
export const createFakeCloudflare = ({ hosts = ['ontos.example.com', 'akros.example.com', 'shop.example.com', 'n1.example.com'], entrypoint = true } = {}) => {
  const state = {
    calls: [],
    records: new Map([
      ...hosts.map((host) => [host, [{ name: host, type: 'A', content: '192.0.2.1', proxied: true }, { name: host, type: 'AAAA', content: '2001:db8::1', proxied: true }]]),
      ['ontos-stage.example.com', [{ name: 'ontos-stage.example.com', type: 'A', content: '192.0.2.2', proxied: false }]],
    ]),
    ruleset: entrypoint
      ? { id: 'ruleset-1', phase: 'http_request_firewall_custom', rules: [{ id: 'other-rule', ref: 'someone-else', description: 'other', expression: 'ip.src eq 198.51.100.1', action: 'block', enabled: true }] }
      : undefined,
  };
  let counter = 0;
  const ok = (result) => json(200, { success: true, errors: [], messages: [], result });
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const route = parsed.pathname.replace(/^\/client\/v4/u, '');
    state.calls.push(`${init.method} ${route}${parsed.search}`);
    if (init.headers.authorization !== 'Bearer cloudflare-token') return json(403, { success: false, errors: [{ code: 10000 }] });
    const zone = `/zones/${ZONE_ID}`;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    if (init.method === 'GET' && route === zone) return ok({ id: ZONE_ID, name: 'example.com' });
    if (init.method === 'GET' && route === `${zone}/dns_records`) return ok(state.records.get(parsed.searchParams.get('name')) ?? []);
    if (init.method === 'GET' && route === `${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`) {
      return state.ruleset === undefined ? json(404, { success: false, errors: [{ code: 10003 }] }) : ok(state.ruleset);
    }
    if (init.method === 'POST' && route === `${zone}/rulesets`) {
      state.ruleset = { id: 'ruleset-new', phase: body.phase, rules: body.rules.map((rule) => ({ id: `rule-${String((counter += 1))}`, ...rule })) };
      return ok(state.ruleset);
    }
    let match;
    if (init.method === 'POST' && (match = new RegExp(`^${zone}/rulesets/([^/]+)/rules$`, 'u').exec(route)) && match[1] === state.ruleset?.id) {
      state.ruleset.rules.push({ id: `rule-${String((counter += 1))}`, ...body });
      return ok(state.ruleset);
    }
    if (init.method === 'PATCH' && (match = new RegExp(`^${zone}/rulesets/([^/]+)/rules/([^/]+)$`, 'u').exec(route)) && match[1] === state.ruleset?.id) {
      const index = state.ruleset.rules.findIndex((rule) => rule.id === match[2]);
      if (index < 0) return json(404, { success: false, errors: [{ code: 10003 }] });
      state.ruleset.rules[index] = { id: match[2], ...body };
      return ok(state.ruleset);
    }
    return json(404, { success: false, errors: [{ code: 7003 }] });
  };
  const cloudflare = createCloudflareClient({ token: 'cloudflare-token', apiUrl: 'https://cloudflare.test/client/v4', fetchImpl });
  return { state, cloudflare, ourRule: (config) => state.ruleset?.rules.find((rule) => rule.ref === `ontos-stable-maintenance-${config.projectId}`) };
};

/** Both fakes and the edge settings, as the gate options maintenance.mjs and data.mjs take. */
export const createFakeGate = (config = fixtureConfig()) => {
  const zerops = createFakeZerops(config);
  const edge = createFakeCloudflare();
  return { zerops, edgeApi: edge, config, gate: { client: zerops.client, cloudflare: edge.cloudflare, edge: fixtureEdge(config) } };
};
