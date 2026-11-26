import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ARTIFACTS_KIND } from './deploy.mjs';
import { EVIDENCE_KIND, REQUIRED_CHECK_IDS, parseCli, runVerification } from './verify.mjs';
import { ERP_PROOF_BOUNDARIES, MCP_PROOF_STEPS } from './verify-journeys.mjs';
import { validateVerificationManifest } from './verify-manifest.mjs';

// Local transport fixtures of one stable verification run. The fake stable world answers like the Shell, the AKROS
// storefront portal, the Zerops API and a Mailpit inbox; the app proofs are fake child processes. What these tests
// prove is verify.mjs's own behaviour: binding, semantic assertions, isolation of failures, opt-in writes and
// redaction. The app contracts it reuses (storefrontHomeProblems, isTestRecipient, the two proofs) have their own tests
// in app/ and run for real only against stable.

const read = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const CONFIG = read('./example.config.json');
const MANIFEST = read('./verify-manifest.example.json');
const COMMIT = 'c'.repeat(40);
const TAG = 'sales-stable/2026-11-27';
const RELEASE = { commit: COMMIT, tag: TAG, tagObject: 't'.repeat(40) };
const NOW = new Date('2026-11-28T10:00:00.000Z');
const SECRETS = [
  'sales-secret-1',
  'tenants-secret-2',
  'customer-secret-3',
  'erp-operator-secret-4',
  'mcp-secret-5',
  'symmy-key-secret-6',
  'inbox-token-secret-7',
];

const appModules = {
  isTestRecipient: (address) => /\.(?:test|invalid)$/u.test(address) || /test/u.test(address.split('@')[0]),
  // A stand-in for stage-demo-verify.mjs storefrontHomeProblems: a home that links no product is a problem.
  judgeStorefrontHome: (label, html) => (html.includes('/produkt/') ? [] : [`${label} lists no product`]),
  resolvePlaywright: () => '/fixture/playwright/index.js',
};

const manifestWithSecrets = () => {
  const manifest = structuredClone(MANIFEST);
  const { accounts } = manifest;
  [accounts.staffSales, accounts.tenantSwitcher, accounts.customer, accounts.erpOperator, accounts.mcp].forEach(
    (account, index) => {
      account.password = SECRETS[index];
    },
  );
  manifest.erp.apiKey = SECRETS[5];
  manifest.controlInbox.authorization = `Bearer ${SECRETS[6]}`;
  return manifest;
};

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: [['content-type', init.contentType ?? 'application/json'], ...(init.headers ?? [])],
  });
const problem = (tag, status) => json({ _tag: tag, detail: tag, status, title: tag, type: 'about:blank' }, { contentType: 'application/problem+json', status });
const home = (products) => new Response(`<html>${'x'.repeat(1000)}${products ? '<a href="/cs/produkt/a">A</a>' : ''}</html>`, { headers: { 'content-type': 'text/html' } });

/** A fake stable environment. `faults` switches single behaviours to their broken form. */
const createWorld = (manifest, faults = {}) => {
  const calls = [];
  const sessions = new Map();
  const portal = new Map();
  const inbox = [];
  const accounts = Object.values(manifest.accounts);
  let counter = 0;
  const cookieOf = (request, name) => (request.headers.get('cookie') ?? '').split('; ').find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  const shell = async (route, request) => {
    const session = sessions.get(cookieOf(request, 'sid'));
    const live = session !== undefined && !session.signedOut;
    const body = request.method === 'POST' ? JSON.parse(await request.text()) : undefined;
    if (route === '/shell-super-app-api/auth/sign-in') {
      const account = accounts.find((entry) => entry.email === body.email && entry.password === body.password);
      if (account === undefined || faults.staffSignIn === account.email) return problem('InvalidCredentialsProblem', 401);
      const id = `sid-${String((counter += 1))}-${account.email}`;
      sessions.set(id, { email: account.email, legalEntityId: undefined, signedOut: false, tenantId: account.tenantId ?? account.allowedTenantId ?? '00000000-0000-4000-8000-0000000000b0' });
      return json({ identity: { email: account.email, tenantId: sessions.get(id).tenantId } }, { headers: [['set-cookie', `sid=${id}; Path=/; HttpOnly; Secure`]] });
    }
    if (route === '/shell-super-app-api/auth/session') {
      if (!live) return json({ state: 'anonymous' });
      return json({ identity: { email: session.email, legalEntityId: session.legalEntityId, tenantId: session.tenantId }, state: session.legalEntityId ? 'authenticated' : 'tenant_authenticated' });
    }
    if (!live) return problem('TenantAuthenticationRequiredProblem', 401);
    if (route === '/shell-super-app-api/auth/sign-out') {
      if (!faults.signOutKeepsSession) session.signedOut = true;
      return json({ signedOut: true }, { headers: [['set-cookie', 'sid=; Path=/; Max-Age=0']] });
    }
    if (route === '/shell-super-app-api/auth/legal-entity/switch') {
      session.legalEntityId = body.legalEntityId;
      return json({ selectedLegalEntityId: body.legalEntityId });
    }
    if (route === '/shell-super-app-api/shell/composition') {
      const modules = faults.missingModule ? ['demo.crm'] : manifest.accounts.staffSales.expectedModuleIds;
      return json({ navigation: modules.map((moduleId) => ({ enabled: true, moduleId })), state: 'available', unavailableDeployments: [] });
    }
    if (route === '/cs') return new Response('<html>shell</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const switcher = manifest.accounts.tenantSwitcher;
    if (route === '/shell-super-app-api/auth/tenants') {
      return json({ tenants: [{ name: 'Verification', tenantId: switcher.allowedTenantId }, ...(faults.deniedTenantListed ? [{ name: 'Customer', tenantId: switcher.deniedTenantId }] : [])] });
    }
    if (route === '/shell-super-app-api/auth/tenant/switch') {
      if (body.tenantId === switcher.deniedTenantId && !faults.deniedTenantSwitches) return problem('TenantAccessForbiddenProblem', 403);
      session.tenantId = body.tenantId;
      return json({ selectedTenantId: body.tenantId });
    }
    return new Response('not found', { status: 404 });
  };
  const storefront = async (route, request) => {
    if (route === '/cs') return home(!faults.emptyStorefront);
    if (route !== '/api/ontos/account') return new Response('not found', { status: 404 });
    const id = cookieOf(request, 'commerce-portal.session');
    if (request.method === 'GET') {
      const customer = portal.get(id);
      return json({ account: customer === undefined ? null : { email: customer.email, id: 'c1', name: 'Kontrola', partyId: 'p1', tenantId: customer.tenantId } });
    }
    assert.equal(request.headers.get('origin'), CONFIG.origins.storefront);
    const body = JSON.parse(await request.text());
    const customer = manifest.accounts.customer;
    if (body.operation === 'login') {
      if (body.email !== customer.email || body.password !== customer.password) return json({ message: 'no' }, { status: 401 });
      portal.set('portal-1', customer);
      return json({ outcome: 'SESSION_CREATED' }, { headers: [['set-cookie', 'commerce-portal.session=portal-1; Path=/; HttpOnly; Secure']] });
    }
    if (body.operation === 'logout') {
      portal.delete(id);
      return json({ outcome: 'SIGNED_OUT' });
    }
    if (body.operation === 'request-password-reset') {
      if (!faults.noEmail) {
        inbox.push({
          Created: NOW.toISOString(),
          From: { Address: faults.wrongSender ? 'spoof@elsewhere.example' : 'noreply@ontos.example.com' },
          HTML: `<a href="${CONFIG.origins.storefront}/obnova-hesla">Obnovit heslo</a>`,
          ID: `m${String(inbox.length + 1)}`,
          Subject: 'Obnova hesla',
          Text: '',
          To: [{ Address: body.email }],
        });
      }
      return json({ outcome: 'ACCOUNT_RECOVERY_STARTED' });
    }
    return json({ message: 'unknown' }, { status: 400 });
  };
  const fetchImpl = async (url, init = {}) => {
    const request = new Request(url, init);
    const { origin, pathname, searchParams } = new URL(url);
    calls.push(`${request.method} ${origin}${pathname}`);
    if (faults.unreachable === origin) throw new TypeError('fetch failed');
    if (origin === 'https://api.app-prg1.zerops.io') {
      assert.equal(request.headers.get('authorization'), 'Bearer zerops-token-secret');
      const id = pathname.split('/').at(-1);
      const stale = faults.staleService !== undefined && CONFIG.services[faults.staleService] === id;
      return json({ activeAppVersion: { name: stale ? 'd'.repeat(40) : COMMIT, status: 'ACTIVE' }, id, projectId: CONFIG.projectId, status: 'ACTIVE' });
    }
    if (origin === CONFIG.origins.shell) return shell(pathname, request);
    if (origin === CONFIG.origins.storefront) return storefront(pathname, request);
    if (origin === CONFIG.origins.shop || origin === CONFIG.origins.n1) return home(true);
    if (origin === manifest.controlInbox.apiOrigin) {
      if (request.headers.get('authorization') !== manifest.controlInbox.authorization) return json({}, { status: 401 });
      if (pathname === '/api/v1/search') {
        const to = /to:"([^"]+)"/u.exec(searchParams.get('query'))?.[1];
        return json({ messages: inbox.filter((message) => message.To.some((entry) => entry.Address === to)) });
      }
      return json(inbox.find((message) => message.ID === pathname.split('/').at(-1)));
    }
    return new Response('unknown origin', { status: 502 });
  };
  const processes = [];
  const runProcess = async ({ args, cwd, env }) => {
    processes.push({ args, cwd, env });
    if (args[0] === 'scripts/ops/stage-symmy-full-function-proof.mts') {
      assert.equal(readFileSync(env.SYMMY_API_KEY_FILE, 'utf8'), manifest.erp.apiKey);
      assert.match(readFileSync(env.SYMMY_PROOF_OPERATOR_COOKIE_FILE, 'utf8'), /^ontos\.example\.com\tFALSE\t\/\tTRUE\t0\tsid\tsid-/u);
      const boundaries = faults.erpPartial ? ERP_PROOF_BOUNDARIES.filter((boundary) => boundary !== 'customer-replay') : ERP_PROOF_BOUNDARIES;
      return { code: 0, stderr: '', stdout: boundaries.map((boundary) => `PASS ${boundary}`).join('\n'), timedOut: false };
    }
    const steps = MCP_PROOF_STEPS.map((name) => ({ detail: 'ok', ms: 1, name, pass: !(faults.mcpWrite && name === 'zápis = návrh ke schválení'), variant: 'v1' }));
    writeFileSync(
      path.join(env.E2E_OUT_DIR, 'mcp-oauth-e2e.json'),
      JSON.stringify({ finishedAt: new Date(NOW.getTime() + 1000).toISOString(), issuer: env.ONTOS_OAUTH_ISSUER, mcpUrl: `${env.ONTOS_SHELL_URL}/mcp`, pass: steps.every((step) => step.pass), shellUrl: env.ONTOS_SHELL_URL, steps }),
    );
    return { code: 0, stderr: '', stdout: '', timedOut: false };
  };
  return { calls, fetchImpl, inbox, processes, runProcess };
};

const scenario = (t, { manifest = manifestWithSecrets(), faults = {}, files = {}, options = {} } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-verify-test-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const file = (name, value, mode = 0o600) => {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    return target;
  };
  const configPath = file('config.json', `${JSON.stringify(CONFIG, null, 2)}\n`);
  const configDigest = createHash('sha256').update(readFileSync(configPath)).digest('hex');
  const artifactManifestPath = file('artifacts/manifest.json', {
    commit: COMMIT, configDigest, kind: ARTIFACTS_KIND, projectId: CONFIG.projectId, schemaVersion: 1, tag: TAG, tagObject: RELEASE.tagObject, ...files.artifacts,
  });
  const backupManifest = file('backup/manifest.json', { kind: 'ontos.stable.backup', projectId: CONFIG.projectId });
  const backupManifestSha256 = createHash('sha256').update(readFileSync(backupManifest)).digest('hex');
  const rehearsal = {
    backupManifestSha256, commit: COMMIT, finishedAt: '2026-11-28T08:10:00.000Z', kind: 'ontos.stable.migration-rehearsal', migratorExitCode: 0,
    schemaVersion: 1, scratchSystemIdentifier: '7400000000000000001', sourceProjectId: CONFIG.projectId, startedAt: '2026-11-28T08:00:00.000Z', tag: TAG, verdict: 'passed',
    ...files.rehearsal,
  };
  const walkthrough = {
    commit: COMMIT, kind: 'ontos.stable.sales-walkthrough', notes: 'Prošel jsem objednávku, nabídku a zákazníka.', performedAt: '2026-11-28T09:00:00.000Z',
    performedBy: 'Petr', schemaVersion: 1, tag: TAG, verdict: 'accepted', ...files.walkthrough,
  };
  const world = createWorld(manifest ?? manifestWithSecrets(), faults);
  const inspected = [];
  let clock = NOW.getTime();
  const run = () =>
    runVerification({
      access: 'maintenance-allowlist',
      appModules,
      artifactManifestPath,
      backupDirectory: path.join(directory, 'backup'),
      configPath,
      fetchImpl: world.fetchImpl,
      inboxPollMs: 1,
      inboxTimeoutMs: 50,
      inspectRelease: (input) => {
        inspected.push(input);
        return RELEASE;
      },
      manifestPath: manifest === null ? undefined : file('manifest.json', manifest),
      migrationEvidencePath: files.rehearsal === null ? undefined : file('rehearsal.json', rehearsal),
      // Every reading advances the clock 10 ms, so the inbox deadline (50 ms) passes after a few polls.
      now: () => new Date((clock += 10)),
      runProcess: world.runProcess,
      sleep: async () => {},
      tag: TAG,
      walkthroughEvidencePath: files.walkthrough === null ? undefined : file('walkthrough.json', walkthrough),
      zeropsToken: 'zerops-token-secret',
      ...options,
    });
  return { configDigest, directory, inspected, run, world };
};

const byId = (evidence) => Object.fromEntries(evidence.checks.map((check) => [check.id, check]));
const failed = (evidence) => evidence.checks.filter((check) => check.status !== 'passed').map((check) => check.id);

test('a healthy stable run passes every required check and binds the tag, commit, config and artifacts', async (t) => {
  const { configDigest, inspected, run, world } = scenario(t);
  const evidence = await run();
  assert.deepEqual(failed(evidence), []);
  assert.deepEqual(evidence.checks.map((check) => check.id), REQUIRED_CHECK_IDS);
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.access, 'maintenance-allowlist');
  assert.deepEqual(inspected.map((input) => input.tag), [TAG]);
  assert.match(evidence.manifestDigest, /^[\da-f]{64}$/u);
  // The identity deploy-evidence.mjs assertReopenEvidence compares against the tag, config and live versions.
  assert.deepEqual(
    [evidence.kind, evidence.schemaVersion, evidence.phase, evidence.tag, evidence.tagObject, evidence.commit, evidence.configDigest, evidence.projectId],
    [EVIDENCE_KIND, 1, 'candidate', TAG, RELEASE.tagObject, COMMIT, configDigest, CONFIG.projectId],
  );
  // The real e-mail went once, to the opted-in control inbox only.
  assert.deepEqual(world.inbox.map((message) => message.To[0].Address), [MANIFEST.controlInbox.address]);
  const serialized = JSON.stringify(evidence);
  for (const secret of [...SECRETS, 'zerops-token-secret']) assert.ok(!serialized.includes(secret), 'evidence leaks a secret');
  assert.ok(!serialized.includes('sid-'), 'evidence leaks a session cookie');
  const mcp = world.processes.find((entry) => entry.args[0] === 'scripts/demo/prove-mcp-oauth.mts');
  assert.deepEqual(mcp.args, ['scripts/demo/prove-mcp-oauth.mts', '--variant=1', '--verification']);
  assert.equal(mcp.env.ONTOS_SHELL_URL, CONFIG.origins.shell);
  assert.equal(mcp.env.E2E_PASSWORD, SECRETS[4]);
  // The proof judges whoami against the stable verification identity, never the canonical CI one.
  assert.deepEqual(
    [mcp.env.E2E_VERIFICATION_PERSONA, mcp.env.E2E_VERIFICATION_PRINCIPAL_ID, mcp.env.E2E_VERIFICATION_LEGAL_ENTITY_ID],
    [MANIFEST.accounts.mcp.email, MANIFEST.accounts.mcp.principalId, MANIFEST.accounts.mcp.legalEntityId],
  );
  assert.equal(mcp.env.STABLE_VERIFICATION_FILE, undefined);
});

test('without the private manifest every journey fails, nothing writes, and the evidence still records it', async (t) => {
  const { run, world } = scenario(t, { manifest: null });
  const evidence = await run();
  const checks = byId(evidence);
  assert.equal(evidence.status, 'failed');
  assert.match(checks['verification-manifest'].failures[0], /STABLE_VERIFICATION_FILE is not set/u);
  for (const id of ['staff-sales-login', 'tenant-switching', 'customer-login', 'erp-synthetic-import', 'control-email', 'mcp-oauth']) {
    assert.equal(checks[id].status, 'failed', id);
    assert.match(checks[id].failures[0], /^not run: the verification manifest/u);
  }
  assert.equal(world.processes.length, 0);
  assert.ok(!world.calls.some((call) => call.includes('/auth/sign-in') || call.includes('/api/ontos/account')));
  // The read-only checks of the build and the public homes still ran.
  for (const id of ['deployed-build', 'storefront-home:storefront', 'storefront-home:shop', 'storefront-home:n1']) {
    assert.equal(checks[id].status, 'passed', id);
  }
});

test('a service running another commit fails deployed-build and no write runs against it', async (t) => {
  const { run, world } = scenario(t, { faults: { staleService: 'n1' } });
  const evidence = await run();
  const checks = byId(evidence);
  assert.deepEqual(checks['deployed-build'].failures, [`n1 runs app version ${'d'.repeat(40)}, not ${COMMIT}`]);
  for (const id of ['erp-synthetic-import', 'control-email', 'mcp-oauth']) assert.match(checks[id].failures[0], /^not run: the stable services/u);
  assert.equal(world.processes.length, 0);
  assert.equal(world.inbox.length, 0);
  assert.equal(checks['staff-sales-login'].status, 'passed');
});

test('authentication and access-denial faults fail their journey with the observed answer', async (t) => {
  const { run } = scenario(t, {
    faults: { deniedTenantListed: true, deniedTenantSwitches: true, staffSignIn: MANIFEST.accounts.staffSales.email },
  });
  const checks = byId(await run());
  assert.deepEqual(checks['staff-sales-login'].failures, ['staff sales sign-in answered 401 InvalidCredentialsProblem']);
  assert.ok(checks['tenant-switching'].failures.includes('the denied tenant is offered'));
  assert.ok(checks['tenant-switching'].failures.some((failure) => failure.startsWith('switching to the denied tenant answered 200')));
  assert.ok(checks['tenant-switching'].failures.includes('the refused switch changed the session tenant'));
});

test('a session that survives sign-out fails: the old cookie must stop working', async (t) => {
  const { run } = scenario(t, { faults: { signOutKeepsSession: true } });
  const checks = byId(await run());
  assert.ok(checks['staff-sales-login'].failures.some((failure) => failure.startsWith('the signed-out session cookie still answers 200')));
});

test('HTTP 200 without the core content fails: an empty storefront home, a composition without the sales modules', async (t) => {
  const { run } = scenario(t, { faults: { emptyStorefront: true, missingModule: true } });
  const checks = byId(await run());
  assert.deepEqual(checks['storefront-home:storefront'].failures, ['storefront home lists no product']);
  assert.deepEqual(checks['staff-sales-login'].failures, ['the composition lacks enabled destinations of demo.sales-pipeline']);
  assert.equal(checks['storefront-home:shop'].status, 'passed');
});

test('an unreachable origin fails only the checks that need it', async (t) => {
  const { run } = scenario(t, { faults: { unreachable: CONFIG.origins.shop } });
  const evidence = await run();
  assert.deepEqual(failed(evidence), ['storefront-home:shop']);
  assert.match(byId(evidence)['storefront-home:shop'].failures[0], /^stopped: TypeError: fetch failed/u);
});

test('a proof that exits 0 but did not prove everything fails: a missing ERP boundary, a failed MCP step', async (t) => {
  const { run } = scenario(t, { faults: { erpPartial: true, mcpWrite: true } });
  const checks = byId(await run());
  assert.deepEqual(checks['erp-synthetic-import'].failures, ['ERP customer-replay was not proven']);
  assert.deepEqual(checks['mcp-oauth'].failures, [
    'MCP zápis = návrh ke schválení: ok',
    'the MCP OAuth proof report is not a pass',
  ]);
});

test('the control e-mail must arrive, from the stable sender', async (t) => {
  const silent = scenario(t, { faults: { noEmail: true } });
  assert.deepEqual(byId(await silent.run())['control-email'].failures, ['no message reached the control inbox within 0 s']);
  const spoofed = scenario(t, { faults: { wrongSender: true } });
  assert.deepEqual(byId(await spoofed.run())['control-email'].failures, [
    'it was sent from spoof@elsewhere.example, not noreply@ontos.example.com',
  ]);
});

test('migration rehearsal and walkthrough are inputs: missing, foreign or rejected records fail', async (t) => {
  const missing = scenario(t, { files: { rehearsal: null, walkthrough: null } });
  const absent = byId(await missing.run());
  assert.deepEqual(absent['migration-rehearsal'].failures, ['no migration rehearsal evidence was given']);
  assert.deepEqual(absent['sales-walkthrough'].failures, ['no sales walkthrough evidence was given']);
  const foreign = scenario(t, {
    files: { rehearsal: { commit: 'e'.repeat(40) }, walkthrough: { verdict: 'rejected' } },
  });
  const checks = byId(await foreign.run());
  assert.deepEqual(checks['migration-rehearsal'].failures, ['stopped: DataError: rehearsal is for another candidate']);
  assert.deepEqual(checks['sales-walkthrough'].failures, ['the walkthrough verdict is "rejected", not "accepted"']);
  const failedMigrator = scenario(t, { files: { rehearsal: { migratorExitCode: 1, verdict: 'failed' } } });
  assert.deepEqual(byId(await failedMigrator.run())['migration-rehearsal'].failures, ['stopped: DataError: rehearsal did not pass']);
});

test('artifacts of another release cannot be bound', async (t) => {
  const { run } = scenario(t, { files: { artifacts: { commit: 'e'.repeat(40) } } });
  await assert.rejects(run(), /the artifact manifest commit is e{40}, not c{40}/u);
});

test('the manifest is strict and every write needs its exact opt-in', () => {
  const valid = () => manifestWithSecrets();
  assert.doesNotThrow(() => validateVerificationManifest(MANIFEST, CONFIG, appModules));
  const reject = (mutate, pattern) => {
    const manifest = valid();
    mutate(manifest);
    assert.throws(() => validateVerificationManifest(manifest, CONFIG, appModules), pattern);
  };
  reject((m) => {
    m.extra = true;
  }, /\(root\) has unknown keys extra/u);
  reject((m) => {
    m.mutations = m.mutations.filter((entry) => entry.id !== 'control-email');
  }, /mutations must opt in to control-email/u);
  reject((m) => {
    m.mutations[0].tenantId = '00000000-0000-4000-8000-000000000001';
  }, /mutations\[0\]\.tenantId must name the exact erp-synthetic-import target/u);
  reject((m) => {
    m.erp.legalEntityId = CONFIG.variables.storefront.ONTOS_STOREFRONT_LEGAL_ENTITY_ID;
  }, /erp\.legalEntityId must be a dedicated verification company/u);
  reject((m) => {
    m.controlInbox.address = 'qa@verify.test';
    m.accounts.customer.email = 'qa@verify.test';
  }, /controlInbox\.address is a test recipient/u);
  reject((m) => {
    m.accounts.customer.email = 'someone@ontos.example.com';
  }, /accounts\.customer\.email must equal controlInbox\.address/u);
  reject((m) => {
    delete m.accounts.mcp.principalId;
  }, /accounts\.mcp is missing principalId/u);
  reject((m) => {
    m.mutations[2].account = 'verification@ci.ontos';
  }, /mutations\[2\]\.account must name the exact mcp-task-proposal target/u);
  reject((m) => {
    delete m.accounts.tenantSwitcher.deniedTenantId;
  }, /accounts\.tenantSwitcher is missing deniedTenantId/u);
  reject((m) => {
    m.projectId = CONFIG.demoProjectId;
  }, /projectId must equal the stable config projectId/u);
});

test('the CLI takes no caller revision and requires the binding inputs and an explicit access mode', () => {
  const base = ['--config', 'c.json', '--output', 'e.json', '--tag', TAG, '--artifact-manifest', 'a/manifest.json'];
  assert.equal(parseCli([...base, '--access', 'public']).phase, 'candidate');
  assert.throws(() => parseCli(base), /usage:/u);
  assert.throws(() => parseCli([...base, '--access', 'open']), /usage:/u);
  assert.throws(() => parseCli([...base, '--access', 'public', '--revision', COMMIT]), /Unknown option '--revision'/u);
  assert.throws(() => parseCli([...base, '--access', 'public', '--phase', 'preview']), /usage:/u);
});
