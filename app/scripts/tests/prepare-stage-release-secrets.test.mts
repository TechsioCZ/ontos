import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Array as Arr, Cause, Effect, FileSystem, Order, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApplicationReleaseIntentSchema } from '../application-release-intent.mts';
import { gatewayPublicJwksFor, workerSecretPlan } from '../ops/cloudflare-stage-cutover.mts';
import { readEdgeUnits } from '../ops/stage-edge-units.mts';
import {
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
const SPICEDB_HOSTNAME = 'custom-spicedb.example.test';
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
      spicedbHostname: SPICEDB_HOSTNAME,
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
  const input: StageReleaseSecretInput = {
    bundle: Redacted.make(raw),
    intent,
    shellUrl: SHELL_URL,
    spicedbHostname: SPICEDB_HOSTNAME,
    stageZone: STAGE_ZONE,
    units,
  };
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
      'commerce-market-catalog': withoutKey(
        withoutKey(bundle['commerce-market-catalog'], 'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY'),
        'ONTOS_SHELL_GATEWAY_BASE_URL',
      ),
    };
    const result = yield* prepareStageReleaseSecrets({
      ...input,
      bundle: Redacted.make(JSON.stringify(existing)),
    });
    const prepared = decodeBundle(Redacted.value(result.bundle));
    expect(withoutKey(prepared, PROJECTS)).toEqual(existing);
    expect(prepared['commerce-market-catalog']).not.toHaveProperty('ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY');
    expect(prepared['commerce-market-catalog']).not.toHaveProperty('ONTOS_SHELL_GATEWAY_BASE_URL');
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

it.effect('never treats a foreign CRM issuer as the trusted destination fallback', () =>
  Effect.gen(function* rejectsForeignCrmDestination() {
    const { bundle, input } = yield* fixture;
    const crm = {
      ...withoutKey(bundle.crm, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
      ONTOS_GATEWAY_ISSUER: 'https://foreign.invalid',
    };
    const error = yield* prepareStageReleaseSecrets({
      ...input,
      bundle: Redacted.make(JSON.stringify({ ...bundle, crm })),
    }).pipe(Effect.flip);
    expect(error.reason).toBe(BINDING_INVALID);
    expect(error.appId).toBe('crm');
    expect(error.binding).toBe('ONTOS_SHELL_GATEWAY_BASE_URL');
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const binding of [
  'ONTOS_GATEWAY_ISSUER',
  'ONTOS_GATEWAY_PUBLIC_JWKS',
  'SPICEDB_ENDPOINT',
  'SPICEDB_PRESHARED_KEY',
  'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
]) {
  it.effect(
    `still requires the owner foundation binding ${binding} when no outbound gateway client is configured`,
    () =>
      Effect.gen(function* requiresFoundationBinding() {
        const { bundle, input } = yield* fixture;
        const owner = withoutKey(
          withoutKey(bundle['commerce-market-catalog'], 'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY'),
          'ONTOS_SHELL_GATEWAY_BASE_URL',
        );
        const error = yield* prepareStageReleaseSecrets({
          ...input,
          bundle: Redacted.make(JSON.stringify({ ...bundle, 'commerce-market-catalog': withoutKey(owner, binding) })),
        }).pipe(Effect.flip);
        expect(error.reason).toBe(BINDING_INVALID);
        expect(error.appId).toBe('commerce-market-catalog');
        expect(error.binding).toBe(binding);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const binding of ['ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY', 'ONTOS_SHELL_GATEWAY_BASE_URL']) {
  it.effect(`rejects a partially configured owner gateway client with missing ${binding}`, () =>
    Effect.gen(function* rejectsPartialGatewayClient() {
      const { bundle, input } = yield* fixture;
      const error = yield* prepareStageReleaseSecrets({
        ...input,
        bundle: Redacted.make(
          JSON.stringify({
            ...bundle,
            'commerce-market-catalog': withoutKey(bundle['commerce-market-catalog'], binding),
          }),
        ),
      }).pipe(Effect.flip);
      expect(error.reason).toBe(BINDING_INVALID);
      expect(error.appId).toBe('commerce-market-catalog');
      expect(error.binding).toBe(binding);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const binding of ['ONTOS_PRICING_GATEWAY_API_KEY', 'ONTOS_SHELL_GATEWAY_BASE_URL']) {
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

it.effect('adds only the exact five native Projects bindings while retaining every original JSON byte', () =>
  Effect.gen(function* addsProjectsOnly() {
    const { input, original, plan, publicJwks, raw } = yield* fixture;
    const prepared = yield* prepareStageReleaseSecrets(input);
    expect(prepared.repairedProjects).toBe(true);
    const result = Redacted.value(prepared.bundle);
    const decoded = decodeBundle(result);
    expect(withoutKey(decoded, PROJECTS)).toEqual(original);
    const closingBrace = raw.lastIndexOf('}');
    expect(result.startsWith(raw.slice(0, closingBrace))).toBe(true);
    expect(result.endsWith(raw.slice(closingBrace))).toBe(true);
    expect(decoded.projects).toEqual({
      ONTOS_GATEWAY_ISSUER: SHELL_URL,
      ONTOS_GATEWAY_PUBLIC_JWKS: Redacted.value(publicJwks),
      SPICEDB_ENDPOINT: SPICEDB_HOSTNAME,
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

it.effect('returns an already complete and matching supplied bundle byte-for-byte without replacement', () =>
  Effect.gen(function* preservesSuppliedProjects() {
    const { bundle, input } = yield* fixture;
    const raw = `\n${JSON.stringify(bundle, null, 4)} \n`;
    const result = yield* prepareStageReleaseSecrets({ ...input, bundle: Redacted.make(raw) });
    expect(result.repairedProjects).toBe(false);
    expect(Redacted.value(result.bundle)).toBe(raw);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const binding of PROJECTS_RELEASE_SECRET_KEYS) {
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
      JSON.stringify({ ...bundle, [SHELL]: { ...bundle[SHELL], SPICEDB_ENDPOINT: 'arbitrary.invalid' } }),
    name: 'non-native canonical endpoint',
  },
  {
    input: ({ bundle }) =>
      JSON.stringify({ ...bundle, [SHELL]: { ...bundle[SHELL], ONTOS_GATEWAY_ISSUER: 'https://foreign.invalid' } }),
    name: 'foreign canonical issuer',
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

for (const origins of [
  { shellUrl: SHELL_URL, stageZone: '' },
  { shellUrl: SHELL_URL, stageZone: 'foreign.test' },
  { shellUrl: 'http://ontos-stage.example.test', stageZone: STAGE_ZONE },
  { shellUrl: `${SHELL_URL}/path`, stageZone: STAGE_ZONE },
  { shellUrl: `${SHELL_URL}:8443`, stageZone: STAGE_ZONE },
  { shellUrl: 'https://credential@ontos-stage.example.test', stageZone: STAGE_ZONE },
]) {
  it.effect(`requires declared native stage origins: ${JSON.stringify(origins)}`, () =>
    Effect.gen(function* rejectsInvalidOrigins() {
      const { input } = yield* fixture;
      const error = yield* prepareStageReleaseSecrets({ ...input, ...origins }).pipe(Effect.flip);
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
