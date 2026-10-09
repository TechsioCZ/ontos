import { DateTime, Effect, Layer, Option, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { CloudflareApiLive, CloudflareCredentials } from '../ops/cloudflare-api.mts';
import {
  ENABLE_ZERO_TRUST,
  billingCycleStart,
  checkUsage,
  costGuardChecks,
  killSwitchRule,
  UsageConfiguration,
  usageReport,
} from '../ops/cloudflare-stage-cost-guard.mts';
import { CutoverConfiguration, provisionCostGuards, resume } from '../ops/cloudflare-stage-cutover.mts';
import type { CutoverSettings } from '../ops/cloudflare-stage-cutover.mts';
import { OpsMode, STAGE_ZEROPS_PROJECT_ID } from '../ops/stage-operations.mts';
import { fakeCloudflareAccount, fakeFiles, fakeStage, mutatingCommands } from './stage-operations-fixture.mts';
import type { FakeCloudflareAccount, FakeStage } from './stage-operations-fixture.mts';

const STAGE_EDGE = 'stage-edge';
const OPS_EMAIL = 'ops@example.com';
const LEAD_EMAIL = 'lead@example.com';
const PEOPLE = [OPS_EMAIL, LEAD_EMAIL];
const SHELL_HOSTNAME = 'app.stage.example.com';
const ZONE_PATH = '/client/v4/zones/zone-1';
const ACCOUNT_PATH = '/client/v4/accounts/account-1';
const CUSTOM_PHASE = 'http_request_firewall_custom';
const KILL_SWITCH = 'ontos_stage_kill_switch';
const CLIENT_SECRET = 'CLOUDFLARE_ACCESS_CLIENT_SECRET';
const CLIENT_ID = 'CLOUDFLARE_ACCESS_CLIENT_ID';
const ACCESS_APPS = '/access/apps';
const SHELL_WORKER = 'ontos-shell-super-app';

const settings: CutoverSettings = {
  accessEmails: PEOPLE,
  accountId: 'account-1',
  apiToken: Redacted.make('lead-token-secret'),
  enforceAccess: false,
  projectId: STAGE_ZEROPS_PROJECT_ID,
  repository: 'TechsioCZ/ontos',
  shellHostname: SHELL_HOSTNAME,
  stageEdgeApiToken: Redacted.make('ci-token-secret'),
  stageZone: 'stage.example.com',
};

/** Every placed unit's public hostname, in placement order (the Shell deploys last). */
const HOSTNAMES = [
  'ontos-stage-availability.stage.example.com',
  'ontos-stage-assortment.stage.example.com',
  'ontos-stage-party-registry.stage.example.com',
  'ontos-stage-commerce-customer-context.stage.example.com',
  'ontos-stage-payment-term-catalog.stage.example.com',
  'ontos-stage-commerce-market-catalog.stage.example.com',
  'ontos-stage-catalog.stage.example.com',
  'ontos-stage-pricing.stage.example.com',
  'ontos-stage-storefront-registry.stage.example.com',
  'ontos-stage-price-group-catalog.stage.example.com',
  'ontos-stage-inventory.stage.example.com',
  'ontos-stage-privacy.stage.example.com',
  SHELL_HOSTNAME,
];

const apiLayer = (account: FakeCloudflareAccount) =>
  CloudflareApiLive.pipe(
    Layer.provide(Layer.succeed(CloudflareCredentials, { accountId: settings.accountId, apiToken: settings.apiToken })),
    Layer.provide(account.layer),
  );

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fakes: { readonly account: FakeCloudflareAccount; readonly settings?: CutoverSettings; readonly stage: FakeStage },
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        apiLayer(fakes.account),
        Layer.succeed(CutoverConfiguration, fakes.settings ?? settings),
        Layer.succeed(OpsMode, { dryRun: false }),
        fakes.stage.layer,
        fakeFiles().layer,
      ),
    ),
  );

const KILL_SWITCH_EXPRESSION = `(http.host in {${HOSTNAMES.map((hostname) => JSON.stringify(hostname)).join(' ')}})`;

const writes = (account: FakeCloudflareAccount) =>
  account.requests
    .filter(({ method }) => method !== 'GET')
    .map(({ body, method, url }) => ({
      body: Option.getOrNull(body),
      method,
      path: url.pathname.replace(ACCOUNT_PATH, '').replace(ZONE_PATH, ''),
    }));

const ownedRule = (account: FakeCloudflareAccount, phase: string) =>
  account.rulesets.find((ruleset) => ruleset.phase === phase)?.rules.find(({ ref }) => ref !== undefined);

it.effect('provisions every cost guard on an empty account and hands CI the zone and the service token', () =>
  Effect.gen(function* provisionsGuards() {
    const account = fakeCloudflareAccount({});
    const stage = fakeStage({});

    yield* run(provisionCostGuards, { account, stage });

    expect(writes(account)).toStrictEqual([
      {
        body: {
          rules: [
            {
              action: 'block',
              description: 'OntOS stage: cost kill switch; resume with cloudflare-stage-cutover resume',
              enabled: false,
              expression: KILL_SWITCH_EXPRESSION,
              ref: KILL_SWITCH,
            },
          ],
        },
        method: 'PUT',
        path: `/rulesets/phases/${CUSTOM_PHASE}/entrypoint`,
      },
      { body: { duration: '8760h', name: 'ontos-stage-ci' }, method: 'POST', path: '/access/service_tokens' },
      {
        body: {
          decision: 'non_identity',
          include: [{ service_token: { token_id: 'token-1' } }],
          name: 'ontos-stage-ci-token',
        },
        method: 'POST',
        path: '/access/policies',
      },
      {
        body: {
          alert_type: 'billing_usage_alert',
          enabled: true,
          filters: { limit: ['5000000'], product: ['worker_requests'] },
          mechanisms: { email: [{ id: OPS_EMAIL }, { id: LEAD_EMAIL }] },
          name: 'ontos-stage-workers-requests',
        },
        method: 'POST',
        path: '/alerting/v3/policies',
      },
    ]);
    expect(stage.variables.get(STAGE_EDGE)?.get('CLOUDFLARE_STAGE_ZONE_ID')).toBe('zone-1');
    expect(stage.inputs.find(({ command }) => command.startsWith(`gh secret set ${CLIENT_ID}`))?.stdin).toBe(
      'access-client-id',
    );
    expect(stage.inputs.find(({ command }) => command.startsWith(`gh secret set ${CLIENT_SECRET}`))?.stdin).toBe(
      'service-token-secret',
    );
    expect(stage.commands.map(({ args }) => args.join(' ')).join('\n')).not.toContain('service-token-secret');
  }),
);

const PEOPLE_POLICY = 'ontos-stage-people';

it.effect('gates only the Shell ingress even when the cost plan includes retired module hostnames', () =>
  Effect.gen(function* enforcesAccess() {
    const account = fakeCloudflareAccount({});
    const stage = fakeStage({});

    yield* run(provisionCostGuards, {
      account,
      settings: { ...settings, enforceAccess: true },
      stage,
    });

    const app = (name: string, destinations: string[], policies: { id: string; precedence: number }[]) => ({
      body: {
        app_launcher_visible: false,
        destinations: destinations.map((uri) => ({ type: 'public', uri })),
        name,
        policies,
        session_duration: '720h',
        type: 'self_hosted',
      },
      method: 'POST',
      path: ACCESS_APPS,
    });
    expect(writes(account).filter(({ path }) => path === ACCESS_APPS)).toStrictEqual([
      app(
        'ontos-stage-public-paths',
        [`${SHELL_HOSTNAME}/shell-super-app-api/auth/api-key/gateway-context`],
        [{ id: 'policy-3', precedence: 1 }],
      ),
      app(
        'ontos-stage-contracts',
        [`${SHELL_HOSTNAME}/.well-known/ontos-shell-runtime.json`, `${SHELL_HOSTNAME}/mf-manifest.json`],
        [{ id: 'policy-3', precedence: 1 }],
      ),
      app(
        'ontos-stage',
        [SHELL_HOSTNAME],
        [
          { id: 'policy-2', precedence: 1 },
          { id: 'policy-1', precedence: 2 },
        ],
      ),
    ]);
    expect(account.accessPolicies.find(({ name }) => name === PEOPLE_POLICY)).toMatchObject({
      decision: 'allow',
      include: [{ everyone: {} }],
    });

    // A re-run finds every application current and changes nothing.
    const before = writes(account).length;
    yield* run(provisionCostGuards, {
      account,
      settings: { ...settings, enforceAccess: true },
      stage,
    });
    expect(
      writes(account)
        .slice(before)
        .filter(({ path }) => path.startsWith('/access')),
    ).toStrictEqual([]);
    expect(account.accessPolicies.find(({ name }) => name === 'ontos-stage-gateway-bypass')).toMatchObject({
      decision: 'bypass',
      include: [{ everyone: {} }],
    });

    const accessChecks = function* accessChecks() {
      const checks = yield* run(costGuardChecks({ ...settings, enforceAccess: true, hostnames: HOSTNAMES }), {
        account,
        stage,
      });
      return checks.filter(([label]) => label.includes('Access')).map(([, failure]) => failure);
    };
    expect(yield* accessChecks()).toStrictEqual(Array.from({ length: 6 }, () => Option.none()));

    // An application whose policies were swapped no longer passes verify.
    const stageApp = account.accessApps.findIndex(({ name }) => name === 'ontos-stage');
    account.accessApps.splice(stageApp, 1, {
      ...account.accessApps[stageApp],
      policies: [{ id: 'policy-3', precedence: 1 }],
    });
    expect((yield* accessChecks()).at(-1)).toStrictEqual(Option.some('it drifted; run cost-guards'));
  }),
);

it.effect('detects and removes retired Access destinations while keeping application IDs and policies', () =>
  Effect.gen(function* removesRetiredDestinations() {
    const account = fakeCloudflareAccount({});
    const stage = fakeStage({});
    const enforced = { ...settings, enforceAccess: true };
    yield* run(provisionCostGuards, { account, settings: enforced, stage });
    const current = [...account.accessApps];
    account.accessApps.splice(
      0,
      account.accessApps.length,
      ...current.map((app) => ({
        ...app,
        destinations: [{ type: 'public', uri: HOSTNAMES[0] }],
      })),
    );

    const checks = yield* run(costGuardChecks({ ...enforced, hostnames: HOSTNAMES }), { account, stage });
    expect(
      checks.filter(([label]) => label.includes('Access application')).map(([, failure]) => failure),
    ).toStrictEqual(Array.from({ length: 3 }, () => Option.some('it drifted; run cost-guards')));

    const before = writes(account).length;
    yield* run(provisionCostGuards, { account, settings: enforced, stage });

    expect(account.accessApps).toStrictEqual(current);
    expect(
      writes(account)
        .slice(before)
        .filter(({ path }) => path.startsWith(ACCESS_APPS))
        .map(({ method }) => method),
    ).toStrictEqual(['PUT', 'PUT', 'PUT']);
  }),
);

it.effect('leaves who may sign in alone while Access is not enforced', () =>
  Effect.gen(function* keepsPeoplePolicy() {
    const legacy = {
      decision: 'allow',
      id: 'policy-9',
      include: [{ email: { email: OPS_EMAIL } }],
      name: PEOPLE_POLICY,
    };
    const account = fakeCloudflareAccount({ accessPolicies: [legacy] });

    yield* run(provisionCostGuards, { account, stage: fakeStage({}) });

    expect(writes(account).filter(({ path }) => path.startsWith('/access/policies/'))).toStrictEqual([]);
    expect(account.accessPolicies.find(({ name }) => name === PEOPLE_POLICY)).toStrictEqual(legacy);
  }),
);

it.effect('adds the kill switch next to other projects rules, keeps a tripped one on and converges its hostnames', () =>
  Effect.gen(function* convergesRules() {
    const foreign = { action: 'block', expression: '(http.host eq "other.stage.example.com")', id: 'foreign-1' };
    const tripped = { ...killSwitchRule(HOSTNAMES.slice(0, 2), true), id: 'kill-1' };
    const account = fakeCloudflareAccount({
      rulesets: [{ id: 'custom', kind: 'zone', phase: CUSTOM_PHASE, rules: [foreign, tripped] }],
    });

    yield* run(provisionCostGuards, { account, stage: fakeStage({}) });

    const ruleWrites = writes(account).filter(({ path }) => path.startsWith('/rulesets'));
    expect(ruleWrites.map(({ method, path }) => `${method} ${path}`)).toStrictEqual([
      'PATCH /rulesets/custom/rules/kill-1',
    ]);
    const custom = account.rulesets.find(({ phase }) => phase === CUSTOM_PHASE);
    expect(custom?.rules[0]).toStrictEqual(foreign);
    expect(custom?.rules[1]).toMatchObject({ ...killSwitchRule(HOSTNAMES, true), id: 'kill-1' });
  }),
);

it.effect('adds a missing kill switch to an entrypoint other projects already use', () =>
  Effect.gen(function* addsKillSwitch() {
    const foreign = { action: 'block', expression: '(ip.src eq 192.0.2.1)', id: 'foreign-1', ref: 'someone_else' };
    const account = fakeCloudflareAccount({
      rulesets: [{ id: 'custom', kind: 'zone', phase: CUSTOM_PHASE, rules: [foreign] }],
    });

    yield* run(provisionCostGuards, { account, stage: fakeStage({}) });

    expect(writes(account).filter(({ path }) => path.startsWith('/rulesets'))).toStrictEqual([
      { body: killSwitchRule(HOSTNAMES, false), method: 'POST', path: '/rulesets/custom/rules' },
    ]);
    expect(account.rulesets.find(({ phase }) => phase === CUSTOM_PHASE)?.rules[0]).toStrictEqual(foreign);
  }),
);

it.effect('stops with the Zero Trust to-do while Access is not enabled, and verify reports it', () =>
  Effect.gen(function* accessNotEnabled() {
    const account = fakeCloudflareAccount({ accessEnabled: false });
    const stage = fakeStage({});

    const error = yield* run(provisionCostGuards, { account, stage }).pipe(Effect.flip);

    expect(error.message).toBe(ENABLE_ZERO_TRUST);
    expect(writes(account).filter(({ path }) => path.startsWith('/access'))).toStrictEqual([]);
    const checks = yield* run(costGuardChecks({ ...settings, hostnames: HOSTNAMES }), { account, stage });
    expect(checks.filter(([label]) => label.includes('Access')).map(([, failure]) => failure)).toStrictEqual([
      Option.some(ENABLE_ZERO_TRUST),
      Option.some(ENABLE_ZERO_TRUST),
    ]);
  }),
);

it.effect('rotates the CI service token when stage-edge lost its credentials, and reuses it otherwise', () =>
  Effect.gen(function* rotatesToken() {
    const token = { client_id: 'access-client-id', id: 'token-7', name: 'ontos-stage-ci' };
    const account = fakeCloudflareAccount({ serviceTokens: [token] });
    const stage = fakeStage({ secrets: { [STAGE_EDGE]: [CLIENT_ID] } });

    yield* run(provisionCostGuards, { account, stage });
    yield* run(provisionCostGuards, { account, stage });

    expect(writes(account).filter(({ path }) => path.startsWith('/access/service_tokens'))).toStrictEqual([
      { body: {}, method: 'POST', path: '/access/service_tokens/token-7/rotate' },
    ]);
    expect(stage.inputs.find(({ command }) => command.startsWith(`gh secret set ${CLIENT_SECRET}`))?.stdin).toBe(
      'rotated-service-token-secret',
    );
    expect(account.accessPolicies.find(({ name }) => name === 'ontos-stage-ci-token')).toMatchObject({
      include: [{ service_token: { token_id: 'token-7' } }],
    });
  }),
);

const USAGE_LIMITS = {
  billingCycleDay: 1,
  cpuMsLimit: 24_000_000,
  ontosScripts: [SHELL_WORKER, 'ontos-catalog'],
  requestLimit: 8_000_000,
  zoneId: 'zone-1',
};

/** Usage split between an OntOS Worker and another project's Worker on the same account. */
const accountUsage = (requests: number, cpuTimeUs: number) => [
  { cpuTimeUs: cpuTimeUs / 2, requests: requests - 1, scriptName: SHELL_WORKER },
  { cpuTimeUs: cpuTimeUs / 2, requests: 1, scriptName: 'biomem-web' },
];

const usageRun = <A, E, R>(effect: Effect.Effect<A, E, R>, account: FakeCloudflareAccount) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        apiLayer(account),
        Layer.succeed(UsageConfiguration, USAGE_LIMITS),
        Layer.succeed(OpsMode, { dryRun: false }),
      ),
    ),
  );

const provisionedAccount = Effect.gen(function* provisionedAccountEffect() {
  const account = fakeCloudflareAccount({});
  yield* run(provisionCostGuards, { account, stage: fakeStage({}) });
  account.requests.length = 0;
  return account;
});

const NOW = DateTime.makeUnsafe('2026-09-29T10:00:00Z');

it.effect('leaves the stage hostnames open while this billing cycle stays under both limits', () =>
  Effect.gen(function* underLimits() {
    const account = yield* provisionedAccount;
    account.usage = accountUsage(7_999_999, 23_000_000_000);

    yield* usageRun(checkUsage(NOW), account);

    expect(writes(account).map(({ method, path }) => `${method} ${path}`)).toStrictEqual(['POST /client/v4/graphql']);
    const [query] = writes(account);
    expect(query?.body).toMatchObject({
      variables: { accountTag: 'account-1', since: '2026-09-01T00:00:00.000Z', until: '2026-09-29T10:00:00.000Z' },
    });
    // The whole account bills, so the query never filters by script.
    expect(JSON.stringify(query?.body)).not.toContain('scriptName_in');
    expect(ownedRule(account, CUSTOM_PHASE)?.enabled).toBe(false);
  }),
);

it.effect.each([
  ['requests', accountUsage(8_000_000, 0)],
  ['CPU time', accountUsage(2, 24_000_000_000)],
] as const)('trips the kill switch and fails once %s reach the limit', ([, usage]) =>
  Effect.gen(function* overLimit() {
    const account = yield* provisionedAccount;
    account.usage = usage;

    const error = yield* usageRun(checkUsage(NOW), account).pipe(Effect.flip);

    expect(error.message).toContain('the kill switch now blocks every OntOS stage hostname');
    expect(ownedRule(account, CUSTOM_PHASE)?.enabled).toBe(true);

    // Only the operator turns it off again.
    const stage = fakeStage({});
    yield* run(resume, { account, stage });
    expect(ownedRule(account, CUSTOM_PHASE)?.enabled).toBe(false);
    expect(mutatingCommands(stage.commands)).toStrictEqual([]);
  }),
);

it.effect('fails when the kill switch was never provisioned', () =>
  Effect.gen(function* missingKillSwitch() {
    const account = fakeCloudflareAccount({ usage: accountUsage(9_000_000, 0) });

    const error = yield* usageRun(checkUsage(NOW), account).pipe(Effect.flip);

    expect(error.message).toBe('the kill switch rule ontos_stage_kill_switch it does not exist; run provision');
  }),
);

it('breaks the account usage into each OntOS Worker and the other projects', () => {
  const since = DateTime.makeUnsafe('2026-09-01T00:00:00Z');
  const report = usageReport(
    {
      cpuTimeMs: 3500,
      requests: 1700,
      scripts: [
        { cpuTimeMs: 2000, requests: 1000, scriptName: 'biomem-web' },
        { cpuTimeMs: 1000, requests: 500, scriptName: SHELL_WORKER },
        { cpuTimeMs: 500, requests: 200, scriptName: 'ontos-catalog' },
      ],
    },
    USAGE_LIMITS,
    since,
  );

  expect(report).toStrictEqual([
    'account Workers usage since 2026-09-01T00:00:00.000Z: 1,700 of 8,000,000 requests, 3,500 of 24,000,000 CPU ms',
    '  OntOS stage Workers: 700 requests, 1,500 CPU ms',
    `    ${SHELL_WORKER}: 500 requests, 1,000 CPU ms`,
    '    ontos-catalog: 200 requests, 500 CPU ms',
    '  other Workers on the account (1): 1,000 requests, 2,000 CPU ms',
  ]);
});

const cycleStart = (now: DateTime.Utc, day: number) => DateTime.formatIso(billingCycleStart(now, day));

it('starts the billing cycle on its day of the current or the previous month', () => {
  expect(cycleStart(NOW, 1)).toBe('2026-09-01T00:00:00.000Z');
  expect(cycleStart(NOW, 28)).toBe('2026-09-28T00:00:00.000Z');
  expect(cycleStart(DateTime.makeUnsafe('2026-01-10T00:00:00Z'), 15)).toBe('2025-12-15T00:00:00.000Z');
});
