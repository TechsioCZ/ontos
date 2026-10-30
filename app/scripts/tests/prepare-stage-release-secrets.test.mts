import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Array as Arr, Cause, Effect, FileSystem, Order, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApplicationReleaseIntentSchema } from '../application-release-intent.mts';
import { gatewayPublicJwksFor, workerSecretPlan } from '../ops/cloudflare-stage-cutover.mts';
import type { StageEdgeConfig } from '../ci/stage-edge.mts';
import { readEdgeUnits } from '../ops/stage-edge-units.mts';
import {
  DERIVED_HOST_BINDINGS,
  derivedHostBindings,
  prepareStageReleaseSecrets,
  PROJECTS_RELEASE_SECRET_KEYS,
  StageReleaseSecretPreparationError,
  writePreparedStageReleaseSecrets,
} from '../prepare-stage-release-secrets.mts';
import type { StageReleaseSecretInput } from '../prepare-stage-release-secrets.mts';

const SHELL = 'shell-super-app';
const PROJECTS = 'projects';
const BINDING_INVALID = 'binding-invalid';
const SHARED_KEY = 'synthetic-shared-spicedb-credential';
const PRIVATE_AUTH = 'synthetic-private-shell-auth-never-copy';
const CONFLICTING_VALUE = 'conflicting-value';
const WORKLOAD_KEY = 'synthetic-private-workload-key-never-copy';
const SHELL_URL = 'https://ontos-stage.example.test';
const STAGE_ZONE = 'example.test';
const SHELL_API = `${SHELL_URL}/shell-super-app-api`;
// Not the zone's conventional name: the preparer must use the topology's SpiceDB hostname verbatim.
const SPICEDB_HOST = 'custom-spicedb.example.test';
const STOREFRONT_URL = 'https://ontos-stage-akros.example.test';
const SENDER = 'noreply@ontos-stage.example.test';
const EDGE: StageEdgeConfig = {
  accountId: 'a'.repeat(32),
  emailSender: SENDER,
  shellHostname: 'ontos-stage.example.test',
  spicedbHostname: SPICEDB_HOST,
  storefrontCatalogKvId: '',
  storefrontHostname: 'ontos-stage-akros.example.test',
  workersDevSubdomain: 'example',
  zone: STAGE_ZONE,
};
/** The bindings the preparer adds to the Shell and Commerce beyond the native secret plan. */
const SHELL_HOST_BINDINGS = {
  AKROS_STOREFRONT_PUBLIC_URL: STOREFRONT_URL,
  ONTOS_EMAIL_FROM: SENDER,
  ONTOS_OAUTH_ISSUER: `${SHELL_API}/oauth`,
  ONTOS_PUBLIC_URL: SHELL_URL,
};
const COMMERCE_HOST_BINDINGS = {
  COMMERCE_CORE_IDENTITY_BASE_URL: SHELL_API,
  COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: `${SHELL_URL},${STOREFRONT_URL}`,
  COMMERCE_PORTAL_AUTH_URL: STOREFRONT_URL,
  ONTOS_EMAIL_FROM: SENDER,
};
const FOREIGN_ZONE = 'foreign.invalid';
const FOREIGN_ORIGIN = `https://ontos-stage.${FOREIGN_ZONE}`;
const MARKET_CATALOG = 'commerce-market-catalog';
const isDerivedHostBinding = (key: string) => DERIVED_HOST_BINDINGS.some((binding) => binding === key);
const privateKey = JSON.stringify({
  ...generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
  alg: 'EdDSA',
  kid: 'stage-test-signing-key',
  use: 'sig',
});
const BundleSchema = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String));
const decodeBundle = Schema.decodeUnknownSync(Schema.fromJsonString(BundleSchema));
const withoutKey = <A,>(record: Readonly<Record<string, A>>, omitted: string) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== omitted));

const fixture = Effect.gen(function* canonicalBundleFixture() {
  const units = yield* readEdgeUnits;
  const intent = Schema.decodeUnknownSync(Schema.fromJsonString(ApplicationReleaseIntentSchema))(
    readFileSync(new URL('../../topology/application-release-intent.json', import.meta.url), 'utf-8'),
  );
  const publicJwks = yield* gatewayPublicJwksFor(Redacted.make(privateKey));
  const plan = workerSecretPlan(
    units,
    {
      shellHostname: 'ontos-stage.example.test',
      spicedbHostname: SPICEDB_HOST,
      stageZone: STAGE_ZONE,
    },
    {
      betterAuthSecret: Redacted.make(PRIVATE_AUTH),
      commerceCustomerContextGatewayApiKey: Redacted.make(WORKLOAD_KEY),
      commerceMarketCatalogGatewayApiKey: Redacted.make(WORKLOAD_KEY),
      crmPartyIntakeApiKey: Redacted.make(WORKLOAD_KEY),
      gatewayPrivateJwk: Redacted.make(privateKey),
      gatewayPublicJwks: publicJwks,
      pricingGatewayApiKey: Redacted.make(WORKLOAD_KEY),
      spicedbPresharedKey: Redacted.make(SHARED_KEY),
    },
  );
  const bundle = Object.fromEntries(
    units.map((unit) => [
      unit.id,
      Object.fromEntries(
        Object.entries(plan.get(unit.workerName) ?? {}).map(([key, value]) => [key, Redacted.value(value)]),
      ),
    ]),
  );
  const original = {
    ...withoutKey(bundle, PROJECTS),
    'retained-unserved-owner': { EXTRA_BINDING: 'exact\nbyte\\value' },
    [SHELL]: { ...bundle[SHELL], EXTRA_OWNER_BINDING: 'preserve-me' },
  };
  const retained = JSON.stringify(original, null, 3).replace('"preserve-me"', String.raw`"preserve-\u006de"`);
  const raw = ` \n${retained}\n\t`;
  const input: StageReleaseSecretInput = { bundle: Redacted.make(raw), edge: EDGE, intent, units };
  return { bundle, input, original, plan, publicJwks, raw };
});

it.effect('renders the exact missing owner binding in the native runtime diagnostic without secret values', () =>
  Effect.gen(function* rendersMissingBinding() {
    const { bundle, input } = yield* fixture;
    const error = yield* prepareStageReleaseSecrets({
      ...input,
      bundle: Redacted.make(
        JSON.stringify({
          ...bundle,
          crm: withoutKey(bundle.crm, 'ONTOS_CRM_PARTY_INTAKE_API_KEY'),
        }),
      ),
    }).pipe(Effect.flip);
    const rendered = Cause.pretty(Cause.fail(error));
    expect(rendered).toContain('reason=binding-invalid');
    expect(rendered).toContain('appId=crm');
    expect(rendered).toContain('binding=ONTOS_CRM_PARTY_INTAKE_API_KEY');
    for (const forbidden of [PRIVATE_AUTH, WORKLOAD_KEY, SHARED_KEY, privateKey, SHELL_URL]) {
      expect(rendered).not.toContain(forbidden);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it('renders configuration failures without inventing an owner or binding', () => {
  const error = new StageReleaseSecretPreparationError({ reason: 'configuration-invalid' });
  expect(error.message).toBe('reason=configuration-invalid');
});

it.effect('preserves an owner with no configured outbound gateway client without inventing a credential', () =>
  Effect.gen(function* preservesUnconfiguredGatewayClient() {
    const { bundle, input, original } = yield* fixture;
    const existing = {
      ...original,
      [MARKET_CATALOG]: withoutKey(
        withoutKey(bundle[MARKET_CATALOG], 'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY'),
        'ONTOS_SHELL_GATEWAY_BASE_URL',
      ),
    };
    const result = yield* prepareStageReleaseSecrets({
      ...input,
      bundle: Redacted.make(JSON.stringify(existing)),
    });
    const prepared = decodeBundle(Redacted.value(result.bundle));
    expect(prepared[MARKET_CATALOG]).toEqual(existing[MARKET_CATALOG]);
    expect(prepared[MARKET_CATALOG]).not.toHaveProperty('ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY');
    expect(prepared[MARKET_CATALOG]).not.toHaveProperty('ONTOS_SHELL_GATEWAY_BASE_URL');
    expect(result.repairedProjects).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('preserves Pricing native unavailable issuers without inventing a caller credential', () =>
  Effect.gen(function* preservesUnconfiguredPricingClient() {
    const { bundle, input } = yield* fixture;
    const pricing = withoutKey(
      withoutKey(bundle.pricing, 'ONTOS_PRICING_GATEWAY_API_KEY'),
      'ONTOS_SHELL_GATEWAY_BASE_URL',
    );
    const result = yield* prepareStageReleaseSecrets({
      ...input,
      bundle: Redacted.make(JSON.stringify({ ...bundle, pricing })),
    });
    expect(decodeBundle(Redacted.value(result.bundle)).pricing).toEqual(pricing);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('preserves CRM native destination derivation from its trusted issuer while retaining its own key', () =>
  Effect.gen(function* preservesCrmIssuerDestination() {
    const { bundle, input } = yield* fixture;
    const crm = withoutKey(bundle.crm, 'ONTOS_SHELL_GATEWAY_BASE_URL');
    const result = yield* prepareStageReleaseSecrets({
      ...input,
      bundle: Redacted.make(JSON.stringify({ ...bundle, crm })),
    });
    expect(decodeBundle(Redacted.value(result.bundle)).crm).toEqual(crm);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('derives the CRM issuer, so a stored foreign issuer never becomes its destination fallback', () =>
  Effect.gen(function* derivesCrmIssuer() {
    const { bundle, input } = yield* fixture;
    const crm = { ...withoutKey(bundle.crm, 'ONTOS_SHELL_GATEWAY_BASE_URL'), ONTOS_GATEWAY_ISSUER: FOREIGN_ORIGIN };
    const result = yield* prepareStageReleaseSecrets({
      ...input,
      bundle: Redacted.make(JSON.stringify({ ...bundle, crm })),
    });
    expect(decodeBundle(Redacted.value(result.bundle)).crm).toEqual({ ...crm, ONTOS_GATEWAY_ISSUER: SHELL_URL });
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const binding of ['ONTOS_GATEWAY_PUBLIC_JWKS', 'SPICEDB_PRESHARED_KEY', 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT']) {
  it.effect(
    `still requires the owner foundation binding ${binding} when no outbound gateway client is configured`,
    () =>
      Effect.gen(function* requiresFoundationBinding() {
        const { bundle, input } = yield* fixture;
        const owner = withoutKey(
          withoutKey(bundle[MARKET_CATALOG], 'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY'),
          'ONTOS_SHELL_GATEWAY_BASE_URL',
        );
        const error = yield* prepareStageReleaseSecrets({
          ...input,
          bundle: Redacted.make(JSON.stringify({ ...bundle, [MARKET_CATALOG]: withoutKey(owner, binding) })),
        }).pipe(Effect.flip);
        expect(error.reason).toBe(BINDING_INVALID);
        expect(error.appId).toBe(MARKET_CATALOG);
        expect(error.binding).toBe(binding);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect('derives every owner foundation host binding the stored bundle leaves out', () =>
  Effect.gen(function* derivesFoundationBindings() {
    const { bundle, input } = yield* fixture;
    const owner = withoutKey(withoutKey(bundle.catalog, 'ONTOS_GATEWAY_ISSUER'), 'SPICEDB_ENDPOINT');
    const result = yield* prepareStageReleaseSecrets({
      ...input,
      bundle: Redacted.make(JSON.stringify({ ...bundle, catalog: owner })),
    });
    expect(decodeBundle(Redacted.value(result.bundle)).catalog).toEqual(bundle.catalog);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const [owner, binding] of [
  [MARKET_CATALOG, 'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY'],
  ['pricing', 'ONTOS_PRICING_GATEWAY_API_KEY'],
] as const) {
  it.effect(`derives the gateway base URL of a configured ${owner} client`, () =>
    Effect.gen(function* derivesGatewayBaseUrl() {
      const { bundle, input } = yield* fixture;
      const stored = withoutKey(bundle[owner], 'ONTOS_SHELL_GATEWAY_BASE_URL');
      expect(stored).toHaveProperty(binding);
      const result = yield* prepareStageReleaseSecrets({
        ...input,
        bundle: Redacted.make(JSON.stringify({ ...bundle, [owner]: stored })),
      });
      expect(decodeBundle(Redacted.value(result.bundle))[owner]).toEqual({
        ...stored,
        ONTOS_SHELL_GATEWAY_BASE_URL: SHELL_API,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const binding of ['ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY']) {
  it.effect(`rejects a partially configured owner gateway client with missing ${binding}`, () =>
    Effect.gen(function* rejectsPartialGatewayClient() {
      const { bundle, input } = yield* fixture;
      const error = yield* prepareStageReleaseSecrets({
        ...input,
        bundle: Redacted.make(
          JSON.stringify({
            ...bundle,
            [MARKET_CATALOG]: withoutKey(bundle[MARKET_CATALOG], binding),
          }),
        ),
      }).pipe(Effect.flip);
      expect(error.reason).toBe(BINDING_INVALID);
      expect(error.appId).toBe(MARKET_CATALOG);
      expect(error.binding).toBe(binding);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const binding of ['ONTOS_PRICING_GATEWAY_API_KEY']) {
  it.effect(`rejects a partially configured Pricing client with missing ${binding}`, () =>
    Effect.gen(function* rejectsPartialPricingClient() {
      const { bundle, input } = yield* fixture;
      const error = yield* prepareStageReleaseSecrets({
        ...input,
        bundle: Redacted.make(JSON.stringify({ ...bundle, pricing: withoutKey(bundle.pricing, binding) })),
      }).pipe(Effect.flip);
      expect(error.reason).toBe(BINDING_INVALID);
      expect(error.appId).toBe('pricing');
      expect(error.binding).toBe(binding);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect('still requires the configured Commerce enrollment client instead of disabling it', () =>
  Effect.gen(function* requiresEnrollmentClient() {
    const { bundle, input } = yield* fixture;
    const owner = withoutKey(
      withoutKey(bundle['commerce-customer-context'], 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
      'ONTOS_SHELL_GATEWAY_BASE_URL',
    );
    const error = yield* prepareStageReleaseSecrets({
      ...input,
      bundle: Redacted.make(JSON.stringify({ ...bundle, 'commerce-customer-context': owner })),
    }).pipe(Effect.flip);
    expect(error.reason).toBe(BINDING_INVALID);
    expect(error.appId).toBe('commerce-customer-context');
    expect(error.binding).toBe('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('adds the exact five native Projects bindings and the derived hosts while keeping every stored secret', () =>
  Effect.gen(function* addsProjectsAndHosts() {
    const { bundle, input, original, plan, publicJwks } = yield* fixture;
    const prepared = yield* prepareStageReleaseSecrets(input);
    expect(prepared.repairedProjects).toBe(true);
    const result = Redacted.value(prepared.bundle);
    const decoded = decodeBundle(result);
    expect(withoutKey(decoded, PROJECTS)).toEqual({
      ...original,
      'commerce-customer-context': { ...bundle['commerce-customer-context'], ...COMMERCE_HOST_BINDINGS },
      [SHELL]: { ...original[SHELL], ...SHELL_HOST_BINDINGS },
    });
    expect(decoded['retained-unserved-owner']).toEqual({ EXTRA_BINDING: 'exact\nbyte\\value' });
    expect(decoded.projects).toEqual({
      ONTOS_GATEWAY_ISSUER: SHELL_URL,
      ONTOS_GATEWAY_PUBLIC_JWKS: Redacted.value(publicJwks),
      SPICEDB_ENDPOINT: SPICEDB_HOST,
      SPICEDB_PRESHARED_KEY: SHARED_KEY,
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    });
    const unit = input.units.find(({ id }) => id === PROJECTS);
    const nativeNames = Arr.sortWith(Object.keys(plan.get(unit?.workerName ?? '') ?? {}), (key) => key, Order.String);
    expect(nativeNames).toEqual(Arr.sortWith(PROJECTS_RELEASE_SECRET_KEYS, (key) => key, Order.String));
    expect(nativeNames).toHaveLength(5);
    const projectsText = JSON.stringify(decoded.projects);
    const privateFields = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(
      privateKey,
    );
    for (const forbidden of [
      PRIVATE_AUTH,
      WORKLOAD_KEY,
      privateKey,
      privateFields.d,
      'owner-name-projection-only',
      'ONTOS_GATEWAY_PRIVATE_JWK',
      'BETTER_AUTH_SECRET',
    ]) {
      expect(projectsText).not.toContain(forbidden);
    }
    const second = yield* prepareStageReleaseSecrets({ ...input, bundle: prepared.bundle });
    expect(second.repairedProjects).toBe(false);
    expect(Redacted.value(second.bundle)).toBe(result);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('replaces every stored host binding with the stage edge config, Projects included', () =>
  Effect.gen(function* replacesStoredHosts() {
    const { bundle, input } = yield* fixture;
    const foreign = derivedHostBindings({
      ...EDGE,
      emailSender: `noreply@ontos-stage.${FOREIGN_ZONE}`,
      shellHostname: `ontos-stage.${FOREIGN_ZONE}`,
      spicedbHostname: `ontos-stage-spicedb.${FOREIGN_ZONE}`,
      storefrontHostname: `ontos-stage-akros.${FOREIGN_ZONE}`,
      zone: FOREIGN_ZONE,
    });
    const foreignByKey = new Map<string, string>(Object.entries(foreign));
    const stale = Object.fromEntries(
      Object.entries(bundle).map(([id, owner]) => [
        id,
        Object.fromEntries(Object.entries(owner).map(([key, value]) => [key, foreignByKey.get(key) ?? value])),
      ]),
    );
    const stored = {
      ...stale,
      'commerce-customer-context': { ...stale['commerce-customer-context'], COMMERCE_PORTAL_AUTH_URL: FOREIGN_ORIGIN },
      [SHELL]: { ...stale[SHELL], ONTOS_EMAIL_FROM: `noreply@ontos-stage.${FOREIGN_ZONE}` },
    };
    const result = yield* prepareStageReleaseSecrets({ ...input, bundle: Redacted.make(JSON.stringify(stored)) });
    expect(result.repairedProjects).toBe(false);
    const prepared = decodeBundle(Redacted.value(result.bundle));
    expect(Redacted.value(result.bundle)).not.toContain(FOREIGN_ZONE);
    expect(prepared).toEqual({
      ...bundle,
      'commerce-customer-context': { ...bundle['commerce-customer-context'], ...COMMERCE_HOST_BINDINGS },
      [SHELL]: { ...bundle[SHELL], ...SHELL_HOST_BINDINGS },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const binding of PROJECTS_RELEASE_SECRET_KEYS.filter((key) => !isDerivedHostBinding(key))) {
  it.effect(`rejects a conflicting supplied Projects ${binding} without replacing it`, () =>
    Effect.gen(function* rejectsProjectsConflict() {
      const { bundle, input } = yield* fixture;
      const raw = JSON.stringify({ ...bundle, projects: { ...bundle.projects, [binding]: CONFLICTING_VALUE } });
      const error = yield* prepareStageReleaseSecrets({ ...input, bundle: Redacted.make(raw) }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(StageReleaseSecretPreparationError);
      expect(error.reason).toBe('projects-conflict');
      expect(JSON.stringify(error)).not.toContain(CONFLICTING_VALUE);
      expect(Redacted.value(input.bundle)).not.toContain(CONFLICTING_VALUE);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect(
  'accepts a stored Projects entry that omits its derived hosts and fills them from the stage edge config',
  () =>
    Effect.gen(function* acceptsHostFreeProjects() {
      const { bundle, input } = yield* fixture;
      const hostFree = Object.fromEntries(
        Object.entries(bundle[PROJECTS] ?? {}).filter(([key]) => !isDerivedHostBinding(key)),
      );
      expect(Object.keys(hostFree)).toHaveLength(3);
      const result = yield* prepareStageReleaseSecrets({
        ...input,
        bundle: Redacted.make(JSON.stringify({ ...bundle, [PROJECTS]: hostFree })),
      });
      expect(result.repairedProjects).toBe(false);
      expect(decodeBundle(Redacted.value(result.bundle))[PROJECTS]).toEqual({
        ...hostFree,
        ONTOS_GATEWAY_ISSUER: SHELL_URL,
        SPICEDB_ENDPOINT: SPICEDB_HOST,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

for (const binding of PROJECTS_RELEASE_SECRET_KEYS.filter((key) => !isDerivedHostBinding(key))) {
  it.effect(`rejects a stored Projects entry missing its ${binding}`, () =>
    Effect.gen(function* rejectsIncompleteProjects() {
      const { bundle, input } = yield* fixture;
      const raw = JSON.stringify({ ...bundle, [PROJECTS]: withoutKey(bundle[PROJECTS] ?? {}, binding) });
      const error = yield* prepareStageReleaseSecrets({ ...input, bundle: Redacted.make(raw) }).pipe(Effect.flip);
      expect(error.reason).toBe('projects-conflict');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

interface InvalidBundleExample {
  readonly input: (source: Effect.Success<typeof fixture>) => string;
  readonly name: string;
}
const invalidBundles: readonly InvalidBundleExample[] = [
  { input: ({ bundle }) => JSON.stringify(withoutKey(bundle, SHELL)), name: 'missing Shell' },
  { input: ({ bundle }) => JSON.stringify(withoutKey(bundle, 'crm')), name: 'missing existing served owner' },
  { input: ({ bundle }) => JSON.stringify({ ...bundle, projects: {} }), name: 'empty supplied Projects' },
  { input: ({ bundle }) => JSON.stringify({ ...bundle, projects: null }), name: 'null supplied Projects' },
  { input: ({ bundle }) => JSON.stringify({ ...bundle, projects: [] }), name: 'array supplied Projects' },
  {
    input: ({ bundle }) =>
      JSON.stringify({ ...bundle, projects: { ...bundle.projects, ONTOS_GATEWAY_PRIVATE_JWK: privateKey } }),
    name: 'supplied Projects includes a foreign-owner key',
  },
  {
    input: ({ bundle }) =>
      JSON.stringify({ ...bundle, [SHELL]: { ...bundle[SHELL], SPICEDB_PRESHARED_KEY: 'REDACTED' } }),
    name: 'masked canonical shared key',
  },
  {
    input: ({ bundle }) =>
      JSON.stringify({ ...bundle, [SHELL]: { ...bundle[SHELL], ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' } }),
    name: 'foreign canonical environment',
  },
  {
    input: ({ bundle }) =>
      JSON.stringify({ ...bundle, [SHELL]: { ...bundle[SHELL], ONTOS_GATEWAY_PRIVATE_JWK: `${PRIVATE_AUTH}{` } }),
    name: 'invalid canonical signing key',
  },
  {
    input: ({ bundle }) =>
      JSON.stringify({
        ...bundle,
        [SHELL]: {
          ...bundle[SHELL],
          ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({
            ...generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
            alg: 'EdDSA',
            kid: 'test-key',
            use: 'sig',
            x: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x,
          }),
        },
      }),
    name: 'mismatched private and public components',
  },
  { input: () => `{"${PRIVATE_AUTH}":`, name: 'malformed JSON' },
  { input: () => 'null', name: 'null JSON' },
  { input: () => '[]', name: 'array JSON' },
  {
    input: ({ raw }) => raw.replace('"SPICEDB_ENDPOINT":', '"SPICEDB_ENDPOINT":"hidden-value","SPICEDB_ENDPOINT":'),
    name: 'duplicate binding',
  },
  {
    input: ({ raw }) =>
      raw.replace('"SPICEDB_ENDPOINT":', String.raw`"SPICEDB_\u0045NDPOINT":"hidden-value","SPICEDB_ENDPOINT":`),
    name: 'escaped duplicate binding',
  },
  { input: ({ raw }) => raw.replace(`"${SHELL}":`, `"${SHELL}":{},"${SHELL}":`), name: 'duplicate owner' },
];
for (const example of invalidBundles) {
  it.effect(`fails closed on ${example.name} with sanitized typed diagnostics`, () =>
    Effect.gen(function* rejectsUnsafeBundle() {
      const source = yield* fixture;
      const error = yield* prepareStageReleaseSecrets({
        ...source.input,
        bundle: Redacted.make(example.input(source)),
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(StageReleaseSecretPreparationError);
      const diagnostic = JSON.stringify(error);
      for (const forbidden of [PRIVATE_AUTH, WORKLOAD_KEY, SHARED_KEY, privateKey, 'hidden-value', 'foreign.invalid']) {
        expect(diagnostic).not.toContain(forbidden);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const edge of [
  { ...EDGE, zone: 'foreign.test' },
  { ...EDGE, shellHostname: 'ontos-stage.foreign.test' },
  { ...EDGE, storefrontHostname: 'ontos-stage-akros.foreign.test' },
  { ...EDGE, spicedbHostname: 'ontos-stage-spicedb.foreign.test' },
]) {
  it.effect(`requires declared native stage origins: ${JSON.stringify(edge)}`, () =>
    Effect.gen(function* rejectsInvalidOrigins() {
      const { input } = yield* fixture;
      const error = yield* prepareStageReleaseSecrets({ ...input, edge }).pipe(Effect.flip);
      expect(error.reason).toBe('origin-invalid');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect('refuses incomplete or duplicate served topology before preparing anything', () =>
  Effect.gen(function* rejectsInvalidInventory() {
    const { input } = yield* fixture;
    const missing = yield* prepareStageReleaseSecrets({
      ...input,
      units: input.units.filter(({ id }) => id !== PROJECTS),
    }).pipe(Effect.flip);
    expect(missing.reason).toBe('inventory-invalid');
    const duplicate = yield* prepareStageReleaseSecrets({
      ...input,
      units: [...input.units, ...input.units],
    }).pipe(Effect.flip);
    expect(duplicate.reason).toBe('inventory-invalid');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('writes only a new private runner-owned file and never overwrites existing content', () =>
  Effect.scoped(
    Effect.gen(function* writesPrivateFile() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'prepared-release-test-' });
      const directory = `${root}/stage-release-secrets.test`;
      yield* fs.makeDirectory(directory, { mode: 0o700 });
      const file = `${directory}/bundle.json`;
      const contents = Redacted.make('synthetic-private-file');
      yield* writePreparedStageReleaseSecrets(file, root, contents);
      expect((yield* fs.stat(file)).mode % 0o1000).toBe(0o600);
      expect(yield* fs.readFileString(file)).toBe(Redacted.value(contents));
      const overwrite = yield* writePreparedStageReleaseSecrets(file, root, Redacted.make('replacement')).pipe(
        Effect.flip,
      );
      expect(overwrite.reason).toBe('output-write-failed');
      expect(yield* fs.readFileString(file)).toBe(Redacted.value(contents));
      const outside = yield* writePreparedStageReleaseSecrets(`${root}/bundle.json`, root, contents).pipe(Effect.flip);
      expect(outside.reason).toBe('output-invalid');
      expect(yield* fs.exists(`${root}/bundle.json`)).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('removes its exact partial file after an injected write failure and preserves unrelated files', () =>
  Effect.scoped(
    Effect.gen(function* cleansPartialFile() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'prepared-release-failure-' });
      const directory = `${root}/stage-release-secrets.test`;
      yield* fs.makeDirectory(directory);
      const file = `${directory}/bundle.json`;
      const unrelated = `${root}/unrelated.txt`;
      yield* fs.writeFileString(unrelated, 'preserved');
      const failing = {
        ...fs,
        open: (location: string, options?: Parameters<typeof fs.open>[1]) =>
          fs.open(location, options).pipe(
            Effect.map((handle) => ({
              ...handle,
              writeAll: () => fs.readFileString(`${root}/missing-file`).pipe(Effect.asVoid),
            })),
          ),
      };
      const error = yield* writePreparedStageReleaseSecrets(file, root, Redacted.make(PRIVATE_AUTH)).pipe(
        Effect.provideService(FileSystem.FileSystem, failing),
        Effect.flip,
      );
      expect(error.reason).toBe('output-write-failed');
      expect(yield* fs.exists(file)).toBe(false);
      expect(yield* fs.readFileString(unrelated)).toBe('preserved');
      expect(JSON.stringify(error)).not.toContain(PRIVATE_AUTH);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
