import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAccountsFile,
  loadCatalog,
  main,
  makeShellIdentityClient,
  parseBootstrapSpec,
  parseCredentials,
  sessionCookieHeader,
  storefrontServiceVariables,
} from './bootstrap.mjs';
import { loadDemoIdentities } from './provision.mjs';

const catalog = loadCatalog();
const demoIdentities = loadDemoIdentities();
const example = () => {
  const spec = JSON.parse(readFileSync(fileURLToPath(new URL('bootstrap-spec.example.json', import.meta.url)), 'utf8'));
  spec.tenants[1].accounts[0].email = 'owner@akros.example';
  spec.tenants[2].accounts[0].email = 'owner@n1.example';
  return spec;
};
const emails = ['obchod@sroubshop.example', 'prodej@sroubshop.example', 'owner@akros.example', 'owner@n1.example'];
const credentials = { passwords: Object.fromEntries(emails.map((email) => [email, `pw-${email}`])), schemaVersion: 1 };
const readExample = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'));
/** The stable config of config.mjs's example: project STABLEproject000000000. */
const stableConfig = readExample('example.config.json');
const provisionSpec = readExample('provision-spec.example.json');

const workspace = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-stable-bootstrap-'));
  const write = (name, value, mode = 0o600) => {
    const file = path.join(directory, name);
    writeFileSync(file, JSON.stringify(value));
    chmodSync(file, mode);
    return file;
  };
  return {
    credentials: write('credentials.json', credentials),
    directory,
    provision: write('provision-spec.json', provisionSpec, 0o644),
    spec: write('spec.json', example(), 0o644),
    stable: write('stable.json', stableConfig, 0o644),
    write,
  };
};
const quiet = () => undefined;

test('the accounts file is new, owner-only, and keeps its IDs on a rerun', async () => {
  const files = workspace();
  const output = path.join(files.directory, 'accounts.json');
  const variablesOutput = path.join(files.directory, 'storefront-variables.json');
  const argv = [
    'accounts',
    '--provision-spec',
    files.provision,
    '--spec',
    files.spec,
    '--credentials',
    files.credentials,
    '--output',
    output,
    '--variables-output',
    variablesOutput,
  ];
  const first = await main(argv, { log: quiet });
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(first.schemaVersion, 2);
  assert.deepEqual(
    first.tenants.map(({ slug }) => slug),
    ['sroubshop', 'akros', 'n1'],
  );
  const ids = JSON.stringify(first).match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gu);
  assert.equal(new Set(ids).size, ids.length, 'every ID is distinct');
  assert.ok(
    ids.every((id) => !demoIdentities.has(id)),
    'no demo identity',
  );
  assert.equal(first.tenants[0].accounts[0].password, 'pw-obchod@sroubshop.example');
  const variables = JSON.parse(readFileSync(variablesOutput, 'utf8'));
  assert.equal(variables.shop.ONTOS_STOREFRONT_LEGAL_ENTITY_ID, first.tenants[0].legalEntity.legalEntityId);
  const second = await main(argv, { log: quiet });
  assert.deepEqual(second, first, 'a rerun keeps every ID and value');
  assert.deepEqual(JSON.parse(readFileSync(variablesOutput, 'utf8')), variables);
});

test('a new account joins an existing tenant without changing the tenant IDs', () => {
  const spec = parseBootstrapSpec(example(), catalog);
  const passwords = parseCredentials(credentials, spec);
  const first = buildAccountsFile(spec, passwords, undefined, { demoIdentities });
  const grown = example();
  grown.tenants[1].accounts.push({ displayName: 'Nákup', email: 'nakup@akros.example', owner: false, roles: [] });
  const grownSpec = parseBootstrapSpec(grown, catalog);
  const grownPasswords = parseCredentials(
    { ...credentials, passwords: { ...credentials.passwords, 'nakup@akros.example': 'long-enough' } },
    grownSpec,
  );
  const second = buildAccountsFile(grownSpec, grownPasswords, first, { demoIdentities });
  assert.equal(second.tenants[1].tenantId, first.tenants[1].tenantId);
  assert.deepEqual(second.tenants[1].accounts[0], first.tenants[1].accounts[0]);
  assert.equal(second.tenants[1].accounts.length, 2);
});

test('refusals: demo identities, demo logins, dropped tenants, loose credentials and undeclared workloads', async () => {
  const spec = parseBootstrapSpec(example(), catalog);
  const passwords = parseCredentials(credentials, spec);
  const first = buildAccountsFile(spec, passwords, undefined, { demoIdentities });
  const [demoId] = [...demoIdentities];
  const copied = structuredClone(first);
  copied.tenants[0].tenantId = demoId;
  assert.throws(() => buildAccountsFile(spec, passwords, copied, { demoIdentities }), /demo identity/u);
  const shrunk = parseBootstrapSpec({ ...example(), tenants: example().tenants.slice(0, 2) }, catalog);
  const { 'owner@n1.example': _n1, ...kept } = credentials.passwords;
  const shrunkPasswords = parseCredentials({ passwords: kept, schemaVersion: 1 }, shrunk);
  assert.throws(() => buildAccountsFile(shrunk, shrunkPasswords, first, { demoIdentities }), /dropped: n1/u);
  const demoLogin = example();
  demoLogin.tenants[0].accounts[0].email = 'obchod@demo.ontos';
  assert.throws(() => parseBootstrapSpec(demoLogin, catalog), /demo fixture login/u);
  const undeclared = example();
  undeclared.tenants[0].storefronts[0].workloadKeys = ['made.up-workload'];
  assert.throws(() => parseBootstrapSpec(undeclared, catalog), /not declared/u);
  const twoOwners = example();
  twoOwners.tenants[0].accounts[1].owner = true;
  assert.throws(() => parseBootstrapSpec(twoOwners, catalog), /exactly one owner/u);
  assert.throws(
    () => parseCredentials({ ...credentials, passwords: { 'owner@n1.example': 'short' } }, spec),
    /password/u,
  );
  const files = workspace();
  chmodSync(files.credentials, 0o644);
  const output = path.join(files.directory, 'accounts.json');
  const run = (provision) =>
    main(
      [
        'accounts',
        '--provision-spec',
        provision,
        '--spec',
        files.spec,
        '--credentials',
        files.credentials,
        '--output',
        output,
        '--variables-output',
        `${output}.variables`,
      ],
      { log: quiet },
    );
  await assert.rejects(run(files.provision), /chmod 600/u);
  chmodSync(files.credentials, 0o600);
  const demoOrigins = {
    ...provisionSpec,
    origins: { ...provisionSpec.origins, shell: 'https://ontos-stage.web-revolution.cz' },
  };
  await assert.rejects(run(files.write('demo.json', demoOrigins, 0o644)), /demo stage host/u);
  const keysFiles = workspace();
  const demoStable = keysFiles.write(
    'demo-stable.json',
    { ...stableConfig, projectId: stableConfig.demoProjectId },
    0o644,
  );
  await assert.rejects(
    main(
      [
        'storefront-keys',
        '--stable-config',
        demoStable,
        '--spec',
        keysFiles.spec,
        '--credentials',
        keysFiles.credentials,
        '--accounts',
        output,
        '--keys-dir',
        keysFiles.directory,
      ],
      { log: quiet },
    ),
    /demo project/u,
  );
});

test('storefront service variables name each storefront company, and N1 its tenant', () => {
  const spec = parseBootstrapSpec(example(), catalog);
  const accounts = buildAccountsFile(spec, parseCredentials(credentials, spec), undefined, { demoIdentities });
  const variables = storefrontServiceVariables(spec, accounts);
  assert.deepEqual(variables.shop, {
    ONTOS_STOREFRONT_APP_ID: 'sroubshop-storefront',
    ONTOS_STOREFRONT_LEGAL_ENTITY_ID: accounts.tenants[0].legalEntity.legalEntityId,
    STOREFRONT_BRAND: 'sroubshop',
  });
  assert.equal(variables.n1.ONTOS_STOREFRONT_TENANT_ID, accounts.tenants[2].tenantId);
});

/** A Shell identity API double: managed principals per owner session, keys issued once. */
const fakeShell = () => {
  const principals = new Map();
  const calls = [];
  let next = 0;
  const client = {
    createServicePrincipal: async (cookie, displayName) => {
      calls.push(['create', displayName]);
      const principalId = `00000000-0000-4000-8000-${String((next += 1)).padStart(12, '0')}`;
      principals.set(displayName, { displayName, key: null, kind: 'service', principalId, principalStatus: 'active' });
      return principalId;
    },
    issueManagedKey: async (cookie, principalId, name) => {
      calls.push(['issue', name]);
      principals.get(name).key = { bindingStatus: 'active' };
      return `secret-${name}`;
    },
    listManaged: async () => [...principals.values()],
    signIn: async (email, password) => {
      assert.equal(password, `pw-${email}`);
      calls.push(['signIn', email]);
      return 'session';
    },
  };
  return { calls, client, principals };
};

test('storefront keys are issued natively once, stored owner-only, and a rerun issues nothing', async () => {
  const files = workspace();
  const accounts = path.join(files.directory, 'accounts.json');
  await main(
    [
      'accounts',
      '--provision-spec',
      files.provision,
      '--spec',
      files.spec,
      '--credentials',
      files.credentials,
      '--output',
      accounts,
      '--variables-output',
      `${accounts}.variables`,
    ],
    { log: quiet },
  );
  const keysDir = path.join(files.directory, 'keys');
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(keysDir, { mode: 0o700 }));
  const shell = fakeShell();
  const argv = [
    'storefront-keys',
    '--stable-config',
    files.stable,
    '--spec',
    files.spec,
    '--credentials',
    files.credentials,
    '--accounts',
    accounts,
    '--keys-dir',
    keysDir,
  ];
  await main(argv, { client: shell.client, log: quiet });
  assert.ok(
    shell.calls.every(([kind]) => kind === 'signIn'),
    'the dry run only reads',
  );
  const registrations = await main([...argv, '--apply'], { client: shell.client, log: quiet });
  const keyFile = path.join(keysDir, 'STABLEproject000000000-sroubshop-storefront.key');
  assert.equal(readFileSync(keyFile, 'utf8'), 'secret-sroubshop-storefront');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(registrations.tenants[0].workloads.length, 3);
  assert.ok(existsSync(path.join(keysDir, 'STABLEproject000000000-workload-registrations.json')));
  const issued = shell.calls.filter(([kind]) => kind === 'issue').length;
  await main([...argv, '--apply'], { client: shell.client, log: quiet });
  assert.equal(shell.calls.filter(([kind]) => kind === 'issue').length, issued, 'a rerun issues no key');
  await import('node:fs').then(({ rmSync }) => rmSync(keyFile));
  await assert.rejects(main([...argv, '--apply'], { client: shell.client, log: quiet }), /rotate it deliberately/u);
});

test('the Shell client calls the native identity endpoints with the session cookie and its alias', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({
        body: JSON.parse(body),
        cookie: request.headers.cookie,
        origin: request.headers.origin,
        url: request.url,
      });
      response.setHeader('content-type', 'application/json');
      if (request.url.endsWith('/sign-in')) {
        response.setHeader('set-cookie', ['__Secure-better-auth.session_token=abc; Path=/; HttpOnly; Secure']);
        response.end('{}');
      } else if (request.url.endsWith('/managed/list')) {
        response.end(JSON.stringify({ items: [], nextOffset: null }));
      } else if (request.url.endsWith('/principals')) {
        response.end(JSON.stringify({ principalId: 'p-1', status: 'active' }));
      } else {
        response.end(JSON.stringify({ secret: 'k-1' }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = makeShellIdentityClient({ origin });
    const cookie = await client.signIn('owner@n1.example', 'pw');
    assert.equal(cookie, '__Secure-better-auth.session_token=abc; better-auth.session_token=abc');
    assert.deepEqual(await client.listManaged(cookie), []);
    assert.equal(await client.createServicePrincipal(cookie, 'n1-storefront', 'idem'), 'p-1');
    assert.equal(await client.issueManagedKey(cookie, 'p-1', 'n1-storefront'), 'k-1');
  } finally {
    server.close();
  }
  assert.deepEqual(
    seen.map(({ url }) => url),
    [
      '/shell-super-app-api/auth/sign-in',
      '/shell-super-app-api/auth/identity/api-keys/managed/list',
      '/shell-super-app-api/auth/identity/principals',
      '/shell-super-app-api/auth/identity/api-keys/managed',
    ],
  );
  assert.deepEqual(seen[2].body, { displayName: 'n1-storefront', kind: 'service' });
  assert.deepEqual(seen[3].body, { name: 'n1-storefront', principalId: 'p-1', scope: 'tenant-managed' });
  assert.ok(seen.every(({ origin: sent }) => sent === origin));
  assert.equal(sessionCookieHeader(['a=1; Path=/']), 'a=1');
});
