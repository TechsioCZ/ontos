#!/usr/bin/env node
// The first install of a stable project, as GitHub Actions runs it around the app's first deploy.
//
//   ZEROPS_TOKEN=… STABLE_BOOTSTRAP_JSON=… STAGE_SMTP_PASSWORD=… \
//     node ops/zerops-stable/gha-bootstrap.mjs before-app --config STABLE.json --tag TAG [--apply]
//   ZEROPS_TOKEN=… STABLE_BOOTSTRAP_JSON=… \
//     node ops/zerops-stable/gha-bootstrap.mjs after-app --config STABLE.json --tag TAG [--apply]
//
// Without --apply each phase only reads and prints what it would do. The runner must be on the project's VPN
// (database and `ssh app`). The app workspace must be installed and checked out cleanly at TAG.
//
// before-app (no app deployed yet): stores the bundle's service secrets plus app SMTP_PASSWORD (secrets.mjs; owner
//   JSON merged, a changed existing value refused), then initialize.mjs: database roles, project marker, SpiceDB
//   database and the spicedb deploy. Once any workload is deployed, initialize is first-install only and is skipped.
// after-app (app ACTIVE, Shell origin routed): on the app container over `ssh app`, the native accounts bootstrap
//   (bootstrap-stage-accounts.mts: dry run, commit, verify) and each tenant's modules (activate-tenant-modules.mts).
//   Then each storefront's service principal and managed key through the public Shell (bootstrap.mjs), each new key
//   straight into its service's Zerops secret, each storefront tenant's Commerce portal principal and key (merged into
//   the app's owner secrets as COMMERCE_TENANT_CREDENTIALS with the portal identity deployment, then an app restart),
//   the workload registrations of both (register-stage-workloads.mts),
//   each selling tenant's VAT baseline (seed-tax-baseline.mts) and the synthetic sales data of the tenants the bundle
//   names in `salesData`: storefront registration, market, association, market settings and products, all through
//   native Actions over the public Shell.
//
// STABLE_BOOTSTRAP_JSON (a private GitHub secret; parsed here, never printed or written):
//   { "schemaVersion": 1, "kind": "ontos.stable.bootstrap", "projectId": "<stable project>",
//     "databaseAdminUrl": "postgresql://<db18 superUser>:<password>@db18:5432/<db18 dbName>",
//     "secrets": <secrets.mjs bundle>, "spec": <bootstrap spec>, "accounts": <bootstrap.mjs accounts file>,
//     "modules": { "<tenant slug>": ["<module key>", …] }, "salesData": ["<tenant slug>"] }
// `modules` and `salesData` are optional: an absent tenant gets no module activation and no sales data.
// Secrets travel only on stdin (ssh, child processes) and in request bodies. Storefront keys go from the Shell's answer
// to the Zerops secret store; a rerun reads them back from there.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  ensureStorefrontKeys,
  loadCatalog,
  makeShellIdentityClient,
  parseBootstrapSpec,
  STOREFRONT_KEY_VARIABLES,
  storefrontServiceVariables,
} from './bootstrap.mjs';
import { loadStableConfig } from './config.mjs';
import {
  APP_ROOT,
  initialize,
  LATER_WORKLOADS,
  liveDependencies,
  NEVER_DEPLOYED,
  parseAdminUrl,
} from './initialize.mjs';
import { assertProjectServices, createZeropsClient } from './maintenance.mjs';
import { createSecretStore } from './secret-store.mjs';
import { applySecrets, validateSecretBundle } from './secrets.mjs';

export const BUNDLE_KIND = 'ontos.stable.bootstrap';
/** Where the release archive unpacks on the app container (app/zerops.yaml start: `cd app && …`). */
export const REMOTE_APP_ROOT = '/var/www/app';
/** The app host's loopback composition (scripts/zerops/app-host.mts CONTROL_PORT, COMPOSITION_PATH). */
export const REMOTE_COMPOSITION_URL = 'http://127.0.0.1:3001/_host/composition';
const ACCOUNT_KEYS = ['retiredAccountEmails', 'retiredTenants', 'schemaVersion', 'tenants'];

export class BootstrapRunError extends Error {
  name = 'BootstrapRunError';
}
const fail = (message) => {
  throw new BootstrapRunError(message);
};
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses STABLE_BOOTSTRAP_JSON against the stable config. Errors name fields, never values. Returns the parts each
 * phase uses, with every account password keyed by email.
 */
export const parseBootstrapBundle = (text, { catalog, config }) => {
  if (typeof text !== 'string' || text.length === 0) fail('STABLE_BOOTSTRAP_JSON is required');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('STABLE_BOOTSTRAP_JSON is not JSON');
  }
  if (!isRecord(value)) fail('STABLE_BOOTSTRAP_JSON must be an object');
  const allowed = ['schemaVersion', 'kind', 'projectId', 'databaseAdminUrl', 'secrets', 'spec', 'accounts', 'modules', 'salesData'];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`STABLE_BOOTSTRAP_JSON has unknown keys ${unknown.join(', ')}`);
  if (value.schemaVersion !== 1 || value.kind !== BUNDLE_KIND) fail(`STABLE_BOOTSTRAP_JSON must be schemaVersion 1 of kind ${BUNDLE_KIND}`);
  if (value.projectId !== config.projectId) fail('STABLE_BOOTSTRAP_JSON names another project than the stable config');
  parseAdminUrl(value.databaseAdminUrl);
  try {
    validateSecretBundle(value.secrets, config);
  } catch (error) {
    fail(`STABLE_BOOTSTRAP_JSON secrets: ${error.message}`);
  }
  const spec = parseBootstrapSpec(value.spec, catalog);
  const accounts = value.accounts;
  if (!isRecord(accounts) || accounts.schemaVersion !== 2 || !Array.isArray(accounts.tenants)) {
    fail('STABLE_BOOTSTRAP_JSON accounts must be the schemaVersion 2 accounts file');
  }
  if (Object.keys(accounts).some((key) => !ACCOUNT_KEYS.includes(key))) fail('STABLE_BOOTSTRAP_JSON accounts has unknown keys');
  const passwords = new Map();
  for (const tenant of spec.tenants) {
    const written = accounts.tenants.filter(({ slug }) => slug === tenant.slug);
    if (written.length !== 1) fail(`STABLE_BOOTSTRAP_JSON accounts must hold tenant ${tenant.slug} once`);
    for (const { email } of tenant.accounts) {
      const account = written[0].accounts?.filter((entry) => entry.email?.toLowerCase() === email) ?? [];
      if (account.length !== 1 || typeof account[0].password !== 'string' || account[0].password.length < 8) {
        fail(`STABLE_BOOTSTRAP_JSON accounts need ${email} once, with its password`);
      }
      passwords.set(email, account[0].password);
    }
  }
  if (accounts.tenants.length !== spec.tenants.length) fail('STABLE_BOOTSTRAP_JSON accounts hold tenants the spec does not');
  // The config's storefront identities are the ones these accounts create.
  const derived = storefrontServiceVariables(spec, accounts);
  for (const [service, variables] of Object.entries(derived)) {
    for (const [key, expected] of Object.entries(variables)) {
      if (config.variables[service]?.[key] !== expected) fail(`stable config variables.${service}.${key} is not the bundle's`);
    }
  }
  const slugs = spec.tenants.map(({ slug }) => slug);
  const modules = value.modules ?? {};
  if (!isRecord(modules)) fail('STABLE_BOOTSTRAP_JSON modules must map tenant slugs to module keys');
  for (const [slug, keys] of Object.entries(modules)) {
    if (!slugs.includes(slug)) fail(`STABLE_BOOTSTRAP_JSON modules names unknown tenant ${slug}`);
    if (!Array.isArray(keys) || keys.length === 0 || new Set(keys).size !== keys.length) {
      fail(`STABLE_BOOTSTRAP_JSON modules.${slug} must be a non-empty list of unique module keys`);
    }
    const unshipped = keys.filter((key) => !catalog.moduleIds.has(key));
    if (unshipped.length > 0) fail(`STABLE_BOOTSTRAP_JSON modules.${slug} names modules the catalog does not ship: ${unshipped.join(', ')}`);
  }
  const salesData = value.salesData ?? [];
  if (!Array.isArray(salesData) || salesData.some((slug) => !slugs.includes(slug)) || new Set(salesData).size !== salesData.length) {
    fail('STABLE_BOOTSTRAP_JSON salesData must list unique tenant slugs');
  }
  for (const slug of salesData) {
    const tenant = spec.tenants.find((entry) => entry.slug === slug);
    if (tenant.storefronts.length !== 1) fail(`salesData tenant ${slug} needs exactly one storefront`);
    if (!(modules[slug] ?? []).includes('demo.merchandise')) fail(`salesData tenant ${slug} needs demo.merchandise in its modules`);
  }
  return { accounts, adminUrl: value.databaseAdminUrl, modules, passwords, salesData, secrets: value.secrets, spec };
};

/** The secret bundle before-app stores: the bundle's own, and the app's SMTP password from the environment. */
export const withSmtpPassword = (secrets, smtpPassword) => {
  if (typeof smtpPassword !== 'string' || smtpPassword.length === 0) fail('STAGE_SMTP_PASSWORD is required');
  return { ...secrets, services: { ...secrets.services, app: { ...secrets.services.app, SMTP_PASSWORD: smtpPassword } } };
};

export const beforeApp = async ({ apply, bundle, config, deps, log, smtpPassword, tag }) => {
  const secrets = withSmtpPassword(bundle.secrets, smtpPassword);
  const services = await deps.assertServices(config);
  const stored = await deps.applySecrets({ apply, bundle: secrets, config });
  for (const { action, key, service } of stored.changes) log(`secret ${service}.${key}: ${action}`);
  const deployed = LATER_WORKLOADS.filter((name) => services[name].status !== NEVER_DEPLOYED);
  if (deployed.length > 0) {
    log(`initialize skipped: ${deployed.join(', ')} already deployed (first install only)`);
    return { initialized: false, secrets: stored.changes };
  }
  if (!apply && stored.changes.some(({ action }) => action !== 'unchanged')) {
    log('initialize is planned after the secrets are stored; rerun with --apply');
    return { initialized: false, secrets: stored.changes };
  }
  const result = await deps.initialize({ adminUrl: bundle.adminUrl, apply, bundle: secrets, config, log, tag });
  return { initialized: result.applied, plan: result.plan, secrets: stored.changes };
};

const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const quoted = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/**
 * The app container's Shell runtime, as the app host derives it for its children (scripts/zerops/app-host.mts
 * derivedEnvironment): the public origin, the Shell's auth secret from the owner secrets and the loopback composition.
 */
export const REMOTE_PREAMBLE = [
  'set -eu',
  'umask 077',
  `cd ${REMOTE_APP_ROOT}`,
  'export NODE_ENV=production ULTRAMODERN_DEPLOYMENT_ENVIRONMENT=stage',
  'export BETTER_AUTH_URL="$ONTOS_PUBLIC_ORIGIN" BETTER_AUTH_TRUSTED_ORIGINS="$ONTOS_PUBLIC_ORIGIN" ONTOS_PUBLIC_URL="$ONTOS_PUBLIC_ORIGIN"',
  'export ONTOS_GATEWAY_ISSUER="$ONTOS_PUBLIC_ORIGIN" ONTOS_OAUTH_ISSUER="$ONTOS_PUBLIC_ORIGIN/shell-super-app-api/oauth"',
  `export ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL=${REMOTE_COMPOSITION_URL}`,
  `BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(JSON.parse(process.env.ONTOS_OWNER_SECRETS_JSON)["shell-super-app"].BETTER_AUTH_SECRET)')"`,
  'export BETTER_AUTH_SECRET',
  'private="$(mktemp -d /tmp/ontos-stable-bootstrap.XXXXXX)"',
  'trap \'rm -rf "$private"\' EXIT',
];

/** Writes `text` to a private file on the container from inside the script; the content never reaches an argument. */
const remoteFile = (name, text) => `printf %s ${quoted(base64(text))} | base64 -d >"$private/${name}"`;

/** The native accounts bootstrap: dry run, then (apply) commit and the verifying dry run. */
export const accountsScript = (accounts, apply) =>
  [
    ...REMOTE_PREAMBLE,
    remoteFile('accounts.json', JSON.stringify(accounts)),
    'cd apps/shell-super-app',
    'export ONTOS_STAGE_ACCOUNTS_FILE="$private/accounts.json"',
    'node scripts/bootstrap-stage-accounts.mts',
    ...(apply ? ['node scripts/bootstrap-stage-accounts.mts --commit', 'node scripts/bootstrap-stage-accounts.mts'] : []),
  ].join('\n');

/** One tenant's module activation as its owner (activate-tenant-modules.mts). */
export const modulesScript = ({ email, moduleKeys, password, tenantId }, apply) =>
  [
    ...REMOTE_PREAMBLE,
    `export ONTOS_AGENT_SETUP_EMAIL=${quoted(email)}`,
    `ONTOS_AGENT_SETUP_PASSWORD="$(printf %s ${quoted(base64(password))} | base64 -d)"`,
    'export ONTOS_AGENT_SETUP_PASSWORD',
    `node scripts/activate-tenant-modules.mts --tenant-id ${tenantId} --modules ${moduleKeys.join(',')} --mode ${apply ? 'apply' : 'plan'}`,
  ].join('\n');

/** The storefront workload registrations: dry run, apply with its own fingerprint, verify. */
export const workloadsScript = (registrations, apply) =>
  [
    ...REMOTE_PREAMBLE,
    remoteFile('workloads.json', JSON.stringify(registrations)),
    'node scripts/demo/register-stage-workloads.mts --registrations "$private/workloads.json" --mode dry-run | tee "$private/plan.txt"',
    ...(apply
      ? [
          `fingerprint="$(sed -n "s/.*fingerprint: '\\([0-9a-f]\\{64\\}\\)'.*/\\1/p" "$private/plan.txt")"`,
          'test -n "$fingerprint" || { echo "register-stage-workloads printed no plan fingerprint" >&2; exit 1; }',
          'node scripts/demo/register-stage-workloads.mts --registrations "$private/workloads.json" --mode apply --reviewed-plan-sha256 "$fingerprint"',
          'node scripts/demo/register-stage-workloads.mts --registrations "$private/workloads.json" --mode verify',
        ]
      : []),
  ].join('\n');

/** `ssh app` over the project VPN; the script (with its secrets) is ssh's stdin, its output goes to this stderr. */
export const runRemote = (script, { run = spawnSync } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-stable-ssh-'));
  try {
    const result = run(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${path.join(directory, 'known_hosts')}`,
        '-o', 'ConnectTimeout=30',
        '-o', 'ServerAliveInterval=30',
        'app',
        'bash -l -s',
      ],
      { encoding: 'utf8', input: script, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 2, 2] },
    );
    if (result.error || result.status !== 0) fail('a step on the app container failed (its output is above)');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

/**
 * Storefront keys through the Shell, kept in Zerops: a key the service already holds is written to the private keys
 * directory first, so bootstrap.mjs reuses its principal and key; a newly issued key goes straight to the service.
 */
export const ensureStorefrontSecrets = async ({ apply, bundle, config, keysDir, log, shellClient, store }) => {
  const storefronts = bundle.spec.tenants.flatMap(({ storefronts }) => storefronts);
  const keyFile = (storefront) => path.join(keysDir, `${config.projectId}-${storefront.storefrontAppId}.key`);
  const held = new Map();
  for (const storefront of storefronts) {
    const variable = STOREFRONT_KEY_VARIABLES[storefront.service];
    const entries = (await store.list(config.services[storefront.service])).filter(({ key }) => key === variable);
    if (entries.length > 1) fail(`${storefront.service} holds ${variable} twice; resolve it explicitly`);
    if (entries.length === 1) {
      writeFileSync(keyFile(storefront), entries[0].content, { flag: 'wx', mode: 0o600 });
      held.set(storefront.storefrontAppId, true);
    }
  }
  const registrations = await ensureStorefrontKeys({
    accountsFile: bundle.accounts,
    apply,
    client: shellClient,
    keysDir,
    log,
    passwords: bundle.passwords,
    spec: bundle.spec,
    stable: config,
  });
  for (const storefront of storefronts) {
    if (held.get(storefront.storefrontAppId) || !existsSync(keyFile(storefront))) continue;
    const variable = STOREFRONT_KEY_VARIABLES[storefront.service];
    await store.create(config.services[storefront.service], variable, readFileSync(keyFile(storefront), 'utf8'));
    log(`stored ${storefront.service}.${variable} (value withheld)`);
  }
  return registrations;
};

/** seed-tax-baseline.mts --json, run in the app workspace as the tenant's owner; returns its parsed run. */
export const runTaxBaseline = ({ email, mode, password, reviewed, shellUrl, tenantId }, { run = spawnSync } = {}) => {
  const args = ['scripts/demo/seed-tax-baseline.mts', '--mode', mode, '--json', '--wait-seconds', '600'];
  if (mode !== 'dry-run') args.push('--companies-expected', '1');
  if (reviewed !== undefined) args.push('--reviewed-plan-sha256', reviewed);
  const result = run(process.execPath, args, {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: {
      ONTOS_DEMO_SEED_EMAIL: email,
      ONTOS_DEMO_SEED_PASSWORD: password,
      ONTOS_DEMO_SEED_TENANT_ID: tenantId,
      ONTOS_DEMO_SEED_URL: shellUrl,
      PATH: process.env.PATH,
    },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 2],
  });
  if (result.error || result.status !== 0) fail(`VAT baseline ${mode} failed for tenant ${tenantId}`);
  const line = result.stdout.trim().split('\n').findLast((entry) => entry.startsWith('{'));
  try {
    return JSON.parse(line ?? result.stdout);
  } catch {
    return fail(`VAT baseline ${mode} printed no JSON result`);
  }
};

/** A stable UUID (version 8 layout) for a seeded record, from its tenant and key; reruns address the same record. */
export const seededId = (tenantId, key) => {
  const hex = createHash('sha256').update(`ontos.stable.sales-data:${tenantId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The synthetic ŠroubShop range: fictional fasteners, net CZK prices, nothing taken from a customer. */
export const SALES_PRODUCTS = Object.freeze([
  ['SROUB-M6-20', 'Šroub s šestihrannou hlavou M6×20, pozinkovaný', 'Šrouby › Metrické', 290],
  ['SROUB-M8-30', 'Šroub s šestihrannou hlavou M8×30, pozinkovaný', 'Šrouby › Metrické', 450],
  ['SROUB-M10-40', 'Šroub s šestihrannou hlavou M10×40, nerez A2', 'Šrouby › Metrické', 1290],
  ['VRUT-4X40', 'Vrut do dřeva 4×40, žlutý zinek', 'Vruty › Do dřeva', 120],
  ['VRUT-5X60', 'Vrut do dřeva 5×60, žlutý zinek', 'Vruty › Do dřeva', 190],
  ['MATICE-M8', 'Matice šestihranná M8, pozinkovaná', 'Matice › Šestihranné', 90],
  ['PODLOZKA-M8', 'Podložka plochá M8, pozinkovaná', 'Podložky › Ploché', 40],
  ['HMOZDINKA-8', 'Hmoždinka nylonová 8×40', 'Kotvení › Hmoždinky', 60],
].map(([sku, name, category, priceMinor]) => Object.freeze({ category, name, priceMinor, sku })));

/**
 * Runs in the app workspace (its schemas and seed client): the sales data of one tenant over the public Shell, as its
 * owner, with only governed reads and Actions. stdin: JSON input with the password; stdout: one JSON report line.
 * Each step reads first and writes only what is missing, so a rerun changes nothing.
 */
export const SALES_DATA_LAUNCHER = `
import { Cause, DateTime, Duration, Effect, Exit, Redacted, Schedule, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { connectSeedClient, DemoSeedError, ownerAction } from './scripts/demo/seed-client.mts';
import { AssociateStorefrontPayloadSchema, CreateMarketPayloadSchema, CreateMarketResultSchema, StorefrontAssociationResultSchema } from './verticals/commerce-market-catalog/shared/action-contracts.ts';
import { CurrentMarketCatalogRequestSchema, CurrentMarketCatalogResponseSchema } from './verticals/commerce-market-catalog/shared/apis/current-market-catalog.ts';
import { ApplyCommandPayloadSchema, ApplyCommandResultSchema } from './verticals/merchandise/shared/actions/apply-command.ts';
import { ManageMarketsPayloadSchema } from './verticals/merchandise/shared/actions/manage-markets.ts';
import { RecordsRequestSchema, RecordsResponseSchema } from './verticals/merchandise/shared/apis/records.ts';
import { RegisterStorefrontApplicationPayloadSchema, RegisterStorefrontApplicationResultSchema } from './verticals/storefront-registry/shared/actions/register-storefront-application.ts';
import { StorefrontApplicationsRequestSchema, StorefrontApplicationsResponseSchema } from './verticals/storefront-registry/shared/apis/storefront-applications.ts';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const enc = Schema.toEncoded;
const effectiveFrom = '2026-01-01T00:00:00.000Z';
const provenance = { kind: 'CONFIGURATION_ACTION', reference: 'ontos-stable-sales-data:v1' };
const sellerRef = { moduleId: 'core.identity', resourceId: input.legalEntityId, resourceType: 'core.identity.legal-entity', tenantId: input.tenantId };
const marketRef = { moduleId: 'commerce.market-catalog', resourceId: input.marketId, resourceType: 'commerce.market-catalog.market', tenantId: input.tenantId };
const manageMarkets = ownerAction('manage-markets', enc(ManageMarketsPayloadSchema));
const report = [];
const program = Effect.gen(function* () {
  const client = yield* Effect.acquireRelease(
    connectSeedClient({ legalEntityId: input.legalEntityId, shellUrl: input.shellUrl, tenantId: input.tenantId }, input.email, Redacted.make(input.password)),
    (session) => session.signOut.pipe(Effect.ignore),
  );
  const now = DateTime.formatIso(yield* DateTime.now);
  const records = (view) => client.call('merchandise', '/reads/records', enc(RecordsRequestSchema), { view }, enc(RecordsResponseSchema));
  const catalog = () => client.call('commerce-market-catalog', '/reads/current-market-catalog', enc(CurrentMarketCatalogRequestSchema), { at: now }, enc(CurrentMarketCatalogResponseSchema));
  const { applications } = yield* client.call('storefront-registry', '/reads/storefront-applications', enc(StorefrontApplicationsRequestSchema), { at: now }, enc(StorefrontApplicationsResponseSchema));
  if (!applications.some(({ storefrontAppId }) => storefrontAppId === input.storefrontAppId)) {
    report.push('register ' + input.storefrontAppId);
    if (input.apply) {
      yield* client.call('storefront-registry', '/storefront-registry/actions/register-storefront-application', enc(RegisterStorefrontApplicationPayloadSchema), {
        allowedChannels: ['B2C'], effectiveInterval: { effectiveFrom }, lifecycle: 'ACTIVE', reason: 'Stable sales environment storefront', storefrontAppId: input.storefrontAppId,
      }, enc(RegisterStorefrontApplicationResultSchema), true);
    }
  }
  let markets = yield* catalog();
  if (!markets.markets.some(({ marketRef: ref }) => ref.resourceId === input.marketId)) {
    report.push('create market ' + input.market.code);
    if (input.apply) {
      yield* client.call('commerce-market-catalog', '/commerce-market-catalog/actions/create-market', enc(CreateMarketPayloadSchema), {
        channels: ['B2C'], effectivePeriod: { startsAt: effectiveFrom }, jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }], lifecycle: 'ACTIVE',
        marketCode: input.market.code, marketId: input.marketId, purpose: input.market.purpose, reason: 'Stable sales environment market',
        sellingLegalEntityRef: sellerRef, supportedLocales: ['cs'],
      }, enc(CreateMarketResultSchema), true);
      markets = yield* catalog();
    }
  }
  const definition = markets.markets.find(({ marketRef: ref }) => ref.resourceId === input.marketId);
  if (!markets.associations.some(({ marketRef: ref, storefrontRef }) => ref.resourceId === input.marketId && storefrontRef.appId === input.storefrontAppId)) {
    report.push('associate ' + input.market.code + ' with ' + input.storefrontAppId);
    if (input.apply && definition !== undefined) {
      // A new Market joins its company scope through the containment worker; the association waits for it.
      yield* client.call('commerce-market-catalog', '/commerce-market-catalog/actions/associate-storefront', enc(AssociateStorefrontPayloadSchema), {
        associationId: input.associationId, channel: 'B2C', effectivePeriod: { startsAt: effectiveFrom },
        expectedMarketDefinitionRevisionRef: definition.definitionRevisionRef, marketRef, provenance,
        reason: 'Stable sales environment association', sellingLegalEntityRef: sellerRef,
        storefrontRef: { appId: input.storefrontAppId, tenantId: input.tenantId },
      }, enc(StorefrontAssociationResultSchema), true).pipe(
        Effect.retry({ schedule: Schedule.spaced(Duration.seconds(3)), times: 40, while: (failure) => Schema.is(DemoSeedError)(failure) && / HTTP 403 /u.test(failure.reason) }),
      );
    }
  }
  const configured = (yield* records({ limit: 0, markets: true, summary: true })).markets ?? [];
  if (!configured.some(({ marketId }) => marketId === input.marketId)) {
    report.push('configure ' + input.market.code + ' WHOLE_CATALOGUE CZK');
    if (input.apply) {
      const { revision } = yield* records({ limit: 0, summary: true });
      yield* client.apply('merchandise', manageMarkets, {
        _tag: 'ConfigureMarket', currency: 'CZK', exchangeRate: '1', marketCode: input.market.code, marketId: input.marketId,
        offerMode: 'WHOLE_CATALOGUE', roundingMinor: 100,
      }, revision);
    }
  }
  const listed = (yield* records({ limit: 250, productSort: 'sku', summary: true })).products;
  for (const product of input.products) {
    if (listed.some(({ sku }) => sku.trim().toLowerCase() === product.sku.toLowerCase())) continue;
    report.push('create product ' + product.sku);
    if (!input.apply) continue;
    const { revision } = yield* records({ limit: 0, summary: true });
    yield* client.call('merchandise', '/merchandise/actions/apply-command', enc(ApplyCommandPayloadSchema), {
      command: {
        _tag: 'CreateProduct', active: true, category: product.category, description: 'Ukázkový produkt stabilního prodejního prostředí.',
        lowStockThreshold: 0, name: product.name, priceMinor: product.priceMinor, published: true, sku: product.sku,
        stockTracked: false, taxClassificationCode: 'cz.vat.standard', unit: 'ks',
      },
      expectedRevision: revision,
    }, enc(ApplyCommandResultSchema), true);
  }
  return report;
});
const exit = await Effect.runPromiseExit(program.pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)));
if (Exit.isSuccess(exit)) {
  process.stdout.write(JSON.stringify({ pending: exit.value }) + '\\n');
} else {
  const failure = Cause.squash(exit.cause);
  process.stderr.write((Schema.is(DemoSeedError)(failure) ? failure.reason : 'the sales data step failed (' + (failure?._tag ?? 'unknown') + ')') + '\\n');
  process.exitCode = 1;
}
`;

/** The input of one tenant's sales data: its storefront, one Czech B2C market and the synthetic products. */
export const salesDataInput = ({ apply, bundle, config, slug }) => {
  const tenant = bundle.spec.tenants.find((entry) => entry.slug === slug);
  const written = bundle.accounts.tenants.find((entry) => entry.slug === slug);
  const owner = written.accounts.find(({ grants }) => grants.owner);
  const code = `${slug.toUpperCase().replaceAll('-', '')}-CZ`;
  return {
    apply,
    associationId: seededId(written.tenantId, `association:${code}:${tenant.storefronts[0].storefrontAppId}`),
    email: owner.email,
    legalEntityId: written.legalEntity.legalEntityId,
    market: { code, purpose: `Maloobchodní prodej v Česku (${tenant.displayName})` },
    marketId: seededId(written.tenantId, `market:${code}`),
    password: bundle.passwords.get(owner.email.toLowerCase()),
    products: SALES_PRODUCTS,
    shellUrl: config.origins.shell,
    storefrontAppId: tenant.storefronts[0].storefrontAppId,
    tenantId: written.tenantId,
  };
};

export const runSalesData = (input, { run = spawnSync } = {}) => {
  const result = run(process.execPath, ['--input-type=module', '--no-warnings', '-e', SALES_DATA_LAUNCHER], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
    input: JSON.stringify(input),
    stdio: ['pipe', 'pipe', 2],
  });
  if (result.error || result.status !== 0) fail(`sales data for tenant ${input.tenantId} failed`);
  try {
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  } catch {
    return fail('the sales data step printed no result');
  }
};

/** The Commerce portal's service principal in each tenant (scripts/demo/commerce-portal.mts) and its workloads. */
export const COMMERCE_PORTAL_PRINCIPAL = 'commerce-portal';
export const COMMERCE_PORTAL_WORKLOADS = Object.freeze(['commerce.storefront-client', 'core.identity-provider']);
const OWNER_SECRETS = 'ONTOS_OWNER_SECRETS_JSON';

/**
 * Runs in the app workspace: the Shell's external identity deployment and Commerce's verification grants for the
 * given portal workloads, exactly as scripts/demo/commerce-portal.mts derives them. stdin: the workloads; stdout: JSON.
 */
export const PORTAL_DEPLOYMENT_LAUNCHER = `
import { commercePortalExternalIdentityDeployment, commercePortalVerificationWorkloadGrants } from './scripts/demo/commerce-portal.mts';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const deployment = commercePortalExternalIdentityDeployment(JSON.parse(Buffer.concat(chunks).toString('utf8')));
process.stdout.write(JSON.stringify({ deployment, verification: commercePortalVerificationWorkloadGrants(deployment) }) + '\\n');
`;

export const runPortalDeployment = (workloads, { run = spawnSync } = {}) => {
  const result = run(process.execPath, ['--input-type=module', '--no-warnings', '-e', PORTAL_DEPLOYMENT_LAUNCHER], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
    input: JSON.stringify(workloads),
    stdio: ['pipe', 'pipe', 2],
  });
  if (result.error || result.status !== 0) fail('the Commerce portal identity deployment could not be derived');
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
};

/** The app's stored owner secrets, parsed; exactly one entry must exist (before-app stored it). */
const readOwnerSecrets = async (store, config) => {
  const entries = (await store.list(config.services.app)).filter(({ key }) => key === OWNER_SECRETS);
  if (entries.length !== 1) fail(`app must hold ${OWNER_SECRETS} exactly once; run before-app first`);
  try {
    return JSON.parse(entries[0].content);
  } catch {
    return fail(`app ${OWNER_SECRETS} is not JSON`);
  }
};

/**
 * Each storefront tenant's Commerce portal principal and managed key, issued natively through the Shell as the tenant
 * owner. One key serves as both the Core identity and the gateway key (commerce-portal.mts). A key already in the
 * app's COMMERCE_TENANT_CREDENTIALS is kept; a principal with a key that is not stored there is refused, because
 * rotating it is a deliberate act. Returns the credentials map, the portal workloads and what changed.
 */
export const ensureCommercePortal = async ({ bundle, config, log, shellClient, store }) => {
  const owners = await readOwnerSecrets(store, config);
  const storedText = owners['commerce-customer-context']?.COMMERCE_TENANT_CREDENTIALS;
  const credentials = storedText === undefined ? {} : JSON.parse(storedText);
  let issued = false;
  const workloads = [];
  for (const tenant of bundle.spec.tenants.filter(({ storefronts }) => storefronts.length > 0)) {
    const written = bundle.accounts.tenants.find(({ slug }) => slug === tenant.slug);
    const owner = written.accounts.find(({ grants }) => grants.owner);
    const cookie = await shellClient.signIn(owner.email, bundle.passwords.get(owner.email.toLowerCase()));
    const found = (await shellClient.listManaged(cookie)).filter(({ displayName }) => displayName === COMMERCE_PORTAL_PRINCIPAL);
    if (found.length > 1) fail(`tenant ${tenant.slug} has ${found.length} principals named ${COMMERCE_PORTAL_PRINCIPAL}`);
    if (found[0] !== undefined && (found[0].kind !== 'service' || found[0].principalStatus !== 'active')) {
      fail(`${COMMERCE_PORTAL_PRINCIPAL} of ${tenant.slug} is not an active service principal`);
    }
    const hasKey = found[0]?.key !== null && found[0]?.key !== undefined;
    const stored = credentials[written.tenantId] !== undefined;
    if (hasKey !== stored) {
      fail(
        hasKey
          ? `${COMMERCE_PORTAL_PRINCIPAL} of ${tenant.slug} has a key that COMMERCE_TENANT_CREDENTIALS lacks; rotate it deliberately`
          : `COMMERCE_TENANT_CREDENTIALS holds ${tenant.slug} but the Shell has no key for it`,
      );
    }
    const principalId =
      found[0]?.principalId ??
      (await shellClient.createServicePrincipal(cookie, COMMERCE_PORTAL_PRINCIPAL, `stable-commerce-portal-${config.projectId}-${written.tenantId}`));
    if (!hasKey) {
      const key = await shellClient.issueManagedKey(cookie, principalId, COMMERCE_PORTAL_PRINCIPAL);
      credentials[written.tenantId] = { coreIdentityApiKey: key, gatewayApiKey: key };
      issued = true;
      log(`issued the Commerce portal key of ${tenant.slug} (value withheld)`);
    }
    workloads.push({
      apiKeyName: COMMERCE_PORTAL_PRINCIPAL,
      displayName: COMMERCE_PORTAL_PRINCIPAL,
      legalEntityId: written.legalEntity.legalEntityId,
      principalId,
      tenantId: written.tenantId,
    });
  }
  return { credentials, issued, workloads };
};

/** The portal's owner secrets: tenant credentials and verification grants for Commerce, the deployment for the Shell. */
export const portalOwnerSecrets = (credentials, { deployment, verification }) => ({
  'commerce-customer-context': {
    COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS: JSON.stringify(verification),
    COMMERCE_TENANT_CREDENTIALS: JSON.stringify(credentials),
  },
  'shell-super-app': { ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify(deployment) },
});

/** Adds each portal principal's workloads to its tenant's registrations. */
export const withPortalWorkloads = (registrations, workloads) => ({
  ...registrations,
  tenants: registrations.tenants.map((tenant) => ({
    ...tenant,
    workloads: [
      ...tenant.workloads,
      ...workloads
        .filter(({ tenantId }) => tenantId === tenant.tenantId)
        .flatMap(({ legalEntityId, principalId }) =>
          COMMERCE_PORTAL_WORKLOADS.map((workloadKey) => ({ legalEntityId, principalId, workloadKey })),
        ),
    ],
  })),
});

/** Waits until the public Shell answers its session endpoint again (after an app restart). */
export const waitForShell = async (origin, { fetchImpl = fetch, timeoutMs = 15 * 60_000, pollMs = 10_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetchImpl(`${origin}/shell-super-app-api/auth/session`, { signal: AbortSignal.timeout(20_000) });
      if (response.status < 500) return;
    } catch {
      // Not serving yet.
    }
    if (Date.now() > deadline) fail(`${origin} did not serve the Shell again in time`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

export const afterApp = async ({ apply, bundle, config, deps, log }) => {
  const services = await deps.assertServices(config);
  if (services.app.status !== 'ACTIVE') fail(`app is ${services.app.status}; deploy the app before after-app`);
  log('accounts: native bootstrap on the app container');
  deps.remote(accountsScript(bundle.accounts, apply));
  if (!apply) {
    log('dry run: modules, storefront keys, workloads and sales data follow the committed accounts; rerun with --apply');
    return { applied: false };
  }
  const ownerOf = (slug) => {
    const written = bundle.accounts.tenants.find((tenant) => tenant.slug === slug);
    const owner = written.accounts.find(({ grants }) => grants.owner);
    return { email: owner.email, password: bundle.passwords.get(owner.email.toLowerCase()), written };
  };
  for (const [slug, moduleKeys] of Object.entries(bundle.modules)) {
    const { email, password, written } = ownerOf(slug);
    log(`modules ${slug}: ${moduleKeys.join(', ')}`);
    deps.remote(modulesScript({ email, moduleKeys, password, tenantId: written.tenantId }, true));
  }
  const keysDir = mkdtempSync(path.join(tmpdir(), 'ontos-stable-keys-'));
  chmodSync(keysDir, 0o700);
  let registrations;
  try {
    registrations = await ensureStorefrontSecrets({ apply: true, bundle, config, keysDir, log, shellClient: deps.shellClient, store: deps.store });
  } finally {
    rmSync(keysDir, { force: true, recursive: true });
  }
  const portal = await ensureCommercePortal({ bundle, config, log, shellClient: deps.shellClient, store: deps.store });
  const stored = await deps.applySecrets({
    apply: true,
    bundle: {
      projectId: config.projectId,
      schemaVersion: 1,
      services: { app: { [OWNER_SECRETS]: JSON.stringify(portalOwnerSecrets(portal.credentials, deps.portalDeployment(portal.workloads))) } },
    },
    confirmRotation: true,
    config,
  });
  log('workloads: storefront and Commerce portal registrations');
  deps.remote(workloadsScript(withPortalWorkloads(registrations, portal.workloads), true));
  if (stored.changes.some(({ action }) => action !== 'unchanged')) {
    log('restarting app for its new owner secrets');
    await deps.restartApp();
    await deps.waitForShell();
  }
  const selling = Object.entries(bundle.modules)
    .filter(([, keys]) => keys.includes('demo.merchandise') || keys.includes('finance.billing') || keys.includes('commerce.tax'))
    .map(([slug]) => slug);
  for (const slug of selling) {
    const { email, password, written } = ownerOf(slug);
    const target = { email, password, shellUrl: config.origins.shell, tenantId: written.tenantId };
    const plan = deps.taxBaseline({ ...target, mode: 'dry-run' });
    deps.taxBaseline({ ...target, mode: 'apply', reviewed: plan.fingerprint });
    deps.taxBaseline({ ...target, mode: 'verify' });
    log(`VAT baseline ${slug}: verified`);
  }
  const sales = {};
  for (const slug of bundle.salesData) {
    sales[slug] = deps.salesData(salesDataInput({ apply: true, bundle, config, slug })).pending;
    log(`sales data ${slug}: ${sales[slug].length === 0 ? 'already complete' : sales[slug].join('; ')}`);
  }
  log('next: deploy storefront, shop and n1; their keys are stored');
  return { applied: true, sales };
};

const USAGE = 'Usage: gha-bootstrap.mjs before-app|after-app --config STABLE.json --tag TAG [--apply]';

export const main = async (argv, { env = process.env, log = (line) => process.stderr.write(`${line}\n`) } = {}) => {
  const [phase, ...rest] = argv;
  if (!['before-app', 'after-app'].includes(phase)) fail(USAGE);
  const { values } = parseArgs({
    args: rest,
    options: { apply: { default: false, type: 'boolean' }, config: { type: 'string' }, tag: { type: 'string' } },
    strict: true,
  });
  if (!values.config || !values.tag) fail(USAGE);
  if (!env.ZEROPS_TOKEN) fail('ZEROPS_TOKEN is required');
  const config = await loadStableConfig(values.config);
  const bundle = parseBootstrapBundle(env.STABLE_BOOTSTRAP_JSON, { catalog: loadCatalog(), config });
  const client = createZeropsClient({ token: env.ZEROPS_TOKEN });
  const assertServices = (stable) => assertProjectServices(stable, { client });
  if (phase === 'before-app') {
    const store = createSecretStore({ token: env.ZEROPS_TOKEN });
    const live = await liveDependencies({ config, token: env.ZEROPS_TOKEN });
    return beforeApp({
      apply: values.apply,
      bundle,
      config,
      deps: {
        applySecrets: (input) => applySecrets({ ...input, assertServices, store }),
        assertServices,
        initialize: (input) => initialize({ ...input, deps: live }),
      },
      log,
      smtpPassword: env.STAGE_SMTP_PASSWORD,
      tag: values.tag,
    });
  }
  const store = createSecretStore({ token: env.ZEROPS_TOKEN });
  return afterApp({
    apply: values.apply,
    bundle,
    config,
    deps: {
      applySecrets: (input) => applySecrets({ ...input, assertServices, store }),
      assertServices,
      portalDeployment: (workloads) => runPortalDeployment(workloads),
      restartApp: async () => {
        await client.stopService(config.services.app);
        await client.startService(config.services.app);
      },
      waitForShell: () => waitForShell(config.origins.shell),
      remote: (script) => runRemote(script),
      salesData: (input) => runSalesData(input),
      shellClient: makeShellIdentityClient({ origin: config.origins.shell }),
      store,
      taxBaseline: (input) => runTaxBaseline(input),
    },
    log,
  });
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
