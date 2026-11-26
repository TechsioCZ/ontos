// Stable maintenance: the weekend ingress gate and the workloads behind it.
//
// The gate is the project's Cloudflare WAF rule (edge.mjs): every request to the four stable hostnames is blocked
// except from the verifier IPs, and the workloads' native zerops.app subdomains, which bypass Cloudflare, are disabled.
// The Zerops public routings and their certificates stay untouched, so verify.mjs reaches the real origins from an
// allowlisted machine while customers are kept out. SpiceDB and db18 keep running: backups, restores and migrations
// need them.
//
// The state is read from Zerops and Cloudflare each time, so a crash or a retry cannot lose it:
//   maintenance  gate closed; app, storefront, shop, n1 and migrator not running   (data restore allowed)
//   gated        gate closed; something running                                     (install, live verification)
//   open         the maintenance rule off or absent; app, storefront, shop and n1 ACTIVE
//   partial      anything else
// `enter` closes the gate first and then stops; it never starts or opens, also on failure. `start-gated` starts the
// app and the fronts behind the closed gate (never the migrator). `leave` is the only call that opens, and only after
// the release's reopen evidence check (deploy-evidence.mjs assertReopenEvidence) accepted the live verification of the
// commit every workload runs; it disables the project's own rule and nothing else.
//
// Zerops endpoints (base URL and request shapes as app/scripts/zerops-public-api.mts sends them): GET /project/{id},
// GET /service-stack/{id}, PUT /service-stack/{id}/stop, GET /process/{id}, GET /project/{id}/env-file. Present in zcli
// 1.1.3's Zerops SDK but not yet called elsewhere in this repository: PUT /service-stack/{id}/start
// (PutServiceStackStart) and PUT /service-stack/{id}/disable-subdomain-access. This tool stays standalone Node,
// outside the app's Effect runtime, so it repeats that module's base URL and env-file line format.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { closeEdge, cloudflareClientFromEnv, edgeSettingsFromEnv, edgeStatus, openEdge, readPrivateJson } from './edge.mjs';

export { readPrivateJson };

export class MaintenanceError extends Error {
  name = 'MaintenanceError';
}

/** The Zerops region API the repository deploys through (ZEROPS_PUBLIC_API_URL in app/scripts/zerops-public-api.mts). */
export const ZEROPS_PUBLIC_API_URL = 'https://api.app-prg1.zerops.io/api/rest/public';

/** Reads Zerops `KEY="VALUE"` env-file lines (parseZeropsEnvFile in app/scripts/zerops-public-api.mts). */
export const parseZeropsEnvFile = (envFile) =>
  new Map(
    envFile.split('\n').flatMap((line) => {
      const separator = line.indexOf('=');
      if (separator <= 0) return [];
      const raw = line.slice(separator + 1);
      return [[line.slice(0, separator), raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw]];
    }),
  );

/** Request-serving workloads, in stop order: the public fronts first, then the Shell they call. Start order reverses. */
export const MAINTENANCE_WORKLOADS = Object.freeze(['storefront', 'shop', 'n1', 'app']);
/** Writes to the databases when it runs; stopped by `enter`, never started here. */
export const MAINTENANCE_MIGRATOR = 'migrator';
/** Services that stay up through maintenance because backups, restores and migrations need them. */
export const MAINTENANCE_DATASTORES = Object.freeze(['spicedb', 'db18']);

const TERMINAL_PROCESS = new Set(['FINISHED', 'FAILED', 'CANCELED']);
/** Zerops service statuses that are not transitions. READY_TO_DEPLOY: created, never deployed, not running. */
const SETTLED_SERVICE = new Set(['ACTIVE', 'STOPPED', 'READY_TO_DEPLOY']);
const NOT_RUNNING = new Set(['STOPPED', 'READY_TO_DEPLOY']);
const REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const statusText = (value) => (typeof value === 'string' && /^[A-Z][A-Z_]{0,31}$/u.test(value) ? value : 'unknown');

/**
 * A minimal Zerops public API client. The token goes only into the Authorization header; errors carry the HTTP status
 * and Zerops' machine error code, never a body, URL query or token.
 */
export const createZeropsClient = ({
  token,
  apiUrl = ZEROPS_PUBLIC_API_URL,
  fetchImpl = fetch,
  pollMs = 3000,
  processTimeoutMs = 15 * 60_000,
  settleTimeoutMs = 5 * 60_000,
}) => {
  if (typeof token !== 'string' || token.length === 0) throw new MaintenanceError('ZEROPS_TOKEN is required');
  const request = async (method, route, label) => {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${route}`, {
        method,
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MaintenanceError(`Zerops ${label} failed: ${error.name}`);
    }
    const answer = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = typeof answer?.error?.code === 'string' ? ` ${answer.error.code}` : '';
      throw new MaintenanceError(`Zerops ${label} failed: HTTP ${String(response.status)}${code}`);
    }
    return answer;
  };

  /** Runs a native action and waits for its process to finish. */
  const act = async (route, label) => {
    const process = await request('PUT', route, label);
    if (typeof process?.id !== 'string' || typeof process.status !== 'string') throw new MaintenanceError(`Zerops ${label} returned no process`);
    const deadline = Date.now() + processTimeoutMs;
    let current = process;
    while (!TERMINAL_PROCESS.has(current.status)) {
      if (Date.now() > deadline) throw new MaintenanceError(`Zerops ${label} process did not finish in time`);
      await sleep(pollMs);
      current = await request('GET', `/process/${encodeURIComponent(process.id)}`, `${label} process read`);
    }
    if (current.status !== 'FINISHED') throw new MaintenanceError(`Zerops ${label} process ended as ${statusText(current.status)}`);
  };

  const service = async (serviceId) => {
    const body = await request('GET', `/service-stack/${encodeURIComponent(serviceId)}`, 'service read');
    for (const key of ['id', 'projectId', 'name', 'status']) {
      if (typeof body?.[key] !== 'string' || body[key].length === 0) throw new MaintenanceError(`Zerops service read returned no ${key}`);
    }
    if (typeof body.subdomainAccess !== 'boolean') throw new MaintenanceError('Zerops service read returned no subdomainAccess');
    if (body.id !== serviceId) throw new MaintenanceError('Zerops service read returned a different service identity');
    return { id: body.id, projectId: body.projectId, name: body.name, status: body.status, subdomainAccess: body.subdomainAccess };
  };

  /** Polls a service until it is ACTIVE, STOPPED or READY_TO_DEPLOY (a running stop, start or deploy is waited out). */
  const settledService = async (serviceId) => {
    const deadline = Date.now() + settleTimeoutMs;
    let current = await service(serviceId);
    while (!SETTLED_SERVICE.has(current.status)) {
      if (Date.now() > deadline) throw new MaintenanceError(`Zerops service ${current.name} stayed ${statusText(current.status)}`);
      await sleep(pollMs);
      current = await service(serviceId);
    }
    return current;
  };

  const transition = async (serviceId, action) => {
    const wanted = action === 'stop' ? 'STOPPED' : 'ACTIVE';
    await act(`/service-stack/${encodeURIComponent(serviceId)}/${action}`, `service ${action}`);
    const after = await settledService(serviceId);
    if (after.status !== wanted) throw new MaintenanceError(`Zerops service ${after.name} is ${statusText(after.status)} after ${action}`);
    return after;
  };

  return {
    project: async (projectId) => {
      const body = await request('GET', `/project/${encodeURIComponent(projectId)}`, 'project read');
      if (body?.id !== projectId) throw new MaintenanceError('Zerops project read returned a different project identity');
      return { id: body.id };
    },
    service,
    settledService,
    stopService: (serviceId) => transition(serviceId, 'stop'),
    startService: (serviceId) => transition(serviceId, 'start'),
    disableSubdomainAccess: async (serviceId) => {
      await act(`/service-stack/${encodeURIComponent(serviceId)}/disable-subdomain-access`, 'subdomain disable');
      if ((await service(serviceId)).subdomainAccess) throw new MaintenanceError('Zerops subdomain access is still enabled');
    },
    /** The project variables as a KEY → value map, secrets unrevealed (the request zerops-public-api.mts sends). */
    projectEnvFile: async (projectId) => {
      const body = await request(
        'GET',
        `/project/${encodeURIComponent(projectId)}/env-file?name=&overrideEnvIsolation=none&userOnly=false&reveal=false`,
        'project env file',
      );
      if (typeof body?.envFile !== 'string') throw new MaintenanceError('Zerops project env file is missing');
      return parseZeropsEnvFile(body.envFile);
    },
  };
};

export const zeropsClientFromEnv = (env = process.env) => createZeropsClient({ token: env.ZEROPS_TOKEN });

/**
 * assertProjectServices(config, { client? } = {}) → Promise<{ [name]: { id, projectId, name, status, subdomainAccess } }>
 * Proves that the stable project is not the demo project, that the token reads it, and that every configured service
 * id is a service of exactly that project under the configured hostname. Returns the services as just read.
 */
export const assertProjectServices = async (config, { client = zeropsClientFromEnv() } = {}) => {
  if (config.projectId === config.demoProjectId) throw new MaintenanceError('the stable project id is the demo project id; refusing');
  await client.project(config.projectId);
  const services = {};
  for (const [name, serviceId] of Object.entries(config.services)) {
    const service = await client.service(serviceId);
    if (service.projectId !== config.projectId) {
      throw new MaintenanceError(
        service.projectId === config.demoProjectId
          ? `services.${name} belongs to the demo project; refusing`
          : `services.${name} belongs to another project; refusing`,
      );
    }
    if (service.name !== name) throw new MaintenanceError(`services.${name} is the Zerops service named ${service.name}; refusing`);
    services[name] = service;
  }
  return services;
};

/** The Zerops client, Cloudflare client and edge settings: given, or from ZEROPS_TOKEN, CLOUDFLARE_API_TOKEN, STABLE_EDGE_FILE. */
const resolveGate = async (config, { client, cloudflare, edge }) => ({
  client: client ?? zeropsClientFromEnv(),
  cloudflare: cloudflare ?? cloudflareClientFromEnv(),
  edge: edge ?? (await edgeSettingsFromEnv(config)),
});

const describe = (config, services, edgeView) => {
  const view = (names) => Object.fromEntries(names.map((name) => [name, { id: services[name].id, status: statusText(services[name].status) }]));
  const workloads = view(MAINTENANCE_WORKLOADS);
  const migrator = view([MAINTENANCE_MIGRATOR])[MAINTENANCE_MIGRATOR];
  const subdomains = [...MAINTENANCE_WORKLOADS, MAINTENANCE_MIGRATOR].filter((name) => services[name].subdomainAccess);
  const gateClosed = edgeView.closed && subdomains.length === 0;
  const statuses = Object.values(workloads).map(({ status }) => status);
  let state = 'partial';
  if (gateClosed) {
    state = [...statuses, migrator.status].every((status) => NOT_RUNNING.has(status)) ? 'maintenance' : 'gated';
  } else if (['disabled', 'missing'].includes(edgeView.rule.state) && statuses.every((status) => status === 'ACTIVE')) {
    state = 'open';
  }
  return {
    projectId: config.projectId,
    state,
    gate: { closed: gateClosed, rule: edgeView.rule.state, hosts: edgeView.hosts.map(({ host, proxied }) => ({ host, proxied })), subdomains },
    workloads,
    migrator,
    datastores: view(MAINTENANCE_DATASTORES),
  };
};

/**
 * maintenanceStatus(config, { client?, cloudflare?, edge? } = {}) →
 *   { projectId, state, gate: { closed, rule, hosts: [{ host, proxied }], subdomains }, workloads, migrator, datastores }
 * read live after the ownership check.
 */
export const maintenanceStatus = async (config, options = {}) => {
  const { client, cloudflare, edge } = await resolveGate(config, options);
  const services = await assertProjectServices(config, { client });
  return describe(config, services, await edgeStatus(config, edge, { cloudflare }));
};

const assertDatastoresActive = (status) => {
  for (const [name, { status: datastore }] of Object.entries(status.datastores)) {
    if (datastore !== 'ACTIVE') throw new MaintenanceError(`${name} is ${datastore}; data operations need it ACTIVE`);
  }
};

/** assertInMaintenance(config, { client?, cloudflare?, edge? }): gate closed, nothing running, datastores ACTIVE (restore precondition). */
export const assertInMaintenance = async (config, options = {}) => {
  const status = await maintenanceStatus(config, options);
  if (status.state !== 'maintenance') throw new MaintenanceError(`stable project is ${status.state}, not in maintenance; run maintenance.mjs enter first`);
  assertDatastoresActive(status);
  return status;
};

/** assertEdgeClosed(config, { client?, cloudflare?, edge? }): state maintenance or gated (install and live verification precondition). */
export const assertEdgeClosed = async (config, options = {}) => {
  const status = await maintenanceStatus(config, options);
  if (status.state !== 'maintenance' && status.state !== 'gated') {
    throw new MaintenanceError(`stable project gate is not closed (state ${status.state}); run maintenance.mjs enter first`);
  }
  assertDatastoresActive(status);
  return status;
};

/**
 * enterMaintenance(config, { client?, cloudflare?, edge?, log? }) → status. Checks ownership, closes the Cloudflare gate
 * (proxied hosts required), disables the native subdomains, reads the gate back closed, and only then stops every
 * running workload and the migrator. Idempotent: a rerun after a crash, a deploy or a failed verification redoes only
 * what is still open or running. A failure throws and opens or starts nothing.
 */
export const enterMaintenance = async (config, options = {}) => {
  const gate = await resolveGate(config, options);
  const log = options.log ?? (() => {});
  const services = await assertProjectServices(config, { client: gate.client });
  await closeEdge(config, gate.edge, { cloudflare: gate.cloudflare, log });
  for (const name of [...MAINTENANCE_WORKLOADS, MAINTENANCE_MIGRATOR]) {
    if (!services[name].subdomainAccess) continue;
    log(`disabling the ${name} zerops.app subdomain`);
    await gate.client.disableSubdomainAccess(services[name].id);
  }
  const gated = await maintenanceStatus(config, gate);
  if (!gated.gate.closed) throw new MaintenanceError('the gate does not read back closed; nothing was stopped');
  for (const name of [...MAINTENANCE_WORKLOADS, MAINTENANCE_MIGRATOR]) {
    const service = await gate.client.settledService(config.services[name]);
    if (NOT_RUNNING.has(service.status)) continue;
    log(`stopping ${name}`);
    await gate.client.stopService(service.id);
  }
  return maintenanceStatus(config, gate);
};

/**
 * startGated(config, { client?, cloudflare?, edge?, log? }) → status. Starts the app, then the fronts, behind the closed
 * gate so the installed candidate can be verified from a verifier IP. Never starts the migrator. Refuses while the gate
 * is not closed or a workload was never deployed.
 */
export const startGated = async (config, options = {}) => {
  const gate = await resolveGate(config, options);
  const log = options.log ?? (() => {});
  await assertEdgeClosed(config, gate);
  for (const name of [...MAINTENANCE_WORKLOADS].reverse()) {
    const service = await gate.client.settledService(config.services[name]);
    if (service.status === 'ACTIVE') continue;
    if (service.status === 'READY_TO_DEPLOY') throw new MaintenanceError(`${name} was never deployed; deploy it before starting`);
    log(`starting ${name} behind the closed gate`);
    await gate.client.startService(service.id);
  }
  return assertEdgeClosed(config, gate);
};

/**
 * leaveMaintenance(config, { evidence, configPath, assertReopenEvidence?, client?, cloudflare?, edge?, log? }) → status.
 * The release's reopen. Requires app, storefront, shop and n1 ACTIVE behind the closed gate, then
 * `assertReopenEvidence(evidence, { config, configPath, status, client })` (default: deploy-evidence.mjs) must accept
 * complete passed live verification of the commit every workload runs. Only then it disables the project's maintenance
 * rule, and reads the project back open. It starts nothing; native subdomains stay disabled.
 */
export const leaveMaintenance = async (config, options) => {
  const gate = await resolveGate(config, options);
  const log = options.log ?? (() => {});
  const assertReopenEvidence = options.assertReopenEvidence ?? (await import('./deploy-evidence.mjs')).assertReopenEvidence;
  const status = await maintenanceStatus(config, gate);
  if (status.state === 'open') return status;
  if (!status.gate.closed) throw new MaintenanceError(`the gate is not closed (state ${status.state}); run enter, start-gated and verify.mjs first`);
  const idle = Object.entries(status.workloads).filter(([, { status: workload }]) => workload !== 'ACTIVE');
  if (idle.length > 0) throw new MaintenanceError(`${idle.map(([name]) => name).join(', ')} not ACTIVE; run start-gated and verify.mjs first`);
  await assertReopenEvidence(options.evidence, { config, configPath: options.configPath, status, client: gate.client });
  await openEdge(config, gate.edge, { cloudflare: gate.cloudflare, log });
  const after = await maintenanceStatus(config, gate);
  if (after.state !== 'open') throw new MaintenanceError(`the project does not read back open (state ${after.state})`);
  return after;
};

const USAGE = `Usage:
  maintenance.mjs status      --config PATH
  maintenance.mjs enter       --config PATH --confirm-project PROJECT_ID
  maintenance.mjs start-gated --config PATH --confirm-project PROJECT_ID
  maintenance.mjs leave       --config PATH --confirm-project PROJECT_ID --evidence VERIFICATION_JSON
Environment: ZEROPS_TOKEN, CLOUDFLARE_API_TOKEN, STABLE_EDGE_FILE (edge settings, see edge.mjs).
enter enables the project's Cloudflare maintenance rule (only verifier IPs reach the four stable hostnames), disables
the zerops.app subdomains, then stops app, storefront, shop, n1 and migrator; spicedb and db18 stay up. start-gated
starts app and fronts behind the gate. leave disables the rule only after the reopen evidence check accepts the live
verification of what every workload runs. Nothing ever reopens on its own.
`;

export const main = async (argv, { env = process.env, client, cloudflare, edge, assertReopenEvidence, stdout = process.stdout, stderr = process.stderr } = {}) => {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help') {
    stdout.write(USAGE);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: { config: { type: 'string' }, 'confirm-project': { type: 'string' }, evidence: { type: 'string' } },
  });
  if (values.config === undefined) throw new MaintenanceError('--config is required');
  if (!['status', 'enter', 'start-gated', 'leave'].includes(command)) throw new MaintenanceError(`unknown command ${command}; use --help`);
  if (command !== 'leave' && values.evidence !== undefined) throw new MaintenanceError('--evidence belongs to leave');
  if (command === 'leave' && values.evidence === undefined) throw new MaintenanceError('leave requires --evidence with the live verification evidence');
  const configPath = path.resolve(values.config);
  const { loadStableConfig } = await import('./config.mjs');
  const config = await loadStableConfig(configPath);
  if (command !== 'status' && values['confirm-project'] !== config.projectId) {
    throw new MaintenanceError(`${command} requires --confirm-project equal to the config projectId`);
  }
  const gate = {
    client: client ?? zeropsClientFromEnv(env),
    cloudflare: cloudflare ?? cloudflareClientFromEnv(env),
    edge: edge ?? (await edgeSettingsFromEnv(config, env)),
    log: (line) => stderr.write(`[maintenance] ${line}\n`),
  };
  let result;
  if (command === 'status') result = await maintenanceStatus(config, gate);
  else if (command === 'enter') result = await enterMaintenance(config, gate);
  else if (command === 'start-gated') result = await startGated(config, gate);
  else {
    const evidence = await readPrivateJson(path.resolve(values.evidence), 'verification evidence');
    result = await leaveMaintenance(config, { ...gate, evidence, configPath, assertReopenEvidence });
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Stable maintenance: ${error.message}\n`);
    process.exitCode = 1;
  });
}
