// The launch journeys of one stable verification run. Each journey asserts what its users observe (the identity a
// session carries, the tenant a switch selects, the products a home lists, the message an inbox receives), never a
// status code alone. The ERP import and the MCP OAuth journey run the app's own proofs with explicit stable inputs.
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEPLOYED_WORKLOADS as SERVED_SERVICES } from './deploy-evidence.mjs';
import { CookieJar } from './verify-http.mjs';

const AUTH = '/shell-super-app-api/auth';
const ERP_PROOF_TIMEOUT_MS = 12 * 60_000;
const MCP_PROOF_TIMEOUT_MS = 15 * 60_000;
/** The boundaries stage-symmy-full-function-proof.mts reports as `PASS <boundary>` once each was read back. */
export const ERP_PROOF_BOUNDARIES = Object.freeze([
  'product-replay',
  'sku-readback',
  'stock-readback',
  'list-price-readback',
  'customer-replay',
  'address-readback',
  'order-export',
  'full-proof',
]);
/** The steps of the MCP OAuth proof (app/scripts/demo/mcp-oauth-e2e/prove.mts, --variant=1 --verification). */
export const MCP_PROOF_STEPS = Object.freeze([
  'PRM',
  'AS metadata',
  '401 bez tokenu',
  'OAuth přihlášení a souhlas (iss = issuer)',
  'ontos_whoami',
  'čtení',
  'zápis = návrh ke schválení',
  'úklid: návrh zamítnut',
  'zápis mimo oprávnění = chyba nástroje',
]);

const OPERATOR_SECRETS = [
  'STABLE_VERIFICATION_FILE',
  'ZEROPS_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'STABLE_EDGE_FILE',
  'DATABASE_ADMIN_URL',
  'REHEARSAL_DATABASE_ADMIN_URL',
];
const sameEmail = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
const problemTag = (answer) => (answer.contentType.startsWith('application/problem+json') ? answer.body?._tag : undefined);

const privateDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ontos-stable-verify-'));
  await chmod(directory, 0o700);
  return directory;
};
const writePrivate = async (file, contents) => {
  await writeFile(file, contents, { flag: 'wx', mode: 0o600 });
  return file;
};
const childEnvironment = (extra) => {
  const base = { ...process.env };
  // The proofs get their own inputs only, never the release operator's credentials.
  for (const key of OPERATOR_SECRETS) delete base[key];
  return { ...base, ...extra };
};

// --- Shell sessions -------------------------------------------------------------------------------------------------

const shellSession = ({ config, http, redactor }) => {
  const shell = config.origins.shell;
  const jar = new CookieJar(redactor.add);
  const origin = { origin: shell };
  return {
    jar,
    get: (route, headers = {}) => http(`${shell}${route}`, { headers, jar }),
    post: (route, json) => http(`${shell}${route}`, { headers: origin, jar, json, method: 'POST' }),
    signIn: ({ email, password }) => http(`${shell}${AUTH}/sign-in`, { headers: origin, jar, json: { email, password }, method: 'POST' }),
  };
};

/** Signs a session out, then proves the cookie it held no longer opens a session. */
const signOutAndProveRevoked = async (check, session) => {
  if (session.jar.empty) return;
  const cookie = session.jar.header();
  const out = await session.post(`${AUTH}/sign-out`, {});
  check.expect(out.status === 200 && out.body?.signedOut === true, 'signed out', `sign-out answered ${String(out.status)}`);
  const replay = await session.get(`${AUTH}/session`, { cookie });
  check.expect(
    replay.status === 401 || (replay.status === 200 && replay.body?.state === 'anonymous'),
    'the signed-out session cookie no longer opens a session',
    `the signed-out session cookie still answers ${String(replay.status)} ${String(replay.body?.state)}`,
  );
};

const selectLegalEntity = async (check, session, legalEntityId) => {
  const switched = await session.post(`${AUTH}/legal-entity/switch`, { legalEntityId });
  return check.expect(
    switched.status === 200 && switched.body?.selectedLegalEntityId === legalEntityId,
    'the configured company is selected',
    `selecting the configured company answered ${String(switched.status)} ${String(problemTag(switched) ?? '')}`,
  );
};

const signInAs = async (check, session, account, label) => {
  const answer = await session.signIn(account);
  const identity = answer.body?.identity;
  return check.expect(
    answer.status === 200 && !session.jar.empty && sameEmail(identity?.email, account.email),
    `${label} signed in as the configured account`,
    `${label} sign-in answered ${String(answer.status)} ${String(problemTag(answer) ?? '')}`.trim(),
  );
};

// --- Journeys -------------------------------------------------------------------------------------------------------

/**
 * The active Zerops app version of every served workload is the candidate commit (readActiveVersions of
 * deploy-evidence.mjs, the read the reopen gate makes too): the code under test is the tag.
 */
export const deployedBuild = async (check, { readVersions, release }) => {
  const versions = await readVersions();
  for (const service of SERVED_SERVICES) {
    check.expect(
      versions[service] === release.commit,
      `${service} runs app version ${release.commit}`,
      `${service} runs app version ${String(versions[service] ?? 'none')}, not ${release.commit}`,
    );
  }
};

/** Staff sales: sign-in, company, session identity, the sales modules in the composition, the Shell document. */
export const staffSalesLogin = async (check, context) => {
  const account = context.manifest.accounts.staffSales;
  const session = shellSession(context);
  try {
    if (!(await signInAs(check, session, account, 'staff sales'))) return;
    if (!(await selectLegalEntity(check, session, account.legalEntityId))) return;
    const current = await session.get(`${AUTH}/session`);
    const identity = current.body?.identity;
    check.expect(
      current.status === 200 &&
        current.body?.state === 'authenticated' &&
        sameEmail(identity?.email, account.email) &&
        identity?.tenantId === account.tenantId &&
        identity?.legalEntityId === account.legalEntityId,
      'the session is the staff sales account in its tenant and company',
      `the session is ${String(current.body?.state)}, not the staff sales account in its tenant and company`,
    );
    const composition = await session.get('/shell-super-app-api/shell/composition');
    const available = composition.status === 200 && composition.body?.state === 'available';
    check.expect(available, 'the Shell composes the staff workspace', `the composition is ${String(composition.body?.state ?? composition.status)}`);
    if (available) {
      const navigation = Array.isArray(composition.body.navigation) ? composition.body.navigation : [];
      const missing = account.expectedModuleIds.filter(
        (moduleId) => !navigation.some((item) => item?.moduleId === moduleId && item?.enabled === true),
      );
      check.expect(
        missing.length === 0,
        `the sales modules ${account.expectedModuleIds.join(', ')} are enabled destinations`,
        `the composition lacks enabled destinations of ${missing.join(', ')}`,
      );
      const unavailable = Array.isArray(composition.body.unavailableDeployments) ? composition.body.unavailableDeployments : [];
      check.expect(
        unavailable.length === 0,
        'every module deployment of the release is available',
        `${String(unavailable.length)} module deployment(s) are unavailable`,
      );
    }
    const document = await session.get('/cs', { accept: 'text/html' });
    check.expect(
      document.status === 200 && document.contentType.startsWith('text/html'),
      'the signed-in Shell document renders',
      `the signed-in Shell document answered ${String(document.status)} ${document.contentType}`,
    );
  } finally {
    await signOutAndProveRevoked(check, session);
  }
};

/** Tenant switching: the allowed tenant is listed and selected; the denied one is neither listed nor selectable. */
export const tenantSwitching = async (check, context) => {
  const account = context.manifest.accounts.tenantSwitcher;
  const session = shellSession(context);
  const currentTenant = async () => (await session.get(`${AUTH}/session`)).body?.identity?.tenantId;
  try {
    if (!(await signInAs(check, session, account, 'tenant switcher'))) return;
    const listed = await session.get(`${AUTH}/tenants`);
    const ids = Array.isArray(listed.body?.tenants) ? listed.body.tenants.map((tenant) => tenant?.tenantId) : [];
    check.expect(listed.status === 200 && ids.includes(account.allowedTenantId), 'the allowed tenant is offered', 'the allowed tenant is not offered');
    check.expect(listed.status === 200 && !ids.includes(account.deniedTenantId), 'the denied tenant is not offered', 'the denied tenant is offered');
    const allowed = await session.post(`${AUTH}/tenant/switch`, { tenantId: account.allowedTenantId });
    check.expect(
      allowed.status === 200 && allowed.body?.selectedTenantId === account.allowedTenantId,
      'switching to the allowed tenant selects it',
      `switching to the allowed tenant answered ${String(allowed.status)} ${String(problemTag(allowed) ?? '')}`,
    );
    check.expect(
      (await currentTenant()) === account.allowedTenantId,
      'the session now acts in the allowed tenant',
      'the session does not act in the allowed tenant after the switch',
    );
    const denied = await session.post(`${AUTH}/tenant/switch`, { tenantId: account.deniedTenantId });
    check.expect(
      denied.status === 403 && problemTag(denied) === 'TenantAccessForbiddenProblem',
      'switching to the denied tenant is refused with TenantAccessForbiddenProblem',
      `switching to the denied tenant answered ${String(denied.status)} ${String(problemTag(denied) ?? 'without the access problem')}`,
    );
    check.expect(
      (await currentTenant()) === account.allowedTenantId,
      'the refused switch left the session in the allowed tenant',
      'the refused switch changed the session tenant',
    );
  } finally {
    await signOutAndProveRevoked(check, session);
  }
};

/** One storefront home lists products and no catalogue failure (storefrontHomeProblems of stage-demo-verify.mjs). */
export const storefrontHome = (service) => async (check, { config, http, judgeStorefrontHome }) => {
  const home = await http(`${config.origins[service]}/cs`, { headers: { accept: 'text/html' } });
  check.expect(home.status === 200, `the ${service} home answers 200`, `the ${service} home answered ${String(home.status)}`);
  if (home.status !== 200) return;
  const problems = judgeStorefrontHome(`${service} home`, home.text);
  check.expect(problems.length === 0, `the ${service} home lists products`, problems.join('; '));
};

const storefrontAccount = ({ config, http, redactor }) => {
  const storefront = config.origins.storefront;
  const jar = new CookieJar(redactor.add);
  return {
    jar,
    read: () => http(`${storefront}/api/ontos/account`, { jar }),
    submit: (json) => http(`${storefront}/api/ontos/account`, { headers: { origin: storefront }, jar, json, method: 'POST' }),
  };
};

/** Customer login on the AKROS storefront: the portal session is the configured customer, and logout ends it. */
export const customerLogin = async (check, context) => {
  const customer = context.manifest.accounts.customer;
  const portal = storefrontAccount(context);
  const login = await portal.submit({ email: customer.email, operation: 'login', password: customer.password, rememberMe: false });
  const created = check.expect(
    login.status === 200 && login.body?.outcome === 'SESSION_CREATED' && !portal.jar.empty,
    'the customer signed in to the storefront',
    `the customer sign-in answered ${String(login.status)} ${String(login.body?.outcome ?? login.body?.code ?? '')}`.trim(),
  );
  if (!created) return;
  try {
    const account = (await portal.read()).body?.account;
    check.expect(
      sameEmail(account?.email, customer.email) && account?.tenantId === customer.tenantId,
      'the storefront session is the configured customer in its tenant',
      'the storefront session is not the configured customer in its tenant',
    );
  } finally {
    const logout = await portal.submit({ operation: 'logout' });
    check.expect(logout.status === 200, 'the customer signed out', `the customer logout answered ${String(logout.status)}`);
    const after = await portal.read();
    check.expect(after.status === 200 && after.body?.account === null, 'the logged-out storefront session is anonymous', 'the storefront session survived logout');
  }
};

/** One real e-mail to the allowlisted control inbox: a password reset of the verification customer, read back. */
export const controlEmail = async (check, context) => {
  const { config, http, manifest, now, sleep } = context;
  const inbox = manifest.controlInbox;
  const portal = storefrontAccount(context);
  const requestedAt = now().getTime();
  const reset = await portal.submit({ email: manifest.mutations['control-email'], operation: 'request-password-reset' });
  const started = check.expect(
    reset.status === 200 && reset.body?.outcome === 'ACCOUNT_RECOVERY_STARTED',
    'the storefront started the recovery of the control inbox account',
    `the recovery request answered ${String(reset.status)} ${String(reset.body?.outcome ?? '')}`.trim(),
  );
  if (!started) return;
  const api = (route) => http(`${inbox.apiOrigin}${route}`, { headers: { authorization: inbox.authorization } });
  const query = encodeURIComponent(`to:"${inbox.address}"`);
  const deadline = requestedAt + context.inboxTimeoutMs;
  for (;;) {
    const search = await api(`/api/v1/search?query=${query}&limit=50`);
    check.require(search.status === 200, `the control inbox search answered ${String(search.status)}`);
    const arrived = (Array.isArray(search.body?.messages) ? search.body.messages : []).find(
      (message) =>
        Date.parse(message?.Created) >= requestedAt - 5000 &&
        Array.isArray(message?.To) &&
        message.To.some((to) => sameEmail(to?.Address, inbox.address)),
    );
    if (arrived !== undefined) {
      const message = (await api(`/api/v1/message/${encodeURIComponent(arrived.ID)}`)).body;
      check.pass(`a message reached ${inbox.address} after the request`);
      check.expect(
        sameEmail(message?.From?.Address, inbox.expectedSender),
        `it was sent from ${inbox.expectedSender}`,
        `it was sent from ${String(message?.From?.Address)}, not ${inbox.expectedSender}`,
      );
      check.expect(
        typeof message?.Subject === 'string' && message.Subject.trim().length > 0,
        'it has a subject',
        'it has no subject',
      );
      check.expect(
        `${String(message?.Text ?? '')}${String(message?.HTML ?? '')}`.includes(`${config.origins.storefront}/`),
        'it links back to the stable storefront',
        'it does not link to the stable storefront',
      );
      return;
    }
    if (now().getTime() >= deadline) {
      check.fail(`no message reached the control inbox within ${String(Math.round(context.inboxTimeoutMs / 1000))} s`);
      return;
    }
    await sleep(context.inboxPollMs);
  }
};

/**
 * Controlled synthetic ERP import: stage-symmy-full-function-proof.mts --full with the manifest's dedicated tenant,
 * company, key and orders, on the stable Shell. It imports uniquely prefixed products and customers (no e-mail) and
 * reads each back; the operator session it needs is a fresh sign-in of the configured ERP operator.
 */
export const erpSyntheticImport = async (check, context) => {
  const { appRoot, config, manifest, runProcess } = context;
  const operator = manifest.accounts.erpOperator;
  const session = shellSession(context);
  const directory = await privateDirectory();
  try {
    if (!(await signInAs(check, session, operator, 'ERP operator'))) return;
    if (!(await selectLegalEntity(check, session, operator.legalEntityId))) return;
    const keyFile = await writePrivate(path.join(directory, 'symmy-api-key'), manifest.erp.apiKey);
    const jarFile = await writePrivate(path.join(directory, 'operator-cookies.txt'), session.jar.netscape(new URL(config.origins.shell).hostname));
    const result = await runProcess({
      args: ['scripts/ops/stage-symmy-full-function-proof.mts', '--full'],
      command: process.execPath,
      cwd: appRoot,
      env: childEnvironment({
        SYMMY_API_KEY_FILE: keyFile,
        SYMMY_PROOF_INPUT_JSON: JSON.stringify(manifest.erp.input),
        SYMMY_PROOF_LEGAL_ENTITY_ID: manifest.erp.legalEntityId,
        SYMMY_PROOF_OPERATOR_COOKIE_FILE: jarFile,
        SYMMY_PROOF_ORDER_IDS_JSON: JSON.stringify(manifest.erp.expectedOrderIds),
        SYMMY_PROOF_ORIGIN: config.origins.shell,
        SYMMY_PROOF_STOCK_SOURCE_JSON: JSON.stringify(manifest.erp.stockSource),
      }),
      timeoutMs: ERP_PROOF_TIMEOUT_MS,
    });
    const lines = `${result.stdout}\n${result.stderr}`.split('\n').map((line) => line.trim());
    check.expect(result.code === 0 && !result.timedOut, 'the ERP proof exited 0', `the ERP proof exited ${String(result.code)}${result.timedOut ? ' (deadline)' : ''}`);
    for (const failure of lines.filter((line) => line.startsWith('FAIL '))) check.fail(failure);
    for (const boundary of ERP_PROOF_BOUNDARIES) {
      check.expect(lines.includes(`PASS ${boundary}`), `ERP ${boundary} read back`, `ERP ${boundary} was not proven`);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
    await signOutAndProveRevoked(check, session);
  }
};

/**
 * External OAuth MCP: the real CIMD client flow of prove-mcp-oauth.mts --variant=1 --verification against the stable
 * Shell, as the stable verification persona; its whoami must be exactly the manifest's principal and company, on
 * work.tasks only. Its write becomes a proposal that the proof itself rejects again.
 */
export const mcpOAuth = async (check, { appRoot, config, manifest, now, resolvePlaywright, runProcess }) => {
  const shell = config.origins.shell;
  const issuer = `${shell}/shell-super-app-api/oauth`;
  const directory = await privateDirectory();
  const startedAt = now().getTime();
  try {
    const result = await runProcess({
      args: ['scripts/demo/prove-mcp-oauth.mts', '--variant=1', '--verification'],
      command: process.execPath,
      cwd: appRoot,
      env: childEnvironment({
        E2E_OUT_DIR: directory,
        E2E_PASSWORD: manifest.accounts.mcp.password,
        E2E_PLAYWRIGHT_MODULE: resolvePlaywright(),
        E2E_SHOTS_DIR: path.join(directory, 'shots'),
        E2E_VERIFICATION_LEGAL_ENTITY_ID: manifest.accounts.mcp.legalEntityId,
        E2E_VERIFICATION_PERSONA: manifest.accounts.mcp.email,
        E2E_VERIFICATION_PRINCIPAL_ID: manifest.accounts.mcp.principalId,
        ONTOS_OAUTH_ISSUER: issuer,
        ONTOS_SHELL_URL: shell,
      }),
      timeoutMs: MCP_PROOF_TIMEOUT_MS,
    });
    check.expect(result.code === 0 && !result.timedOut, 'the MCP OAuth proof exited 0', `the MCP OAuth proof exited ${String(result.code)}${result.timedOut ? ' (deadline)' : ''}`);
    let report;
    try {
      report = JSON.parse(await readFile(path.join(directory, 'mcp-oauth-e2e.json'), 'utf8'));
    } catch (error) {
      check.fail(`the MCP OAuth proof wrote no readable report (${error.code ?? error.name})`);
      return;
    }
    check.expect(
      report.shellUrl === shell && report.mcpUrl === `${shell}/mcp` && report.issuer === issuer,
      'the proof ran against the stable Shell, its /mcp resource and its issuer',
      'the proof report names another Shell, resource or issuer',
    );
    check.expect(
      Date.parse(report.finishedAt) >= startedAt,
      'the report is from this run',
      'the report predates this run',
    );
    const steps = Array.isArray(report.steps) ? report.steps : [];
    for (const name of MCP_PROOF_STEPS) {
      const step = steps.find((entry) => entry?.name === name);
      check.expect(step?.pass === true, `MCP ${name}`, `MCP ${name}: ${step === undefined ? 'did not run' : String(step.detail)}`);
    }
    for (const step of steps.filter((entry) => entry?.pass !== true && !MCP_PROOF_STEPS.includes(entry?.name))) {
      check.fail(`MCP ${String(step?.name)}: ${String(step?.detail)}`);
    }
    check.expect(report.pass === true, 'the MCP OAuth proof passed every step', 'the MCP OAuth proof report is not a pass');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};
