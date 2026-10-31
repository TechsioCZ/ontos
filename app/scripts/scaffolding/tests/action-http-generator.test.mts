import { NodeServices } from '@effect/platform-node';
import { Cause, Effect, Exit, Option, Predicate, Schema, SchemaAST } from 'effect';
import { expect, it } from 'effect-rstest';
import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runScaffoldEffect } from '../cli.mts';
import { snapshotTree, write } from './fixture-files.mts';
import { linkFixtureDependencies, withCreatedFixture } from './fixture-ownership.mts';
import type { JsonValue, OntosVerticalMetadata } from '../shared.mts';

import {
  decodeActionRegistration,
  inspectAction,
  patchRuntimeRoot,
  renderActionHttpClient,
  renderActionHttpContract,
  renderActionHttpProblems,
} from '../action-http/scaffold.mts';
import {
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_END,
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END,
  createOrUpdateOwnedGeneratedMutationEffect,
  generatedSlotContainsExactEntry,
  readGeneratedSlotEntries,
} from '../shared.mts';

const OWNER_SLUG = 'pricing-policy';
const OWNER_DIRECTORY = `verticals/${OWNER_SLUG}`;
const OWNER_PACKAGE = '@app/pricing-policy';
const OWNER_PACKAGE_PATH = `${OWNER_DIRECTORY}/package.json`;
const PUBLIC_ACTION_PATH = `${OWNER_DIRECTORY}/shared/actions/change-rate.ts`;
const PRIVATE_ACTION_PATH = `${OWNER_DIRECTORY}/src/actions/change-rate.action.ts`;
const CLIENT_EXPORT = './api/client';
const CLIENT_ANCHOR = "export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';";
const VERTICAL_FLAG = '--vertical';
const FIXTURE_ACTION = 'change-rate';
const RUNTIME_ROOT_PATH = 'api/index.ts';
const ACTION_HTTP_COMMAND = 'action-http';
const AUTHORIZATION_FLAG = '--authorization';
const NODE_MODULE_FLAG = '--input-type=module';
const SHARED_CLIENT_PREFIX = '../src/api/';
const OUTSIDE_CLIENT_PATH = 'outside-owner-client.ts';
const SCHEMA_MODULE_FLAG = '--schema-module';
const RESULT_SCHEMA_FLAG = '--result-schema';
const CANONICAL_SCHEMA_MODULE = 'shared/action-contracts.ts';
const NEXT_ACTION = 'revise-rate';

const vertical = {
  appId: OWNER_SLUG,
  directory: '/workspace/verticals/pricing-policy',
  manifestContent: '',
  manifestPath: '/workspace/verticals/pricing-policy/vertical.manifest.ts',
  moduleId: 'pricing.policy',
  packageContent: '{}',
  packageJson: {},
  packageName: OWNER_PACKAGE,
  packagePath: '/workspace/verticals/pricing-policy/package.json',
  registrationContent: '',
  registrationPath: '/workspace/verticals/pricing-policy/vertical.registration.ts',
  slug: OWNER_SLUG,
  topologyEntry: {},
} satisfies OntosVerticalMetadata;
const appRoot = path.resolve(import.meta.dirname, '../../..');

it('accepts callable Effect union domain schemas and rejects malformed schema descriptors', () => {
  const domainErrorSchema = Schema.Union([
    Schema.Struct({ _tag: Schema.Literal('ProductConflict'), code: Schema.Literal('product_conflict') }),
    Schema.Struct({ _tag: Schema.Literal('ProductUnavailable'), code: Schema.Literal('product_unavailable') }),
  ]);
  const descriptor = {
    actionKey: 'commerce.catalog.create-product',
    domainErrorSchema,
    idempotency: 'required',
    owningModuleKey: 'commerce.catalog',
    payloadSchema: Schema.Struct({ rate: Schema.Number }),
  };
  const valid = decodeActionRegistration({ createProductAction: { descriptor } }, 'createProductAction');
  expect(Option.isSome(valid)).toBe(true);
  if (Option.isSome(valid)) {
    expect(valid.value.descriptor.domainErrorSchema.ast).toEqual(domainErrorSchema.ast);
  }

  const invalid = decodeActionRegistration(
    { createProductAction: { descriptor: { ...descriptor, domainErrorSchema: { ast: 'not an AST' } } } },
    'createProductAction',
  );
  expect(Option.isNone(invalid)).toBe(true);
});

it('composes the production Action runtime with Node platform Crypto beside the database configuration', () => {
  const assemblerImport = "import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';";
  const runtimeRoot = [
    "import { DatabaseConfigLive } from '@app/core-runtime';",
    assemblerImport,
    "import { Layer } from '@modern-js/bff-effect/effect-edge';",
    "import { pricingPolicyReadRuntimeLive } from './pricing-policy-production-layers.ts';",
    '',
    'const productionReadRuntimeLive = pricingPolicyReadRuntimeLive.pipe(',
    '  Layer.provide(Layer.mergeAll(DatabaseConfigLive, NodeCrypto.layer)),',
    ');',
    'const handlers = Layer.mergeAll(',
    `  ${GOVERNED_HTTP_HANDLER_LAYER_SLOT_START}`,
    `  ${GOVERNED_HTTP_HANDLER_LAYER_SLOT_END}`,
    ');',
    '',
  ].join('\n');
  const patched = patchRuntimeRoot(runtimeRoot, vertical, 'changeRateActionApiLive');
  expect(patched).toContain(
    'const productionActionRuntimeLive = pricingPolicyActionRuntimeLive.pipe(\n  Layer.provide(Layer.mergeAll(DatabaseConfigLive, NodeCrypto.layer)),\n);\nconst productionReadRuntimeLive',
  );
  expect(patched).toContain(`import { NodeCrypto } from '@effect/platform-node';\n${assemblerImport}`);
  expect(patched).toContain(
    "import { pricingPolicyActionRuntimeLive, pricingPolicyReadRuntimeLive } from './pricing-policy-production-layers.ts';",
  );
  expect(patchRuntimeRoot(patched, vertical, 'changeRateActionApiLive')).toBe(patched);
  expect(() =>
    patchRuntimeRoot(runtimeRoot.replace(`${assemblerImport}\n`, ''), vertical, 'changeRateActionApiLive'),
  ).toThrow();
});

it('renders one exact typed Action endpoint and exhaustive domain mapping', () => {
  const action = FIXTURE_ACTION;
  const errors = [
    {
      code: 'manual_rate_conflict',
      discriminator: '_tag' as const,
      kind: 'conflict' as const,
      tag: 'ManualRateConflict',
      value: 'ManualRateConflict',
    },
    {
      code: 'manual_rate_unavailable',
      discriminator: '_tag' as const,
      kind: 'unavailable' as const,
      tag: 'ManualRateUnavailable',
      value: 'ManualRateUnavailable',
    },
  ];
  const contract = renderActionHttpContract(vertical, action, errors);
  const problems = renderActionHttpProblems(vertical, action, errors);
  expect(contract).toContain("HttpApiEndpoint.post('execute', '/pricing-policy/actions/change-rate'");
  expect(contract).not.toMatch(/actions\/:|catch-all|generic/u);
  expect(contract).toContain('ChangeRatePayloadSchema');
  expect(contract).toContain('ChangeRateResultSchema');
  expect(contract).toContain("export { ChangeRatePayloadSchema } from '../actions/change-rate.ts'");
  expect(contract).not.toContain('export { ChangeRatePayloadSchema, ChangeRateResultSchema }');
  expect(contract).not.toContain('export const ChangeRateActionHeadersSchema');
  expect(problems).not.toContain('jscpd:ignore-start');
  expect(problems).not.toContain('jscpd:ignore-end');
  expect(problems).toContain('Match.tags({');
  expect(problems).toContain("ManualRateConflict: () => changeRateActionProblem.conflict('manual_rate_conflict')");
  expect(problems).toContain('Match.exhaustive');
});

it('renders exact secondary reason-code mappings without collapsing HTTP semantics', () => {
  const errors = [
    {
      code: 'fulfillment_request_rejected',
      discriminator: 'reasonCode' as const,
      kind: 'conflict' as const,
      tag: 'FulfillmentRequestRejected',
      value: 'REQUEST_CONFLICT',
    },
    {
      code: 'fulfillment_request_rejected',
      discriminator: 'reasonCode' as const,
      kind: 'rateLimited' as const,
      tag: 'FulfillmentRequestRejected',
      value: 'RATE_LIMITED',
    },
    {
      code: 'fulfillment_request_rejected',
      discriminator: 'reasonCode' as const,
      kind: 'ineligible' as const,
      tag: 'FulfillmentRequestRejected',
      value: 'REQUEST_NOT_ELIGIBLE',
    },
  ];
  const contract = renderActionHttpContract(vertical, 'submit-fulfillment-request', errors);
  const problems = renderActionHttpProblems(vertical, 'submit-fulfillment-request', errors);

  expect(contract).not.toMatch(/headers:|HeadersSchema/u);
  expect(contract).toContain("SubmitFulfillmentRequestActionConflictProblem', 409");
  expect(contract).toContain("SubmitFulfillmentRequestActionRateLimitedProblem', 429");
  expect(contract).toContain("SubmitFulfillmentRequestActionIneligibleProblem', 422");
  expect(problems).toContain("'REQUEST_CONFLICT': { code: 'fulfillment_request_rejected', kind: 'conflict' }");
  expect(problems).toContain("'RATE_LIMITED': { code: 'fulfillment_request_rejected', kind: 'rateLimited' }");
  expect(problems).toContain('fulfillmentRequestRejectedProblemByReasonCode[failure.reasonCode]');
});

it('renders required idempotency and governed assertion acquisition in the Action client', () => {
  const client = renderActionHttpClient(vertical, FIXTURE_ACTION, true);
  expect(client).toContain('readonly idempotencyKey: string;');
  expect(client).toContain('operationGateway.invoke(');
  expect(client).toContain('(credential, { apiBaseUrl, compositionRevision }) =>');
  expect(client).toContain('readonly compositionRevision?: string;');
  expect(client).toContain('baseUrl: apiBaseUrl,');
  expect(client).toContain('...options,\n    baseUrl: apiBaseUrl,\n    compositionRevision,');
  expect(client).toContain('idempotencyKey: options.idempotencyKey,');
  expect(client).toContain('client.changeRateAction.execute({ payload: encoded })');
  expect(client).not.toContain('headers:');
  expect(client).toContain("defaultApiPrefix: '/pricing-policy-api'");
});

it('renders exhaustive Match narrowing for discriminated-union Action payloads', () => {
  const payloadSchema = Schema.Union([
    Schema.Struct({ operation: Schema.Literal('RESERVE'), reason: Schema.String }),
    Schema.Struct({ operation: Schema.Literal('COMMIT'), reservationToken: Schema.String }),
    Schema.Struct({ operation: Schema.Literal('RELEASE'), reservationToken: Schema.String }),
  ]);
  const client = renderActionHttpClient(vertical, 'reserve-market-retirement', true, payloadSchema);

  expect(client).toContain("import { Effect, Match, Redacted, Schema } from 'effect';");
  expect(client).toContain("Match.when({ operation: 'COMMIT' }, (commitPayload) =>");
  expect(client).toContain("Match.when({ operation: 'RELEASE' }, (releasePayload) =>");
  expect(client).toContain("Match.when({ operation: 'RESERVE' }, (reservePayload) =>");
  expect(client).toContain('Match.exhaustive');
  expect(client).not.toContain('payload: encoded,');
});

it.live(
  'accepts Action registrations with real Effect domain error Schemas',
  Effect.fn(function* acceptsRealDomainErrorSchema() {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-action-http-schema-')));
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { force: true, recursive: true })));
    yield* Effect.promise(() => symlink(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir'));
    const actionPath = path.join(root, 'valid-action.ts');
    yield* Effect.promise(() =>
      writeFile(
        actionPath,
        `import { Schema } from 'effect';

export class FixtureConflict extends Schema.TaggedError<FixtureConflict>()('FixtureConflict', {
  code: Schema.Literal('fixture_conflict'),
  reason: Schema.String,
}) {}

export class FixtureUnavailable extends Schema.TaggedError<FixtureUnavailable>()('FixtureUnavailable', {
  code: Schema.Literal('fixture_unavailable'),
  reason: Schema.String,
}) {}

export const validAction = {
  descriptor: {
    actionKey: 'fixture.valid-action',
    domainErrorSchema: Schema.Union([FixtureConflict, FixtureUnavailable]),
    idempotency: 'required',
    owningModuleKey: 'fixture',
    payloadSchema: Schema.Struct({ fixtureId: Schema.String }),
  },
};
`,
        'utf-8',
      ),
    );
    const inspected = yield* inspectAction(actionPath, 'validAction');
    expect(inspected.descriptor.actionKey).toBe('fixture.valid-action');
    expect(Predicate.isFunction(inspected.descriptor.domainErrorSchema)).toBe(true);
    expect(Schema.isSchema(inspected.descriptor.domainErrorSchema)).toBe(true);
    expect(SchemaAST.isAST(inspected.descriptor.domainErrorSchema.ast)).toBe(true);
  }),
);

it.live(
  'rejects Action registrations whose domain error value only imitates a Schema',
  Effect.fn(function* rejectsImitatedDomainErrorSchema() {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-action-http-invalid-schema-')));
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { force: true, recursive: true })));
    const actionPath = path.join(root, 'invalid-action.ts');
    yield* Effect.promise(() =>
      writeFile(
        actionPath,
        `export const invalidAction = {
  descriptor: {
    actionKey: 'fixture.invalid-action',
    domainErrorSchema: { ast: {} },
    idempotency: 'required',
    owningModuleKey: 'fixture',
    payloadSchema: { ast: {} },
  },
};
`,
        'utf-8',
      ),
    );

    const inspected = yield* Effect.exit(inspectAction(actionPath, 'invalidAction'));
    expect(Exit.isFailure(inspected)).toBe(true);
  }),
);

it.live(
  'updates only exactly owned generated artifacts and remains idempotent',
  Effect.fn(
    function* ownedGeneratedArtifactTest() {
      const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-action-http-')));
      const target = path.join(root, 'owned.ts');
      const header = '// @generated by OntOS Codesmith Action HTTP v1\n';
      const owns = (source: string) => source.startsWith(header);
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { force: true, recursive: true })));

      yield* Effect.promise(() => writeFile(target, `${header}export const stale = true;\n`, 'utf-8'));
      const update = yield* createOrUpdateOwnedGeneratedMutationEffect(
        target,
        `${header}export const current = true;\n`,
        owns,
      );
      expect(Option.isSome(update)).toBe(true);
      if (Option.isSome(update)) {
        const mutation = update.value;
        if (mutation.kind === 'update') {
          yield* Effect.promise(() => writeFile(target, mutation.content, 'utf-8'));
        }
      }
      const repeated = yield* createOrUpdateOwnedGeneratedMutationEffect(
        target,
        `${header}export const current = true;\n`,
        owns,
      );
      expect(Option.isNone(repeated)).toBe(true);

      yield* Effect.promise(() => writeFile(target, 'export const developerOwned = true;\n', 'utf-8'));
      const refused = yield* Effect.exit(
        createOrUpdateOwnedGeneratedMutationEffect(target, `${header}export const next = true;\n`, owns),
      );
      expect(Exit.isFailure(refused)).toBe(true);
      if (Exit.isFailure(refused)) {
        expect(String(Cause.squash(refused.cause))).toContain('refusing to overwrite');
      }
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

const jsonText = (value: JsonValue) => `${JSON.stringify(value, null, 2)}\n`;
const ownerPackage = (clientTarget: JsonValue, shared: boolean) => ({
  dependencies: {},
  exports: { './api': './shared/api.ts', [CLIENT_EXPORT]: clientTarget },
  modernjs: {
    apiRuntime: 'effect',
    appId: OWNER_SLUG,
    preset: 'presetUltramodern',
    role: shared ? 'api-only' : 'module-federation-remote',
    topology: '../../topology/reference-topology.json',
  },
  name: OWNER_PACKAGE,
  private: true,
  scripts: {
    build: 'modern build --deploy-target node && modern deploy --skip-build --deploy-target node',
    'cloudflare:build':
      'modern build --deploy-target cloudflare && modern deploy --skip-build --deploy-target cloudflare',
  },
  type: 'module',
  version: '0.1.0',
});
const ownerClientTarget = (shared: boolean) =>
  shared ? `./shared/${OWNER_SLUG}-client.ts` : `./src/api/${OWNER_SLUG}-client.ts`;
const scaffoldFixture = Effect.fn(function* scaffoldFixture(
  root: string,
  command: Parameters<typeof runScaffoldEffect>[0],
  args: readonly string[],
) {
  return yield* runScaffoldEffect(command, args, { workspaceRoot: root }).pipe(Effect.provide(NodeServices.layer));
});
const scaffoldHttp = (root: string) =>
  scaffoldFixture(root, ACTION_HTTP_COMMAND, [VERTICAL_FLAG, OWNER_SLUG, '--action', FIXTURE_ACTION]);
const initializePublishedClientFixture = (root: string, shared: boolean) =>
  Effect.gen(function* initializePublishedClientFixtureProgram() {
    yield* write(root, 'package.json', jsonText({ name: 'published-client-fixture', private: true, type: 'module' }));
    yield* write(root, OWNER_PACKAGE_PATH, jsonText(ownerPackage(ownerClientTarget(shared), shared)));
    yield* write(
      root,
      `${OWNER_DIRECTORY}/tsconfig.json`,
      jsonText({ compilerOptions: { composite: true }, include: ['src', 'shared'], references: [] }),
    );
    yield* write(
      root,
      'topology/reference-topology.json',
      jsonText({
        verticals: [
          {
            deliveryUnit: { buildMarker: 'published-client-fixture' },
            domain: 'pricing',
            id: OWNER_SLUG,
            kind: 'vertical',
            package: OWNER_PACKAGE,
            path: OWNER_DIRECTORY,
            ...(shared
              ? { renderer: 'none', surfaceProfile: 'api-only' }
              : { moduleFederation: { name: 'verticalPricingPolicy', role: 'remote' } }),
          },
        ],
      }),
    );
    if (!shared) {
      yield* write(root, `${OWNER_DIRECTORY}/module-federation.config.ts`, 'export default { exposes: {} };\n');
    }
    yield* write(
      root,
      `${OWNER_DIRECTORY}/shared/ultramodern-build.ts`,
      "export const ultramodernApiMarker = { appId: 'pricing-policy', buildMarker: 'published-client-fixture' };\nexport const ultramodernDeliveryUnit = { appId: 'pricing-policy', buildMarker: 'published-client-fixture' };\n",
    );
    yield* write(
      root,
      `${OWNER_DIRECTORY}/shared/api.ts`,
      `import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { Schema } from 'effect';
export const pricingPolicyApi = HttpApi.make('PricingPolicyApi').add(HttpApiGroup.make('fixture').add(
  HttpApiEndpoint.get('readiness', '/readiness', { success: Schema.Struct({ ok: Schema.Boolean }) }),
));
`,
    );
    yield* write(
      root,
      `${OWNER_DIRECTORY}/api/index.ts`,
      `import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectRuntimeLayer } from '@modern-js/bff-effect/effect-edge';
import { pricingPolicyApi } from '../shared/api.ts';
const handlers = HttpApiBuilder.group(pricingPolicyApi, 'fixture', handlers => handlers.handle('readiness', () => Effect.succeed({ ok: true })));
const layer = HttpApiBuilder.layer(pricingPolicyApi).pipe(
  Layer.provide(handlers),
) satisfies EffectRuntimeLayer;
export default defineEffectBff({ api: pricingPolicyApi, layer });
`,
    );
    yield* write(
      root,
      `${OWNER_DIRECTORY}/${ownerClientTarget(shared).slice(2)}`,
      `import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { pricingPolicyApi } from '${shared ? './api.ts' : '../../shared/api.ts'}';
${CLIENT_ANCHOR}
export const createPricingPolicyClient = options => makeEffectHttpApiClient(pricingPolicyApi, options);
`,
    );
    yield* linkFixtureDependencies(root, appRoot, {
      '@app/core-runtime': 'packages/core-runtime',
      '@app/gateway-principal-verifier': 'packages/gateway-principal-verifier',
      '@app/shared-contracts': 'packages/shared-contracts',
      '@effect/platform-node': 'node_modules/@effect/platform-node',
      '@modern-js/bff-effect': 'node_modules/@modern-js/bff-effect',
      effect: 'node_modules/effect',
    });
    yield* linkFixtureDependencies(root, root, { [OWNER_PACKAGE]: OWNER_DIRECTORY });
    yield* scaffoldFixture(root, 'module-contract', [VERTICAL_FLAG, OWNER_SLUG, '--module', 'pricing.policy']);
    const runtime = yield* Effect.promise(() => readFile(path.join(root, OWNER_DIRECTORY, RUNTIME_ROOT_PATH), 'utf-8'));
    expect(runtime).toContain("handlers.handle('readiness'");
    expect(runtime).toContain(') satisfies EffectRuntimeLayer;');
    expect(runtime).toContain('governedReadApiHandlersLive');
    expect(runtime).toContain('GovernedReadLayer.provide(governedReadApiHandlersLive)');
    yield* scaffoldFixture(root, 'action', [
      VERTICAL_FLAG,
      OWNER_SLUG,
      '--action',
      FIXTURE_ACTION,
      '--legal-entity-scope',
      'required',
      AUTHORIZATION_FLAG,
      'action_execution',
      '--provisioning',
      'explicit',
    ]);
    // A generated Action starts the artifact. Its public schemas are then owned once and imported by the private descriptor.
    yield* write(
      root,
      PUBLIC_ACTION_PATH,
      `import { Schema } from 'effect';
export const ChangeRatePayloadSchema = Schema.Struct({ rate: Schema.Number });
export type ChangeRatePayload = typeof ChangeRatePayloadSchema.Encoded;
export const ChangeRateResultSchema = Schema.Struct({ accepted: Schema.Boolean });
`,
    );
    const generated = yield* Effect.promise(() => readFile(path.join(root, PRIVATE_ACTION_PATH), 'utf-8'));
    const privateSchemas =
      'const ChangeRatePayloadSchema = Schema.Struct({});\n\nconst ChangeRateResultSchema = Schema.Struct({});';
    expect(generated).toContain(privateSchemas);
    yield* write(
      root,
      PRIVATE_ACTION_PATH,
      generated.replace(
        privateSchemas,
        "import { ChangeRatePayloadSchema, ChangeRateResultSchema } from '../../shared/actions/change-rate.ts';",
      ),
    );
    yield* scaffoldFixture(root, 'microvertical-action-boundary', [VERTICAL_FLAG, OWNER_SLUG]);
  });
const withPublishedClientFixture = (shared: boolean) => (run: (root: string) => Effect.Effect<void, unknown>) =>
  withCreatedFixture(Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-published-action-client-'))))((root) =>
    initializePublishedClientFixture(root, shared).pipe(Effect.andThen(run(root))),
  );

it.live(
  'adopts canonical shared schemas without duplicating or replacing the existing Action',
  Effect.fn(function* adoptsCanonicalSchemas() {
    yield* withPublishedClientFixture(false)(
      Effect.fn(function* adoptFixture(root) {
        const privateAction = yield* Effect.promise(() => readFile(path.join(root, PRIVATE_ACTION_PATH), 'utf-8'));
        const canonicalPath = `${OWNER_DIRECTORY}/shared/action-contracts.ts`;
        const publicSource = yield* Effect.promise(() => readFile(path.join(root, PUBLIC_ACTION_PATH), 'utf-8'));
        yield* write(root, canonicalPath, publicSource.replaceAll('ChangeRateResultSchema', 'SharedRateResultSchema'));
        yield* write(
          root,
          PRIVATE_ACTION_PATH,
          privateAction
            .replace("from '../../shared/actions/change-rate.ts'", "from '../../shared/action-contracts.ts'")
            .replace(
              'ChangeRatePayloadSchema, ChangeRateResultSchema',
              'ChangeRatePayloadSchema, SharedRateResultSchema as ChangeRateResultSchema',
            ),
        );
        yield* Effect.promise(() => rm(path.join(root, PUBLIC_ACTION_PATH)));
        const adoptedPrivate = yield* Effect.promise(() => readFile(path.join(root, PRIVATE_ACTION_PATH), 'utf-8'));
        const args = [
          VERTICAL_FLAG,
          OWNER_SLUG,
          '--action',
          FIXTURE_ACTION,
          SCHEMA_MODULE_FLAG,
          CANONICAL_SCHEMA_MODULE,
          RESULT_SCHEMA_FLAG,
          'SharedRateResultSchema',
        ];
        yield* scaffoldFixture(root, ACTION_HTTP_COMMAND, args);
        const projection = yield* Effect.promise(() => readFile(path.join(root, PUBLIC_ACTION_PATH), 'utf-8'));
        expect(projection).toContain(
          "export { SharedRateResultSchema as ChangeRateResultSchema } from '../action-contracts.ts'",
        );
        expect(projection).not.toContain('Schema.Struct');
        expect(yield* Effect.promise(() => readFile(path.join(root, PRIVATE_ACTION_PATH), 'utf-8'))).toBe(
          adoptedPrivate,
        );
        const first = yield* snapshotTree(root, ['node_modules']);
        yield* scaffoldFixture(root, ACTION_HTTP_COMMAND, args);
        expect(yield* snapshotTree(root, ['node_modules'])).toEqual(first);
      }),
    );
  }),
);

it.live(
  'rejects unsafe schema adoption and unrelated projections without partial writes',
  Effect.fn(function* rejectsUnsafeSchemaAdoption() {
    yield* withPublishedClientFixture(false)(
      Effect.fn(function* rejectFixture(root) {
        yield* write(
          root,
          `${OWNER_DIRECTORY}/shared/action-contracts.ts`,
          "import { Schema } from 'effect';\nexport const ChangeRatePayloadSchema = Schema.Struct({ rate: Schema.Number });\nexport const ChangeRateResultSchema = Schema.Struct({ accepted: Schema.Boolean });\n",
        );
        yield* write(root, 'outside-schemas.ts', 'export const escaped = true;\n');
        yield* Effect.promise(() =>
          symlink(
            path.join(root, 'outside-schemas.ts'),
            path.join(root, OWNER_DIRECTORY, 'shared', 'escaped-schemas.ts'),
          ),
        );
        for (const extra of [
          [SCHEMA_MODULE_FLAG, 'shared/escaped-schemas.ts'],
          [SCHEMA_MODULE_FLAG, '../private.ts'],
          [SCHEMA_MODULE_FLAG, 'shared/../src/actions/change-rate.action.ts'],
          [SCHEMA_MODULE_FLAG, 'src/actions/change-rate.action.ts'],
          [SCHEMA_MODULE_FLAG, CANONICAL_SCHEMA_MODULE, RESULT_SCHEMA_FLAG, 'MissingSchema'],
          [SCHEMA_MODULE_FLAG, CANONICAL_SCHEMA_MODULE],
          [RESULT_SCHEMA_FLAG, 'ChangeRateResultSchema'],
        ]) {
          const before = yield* snapshotTree(root, ['node_modules']);
          const outcome = yield* Effect.exit(
            scaffoldFixture(root, ACTION_HTTP_COMMAND, [
              VERTICAL_FLAG,
              OWNER_SLUG,
              '--action',
              FIXTURE_ACTION,
              ...extra,
            ]),
          );
          expect(Exit.isFailure(outcome)).toBe(true);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
        }
      }),
    );
  }),
);

it.live(
  'Action HTTP composes a complete API-only module with one real Action runtime binding',
  Effect.fn(function* completeActionRuntimeProgram() {
    for (const withRead of [false, true]) {
      yield* withPublishedClientFixture(true)(
        Effect.fn(function* completeActionRuntimeFixture(root) {
          if (withRead) {
            yield* scaffoldFixture(root, 'module-api', [
              VERTICAL_FLAG,
              OWNER_SLUG,
              '--name',
              'read-rate',
              AUTHORIZATION_FLAG,
              'authenticated_principal',
            ]);
            const existing = yield* Effect.promise(() =>
              readFile(path.join(root, OWNER_DIRECTORY, RUNTIME_ROOT_PATH), 'utf-8'),
            );
            const support =
              'GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedActionPrincipalVerifierLive, GovernedGatewayAssertionRedemptionLive)),';
            expect(
              readGeneratedSlotEntries(
                existing,
                GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
                GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END,
              ),
            ).toHaveLength(1);
            expect(
              generatedSlotContainsExactEntry(
                existing,
                GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
                GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END,
                support,
              ),
            ).toBe(true);
          }
          yield* scaffoldHttp(root);
          const runtime = yield* Effect.promise(() =>
            readFile(path.join(root, OWNER_DIRECTORY, RUNTIME_ROOT_PATH), 'utf-8'),
          );
          const loaded = spawnSync(
            process.execPath,
            [
              NODE_MODULE_FLAG,
              '--eval',
              `await import('./${OWNER_DIRECTORY}/api/index.ts'); console.log('complete-module-imported');`,
            ],
            { cwd: root, encoding: 'utf-8', timeout: 20_000 },
          );
          expect(loaded.error).toBeUndefined();
          expect(loaded.signal).toBeNull();
          expect(loaded.status, loaded.stderr).toBe(0);
          expect(loaded.stdout).toContain('complete-module-imported');
          expect(runtime).toContain(
            'const governedActionRuntimeLive = GovernedMakeActionRuntimeLive(governedActionDeliveryUnit).pipe(',
          );
          expect(runtime).toContain(
            'GovernedActionPrincipalVerifierLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive))',
          );
          expect(runtime).toContain(
            'changeRateActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive))',
          );
          const afterFirst = yield* snapshotTree(root, ['node_modules']);
          yield* scaffoldHttp(root);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(afterFirst);
        }),
      );
    }
    for (const { entry, marker, slot } of [
      {
        entry: "import { unsafe } from './private-owner.ts';",
        marker: GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START,
        slot: 'unknown import',
      },
      {
        entry:
          "import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';\nimport { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';",
        marker: GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START,
        slot: 'duplicate import',
      },
      {
        entry: 'GovernedReadLayer.provide(unsafeRuntime),',
        marker: GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
        slot: 'unknown layer',
      },
    ]) {
      yield* withPublishedClientFixture(true)(
        Effect.fn(function* editedRuntimeSupportFixture(root) {
          const runtime = yield* Effect.promise(() =>
            readFile(path.join(root, OWNER_DIRECTORY, RUNTIME_ROOT_PATH), 'utf-8'),
          );
          yield* write(root, `${OWNER_DIRECTORY}/api/index.ts`, runtime.replace(marker, `${marker}\n${entry}`));
          const before = yield* snapshotTree(root, ['node_modules']);
          const outcome = yield* Effect.exit(scaffoldHttp(root));
          expect(Exit.isFailure(outcome), slot).toBe(true);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
        }),
      );
    }
  }),
);

it.live(
  'Action HTTP follows the published API-only and MF client roots with real exported module linkage',
  Effect.fn(function* publishedActionClientLinkage() {
    for (const shared of [true, false]) {
      yield* withPublishedClientFixture(shared)(
        Effect.fn(function* publishedClientOwnerFixture(root) {
          const publishedPath = `${OWNER_DIRECTORY}/${ownerClientTarget(shared).slice(2)}`;
          const originalPackage = yield* Effect.promise(() => readFile(path.join(root, OWNER_PACKAGE_PATH), 'utf-8'));
          yield* scaffoldHttp(root);
          const clientRoot = yield* Effect.promise(() => readFile(path.join(root, publishedPath), 'utf-8'));
          const expectedExport = `export * from '${shared ? SHARED_CLIENT_PREFIX : './'}change-rate-action-client.ts';`;
          expect(clientRoot).toContain(expectedExport);
          const afterFirst = yield* snapshotTree(root, ['node_modules']);
          yield* scaffoldHttp(root);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(afterFirst);
          expect(clientRoot.split(expectedExport).length - 1).toBe(1);
          const original = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) }),
          )(JSON.parse(originalPackage));
          const after = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) }),
          )(JSON.parse(yield* Effect.promise(() => readFile(path.join(root, OWNER_PACKAGE_PATH), 'utf-8'))));
          expect(after.exports[CLIENT_EXPORT]).toBe(original.exports[CLIENT_EXPORT]);
          const linked = spawnSync(
            process.execPath,
            [
              '--experimental-strip-types',
              NODE_MODULE_FLAG,
              '--eval',
              `
import { executeChangeRate, executeChangeRateWithAuthorization, createPricingPolicyClient } from '@app/pricing-policy/api/client';
console.log(JSON.stringify([typeof executeChangeRate, typeof executeChangeRateWithAuthorization, typeof createPricingPolicyClient]));
`,
            ],
            { cwd: root, encoding: 'utf-8', timeout: 20_000 },
          );
          expect(linked.error).toBeUndefined();
          expect(linked.signal).toBeNull();
          expect(linked.status, linked.stderr).toBe(0);
          expect(JSON.parse(linked.stdout.trim())).toEqual(['function', 'function', 'function']);
          if (shared) {
            expect(Object.hasOwn(afterFirst, `${OWNER_DIRECTORY}/src/api/${OWNER_SLUG}-client.ts`)).toBe(false);
          }
        }),
      );
    }
  }),
);

const assertHttpRefused = Effect.fn(function* assertHttpRefused(root: string) {
  const before = yield* snapshotTree(root, ['node_modules']);
  const failed = yield* Effect.exit(scaffoldHttp(root));
  expect(Exit.isFailure(failed)).toBe(true);
  expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
});

it.live(
  'Action HTTP preserves canonical named owner client exports',
  Effect.fn(function* canonicalNamedClientExports() {
    for (const shared of [true, false]) {
      yield* withPublishedClientFixture(shared)(
        Effect.fn(function* namedOwnerFixture(root) {
          yield* scaffoldHttp(root);
          const relative = `${OWNER_DIRECTORY}/${ownerClientTarget(shared).slice(2)}`;
          const client = yield* Effect.promise(() => readFile(path.join(root, relative), 'utf-8'));
          const target = `${shared ? SHARED_CLIENT_PREFIX : './'}change-rate-action-client.ts`;
          const star = `export * from '${target}';`;
          const named = `export {
  executeChangeRateWithAuthorization,
  executeChangeRate,
} from '${target}';
export type { ChangeRateActionClientOptions } from '${target}';`;
          expect(client).toContain(star);
          const preserved = client.replace(star, named);
          yield* write(root, relative, preserved);
          const before = yield* snapshotTree(root, ['node_modules']);
          yield* scaffoldHttp(root);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
          expect(yield* Effect.promise(() => readFile(path.join(root, relative), 'utf-8'))).toBe(preserved);
          const loaded = spawnSync(
            process.execPath,
            [
              NODE_MODULE_FLAG,
              '--eval',
              "import { executeChangeRate, executeChangeRateWithAuthorization } from '@app/pricing-policy/api/client'; console.log(JSON.stringify([typeof executeChangeRate, typeof executeChangeRateWithAuthorization]));",
            ],
            { cwd: root, encoding: 'utf-8', timeout: 20_000 },
          );
          expect(loaded.error).toBeUndefined();
          expect(loaded.signal).toBeNull();
          expect(loaded.status, loaded.stderr).toBe(0);
          expect(JSON.parse(loaded.stdout)).toEqual(['function', 'function']);
          for (const invalid of [
            named.replace('executeChangeRate,', 'executeChangeRate as executeOtherRate,'),
            named.replace('ChangeRateActionClientOptions', 'OtherActionClientOptions'),
            `${named}\n${star}`,
            named.replace(target, `${shared ? SHARED_CLIENT_PREFIX : './'}other-action-client.ts`),
          ]) {
            yield* write(root, relative, client.replace(star, invalid));
            const invalidBefore = yield* snapshotTree(root, ['node_modules']);
            const result = yield* Effect.exit(scaffoldHttp(root));
            expect(Exit.isFailure(result)).toBe(true);
            expect(yield* snapshotTree(root, ['node_modules'])).toEqual(invalidBefore);
          }
          yield* write(root, relative, preserved);
          const generatedClientPath = `${OWNER_DIRECTORY}/src/api/change-rate-action-client.ts`;
          const generatedClient = yield* Effect.promise(() => readFile(path.join(root, generatedClientPath), 'utf-8'));
          yield* write(
            root,
            generatedClientPath,
            generatedClient.replace(
              '// @ontos-action-http-owner pricing.policy',
              '// @ontos-action-http-owner foreign.owner',
            ),
          );
          const wrongOwnerBefore = yield* snapshotTree(root, ['node_modules']);
          expect(Exit.isFailure(yield* Effect.exit(scaffoldHttp(root)))).toBe(true);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(wrongOwnerBefore);
          yield* write(root, generatedClientPath, generatedClient);
          yield* write(root, OUTSIDE_CLIENT_PATH, generatedClient);
          yield* Effect.promise(() => rm(path.join(root, generatedClientPath)));
          yield* Effect.promise(() =>
            symlink(path.join(root, OUTSIDE_CLIENT_PATH), path.join(root, generatedClientPath)),
          );
          const linkedBefore = yield* snapshotTree(root, ['node_modules']);
          expect(Exit.isFailure(yield* Effect.exit(scaffoldHttp(root)))).toBe(true);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(linkedBefore);
          expect(yield* Effect.promise(() => readlink(path.join(root, generatedClientPath)))).toBe(
            path.join(root, OUTSIDE_CLIENT_PATH),
          );
          yield* Effect.promise(() => rm(path.join(root, generatedClientPath)));
          yield* write(root, generatedClientPath, generatedClient);
          const canonicalNamed = `export { executeChangeRateWithAuthorization, executeChangeRate } from '${target}';\nexport type { ChangeRateActionClientOptions } from '${target}';`;
          yield* write(root, relative, client.replace(star, canonicalNamed));
          yield* scaffoldFixture(root, 'action', [
            VERTICAL_FLAG,
            OWNER_SLUG,
            '--action',
            NEXT_ACTION,
            '--legal-entity-scope',
            'required',
            AUTHORIZATION_FLAG,
            'action_execution',
            '--provisioning',
            'explicit',
          ]);
          yield* write(
            root,
            `${OWNER_DIRECTORY}/shared/actions/revise-rate.ts`,
            `import { Schema } from 'effect';
export const ReviseRatePayloadSchema = Schema.Struct({ rate: Schema.Number });
export type ReviseRatePayload = typeof ReviseRatePayloadSchema.Encoded;
export const ReviseRateResultSchema = Schema.Struct({ accepted: Schema.Boolean });
`,
          );
          const nextPrivatePath = `${OWNER_DIRECTORY}/src/actions/revise-rate.action.ts`;
          const nextPrivate = yield* Effect.promise(() => readFile(path.join(root, nextPrivatePath), 'utf-8'));
          const privateSchemas =
            'const ReviseRatePayloadSchema = Schema.Struct({});\n\nconst ReviseRateResultSchema = Schema.Struct({});';
          expect(nextPrivate).toContain(privateSchemas);
          yield* write(
            root,
            nextPrivatePath,
            nextPrivate.replace(
              privateSchemas,
              "import { ReviseRatePayloadSchema, ReviseRateResultSchema } from '../../shared/actions/revise-rate.ts';",
            ),
          );
          yield* scaffoldFixture(root, ACTION_HTTP_COMMAND, [VERTICAL_FLAG, OWNER_SLUG, '--action', NEXT_ACTION]);
          const withNew = yield* Effect.promise(() => readFile(path.join(root, relative), 'utf-8'));
          expect(withNew).toContain(canonicalNamed);
          expect(withNew).not.toContain(star);
          expect(withNew).toContain(
            `export * from '${shared ? SHARED_CLIENT_PREFIX : './'}revise-rate-action-client.ts';`,
          );
          const appended = yield* snapshotTree(root, ['node_modules']);
          yield* scaffoldFixture(root, ACTION_HTTP_COMMAND, [VERTICAL_FLAG, OWNER_SLUG, '--action', NEXT_ACTION]);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(appended);
        }),
      );
    }
  }),
);

it.live(
  'Action HTTP refuses missing, private, conditional and escaping published roots before writes',
  Effect.fn(function* invalidPublishedActionRoots() {
    const targets: readonly (JsonValue | undefined)[] = [
      undefined,
      './src/actions/change-rate.action.ts',
      '../outside-client.ts',
      '/outside-owner-client.ts',
      './shared/other-owner-client.ts',
      'shared/pricing-policy-client.ts',
      { node: './shared/pricing-policy-client.ts' },
    ];
    yield* withPublishedClientFixture(true)(
      Effect.fn(function* invalidPublishedRootFixture(root) {
        const packageBefore = yield* Effect.promise(() => readFile(path.join(root, OWNER_PACKAGE_PATH), 'utf-8'));
        const parsed = yield* Schema.decodeUnknownEffect(Schema.Json)(JSON.parse(packageBefore));
        const packageValue = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(parsed);
        for (const target of targets) {
          const exports = target === undefined ? {} : { [CLIENT_EXPORT]: target };
          yield* write(root, OWNER_PACKAGE_PATH, jsonText({ ...packageValue, exports }));
          yield* assertHttpRefused(root);
        }
        yield* write(root, OWNER_PACKAGE_PATH, packageBefore);
        const publishedPath = path.join(root, OWNER_DIRECTORY, ownerClientTarget(true).slice(2));
        const source = yield* Effect.promise(() => readFile(publishedPath, 'utf-8'));
        yield* Effect.promise(() => rm(publishedPath));
        yield* assertHttpRefused(root);
        const foreign = OUTSIDE_CLIENT_PATH;
        yield* write(root, foreign, source);
        yield* Effect.promise(() => symlink(path.join(root, foreign), publishedPath));
        yield* assertHttpRefused(root);
        expect(yield* Effect.promise(() => readlink(publishedPath))).toBe(path.join(root, foreign));
        expect(yield* Effect.promise(() => readFile(path.join(root, foreign), 'utf-8'))).toBe(source);
      }),
    );
  }),
);

it.live(
  'Action HTTP keeps public-schema and generated-client slot validation fail closed',
  Effect.fn(function* actionHttpPrerequisiteGuards() {
    yield* withPublishedClientFixture(true)(
      Effect.fn(function* actionHttpGuardFixture(root) {
        const contract = yield* Effect.promise(() => readFile(path.join(root, PUBLIC_ACTION_PATH), 'utf-8'));
        yield* Effect.promise(() => rm(path.join(root, PUBLIC_ACTION_PATH)));
        yield* assertHttpRefused(root);
        yield* write(
          root,
          PUBLIC_ACTION_PATH,
          "export { ChangeRatePayloadSchema, ChangeRateResultSchema } from '../../src/actions/change-rate.action.ts';\n",
        );
        yield* assertHttpRefused(root);
        yield* write(root, PUBLIC_ACTION_PATH, contract);
        const published = `${OWNER_DIRECTORY}/${ownerClientTarget(true).slice(2)}`;
        const client = yield* Effect.promise(() => readFile(path.join(root, published), 'utf-8'));
        yield* write(root, published, client.replace(CLIENT_ANCHOR, ''));
        yield* assertHttpRefused(root);
        yield* write(
          root,
          published,
          `${client}\n// <generated-action-http-client-exports>\nexport * from './change-rate-action-client.ts';\n// </generated-action-http-client-exports>\n`,
        );
        yield* assertHttpRefused(root);
      }),
    );
  }),
);

const CUSTOM_PROBLEM_FLAG = '--domain-problem';
const CUSTOM_PROBLEM_MODULE = 'shared/domain-problems.ts';
const CUSTOM_PROBLEM_SCHEMA = 'ChangeRateOriginalProblemSchema';
const CUSTOM_PROBLEM_TAG_PREFIX = 'ChangeRateNotImplemented=';
const CUSTOM_PROBLEM_SPEC =
  'ChangeRateNotImplemented=shared/domain-problems.ts#ChangeRateOriginalProblemSchema#mapChangeRateOriginalProblem';
const customProblemSource = `import { Schema } from 'effect';
import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
const originalProblem = makeProblemDetailsSchema('ChangeRateOriginalProblem', 503, { original: Schema.String });
const checkedProblem = makeProblemDetailsSchema('ChangeRateCheckedProblem', 503).check(Schema.makeFilter(() => true).annotate({ httpApiStatus: 409 }).and(Schema.makeFilter(() => true), { httpApiStatus: 503 }));
export const ChangeRateOriginalProblemSchema = Schema.Union([originalProblem, makeProblemDetailsSchema('ChangeRateConflictProblem', 409, { original: Schema.String }), checkedProblem]);
export const OtherProblemSchema = makeProblemDetailsSchema('ChangeRateOtherProblem', 422);
export const mapOtherProblem = failure => OtherProblemSchema.make({ detail: failure.code, status: 422, title: 'Rejected', type: 'https://ontos.dev/problems/other' });
export const InvalidProblemSchema = Schema.Struct({ _tag: Schema.Literal('Invalid'), status: Schema.Literal(200), detail: Schema.String, title: Schema.String, type: Schema.String });
export const InvalidProblemUnionSchema = Schema.Union([originalProblem, InvalidProblemSchema]);
export const MissingStatusAnnotationSchema = Schema.Struct({ _tag: Schema.Literal('MissingStatus'), status: Schema.Literal(503), detail: Schema.String, title: Schema.String, type: Schema.String });
export const MismatchedStatusSchema = originalProblem.annotate({ httpApiStatus: 409 });
export const ClearedStatusSchema = originalProblem.annotate({ httpApiStatus: undefined });
export const InvalidCheckedStatusSchema = originalProblem.check(Schema.makeFilter(() => true).annotate({ httpApiStatus: 503 }).and(Schema.makeFilter(() => true), { httpApiStatus: 409 }));
export const InvalidCheckedStatusUnionSchema = Schema.Union([originalProblem, InvalidCheckedStatusSchema]);
export const invalidMapper = 3;
export const mapChangeRateOriginalProblem = failure => originalProblem.make({ original: failure.reason, detail: 'Original effect pending', status: 503, title: 'Pending', type: 'https://ontos.dev/problems/original-pending' });
`;

it.live(
  'adopts and preserves exact custom domain Problem schema/mapper projections across regeneration',
  Effect.fn(function* preserveDomainProblem() {
    yield* withPublishedClientFixture(false)(
      Effect.fn(function* customFixture(root) {
        yield* write(root, `${OWNER_DIRECTORY}/${CUSTOM_PROBLEM_MODULE}`, customProblemSource);
        const actionSource = yield* Effect.promise(() => readFile(path.join(root, PRIVATE_ACTION_PATH), 'utf-8'));
        yield* write(
          root,
          PRIVATE_ACTION_PATH,
          actionSource.replace(
            'domainErrorSchema: ChangeRateNotImplemented,',
            "domainErrorSchema: Schema.Union([ChangeRateNotImplemented, Schema.Struct({ _tag: Schema.Literal('ChangeRateOtherFailure'), code: Schema.Literal('other_failure') })]),",
          ),
        );
        const flags = [
          VERTICAL_FLAG,
          OWNER_SLUG,
          '--action',
          FIXTURE_ACTION,
          CUSTOM_PROBLEM_FLAG,
          CUSTOM_PROBLEM_SPEC,
          CUSTOM_PROBLEM_FLAG,
          'ChangeRateOtherFailure=shared/domain-problems.ts#OtherProblemSchema#mapOtherProblem',
        ];
        yield* scaffoldFixture(root, ACTION_HTTP_COMMAND, flags);
        const contract = yield* Effect.promise(() =>
          readFile(path.join(root, OWNER_DIRECTORY, 'shared/apis/change-rate-action.ts'), 'utf-8'),
        );
        const problems = yield* Effect.promise(() =>
          readFile(path.join(root, OWNER_DIRECTORY, 'api/change-rate-action-problems.ts'), 'utf-8'),
        );
        expect(contract).toContain('typeof ChangeRateOriginalProblemSchema.Type');
        expect(contract).toContain(`@ontos-action-http-domain-problem ${CUSTOM_PROBLEM_SPEC}`);
        expect(contract).toContain(
          "import { ChangeRateOriginalProblemSchema, OtherProblemSchema } from '../domain-problems.ts';",
        );
        expect(contract).not.toContain('export { ChangeRateOriginalProblemSchema');
        expect(contract).not.toContain('export { OtherProblemSchema');
        expect(contract).toContain("export { ChangeRatePayloadSchema } from '../actions/change-rate.ts';");
        expect(contract).toContain('export const ChangeRateActionInvalidProblemSchema');
        expect(contract).toContain('  OtherProblemSchema,');
        expect(contract).toContain('  ChangeRateOriginalProblemSchema,');
        expect(contract).toContain('typeof OtherProblemSchema.Type');
        expect(contract.lastIndexOf('\nimport ')).toBeLessThan(contract.indexOf('\nexport '));
        expect(problems).toContain(
          "import { mapChangeRateOriginalProblem, mapOtherProblem } from '../shared/domain-problems.ts';",
        );
        expect(contract).not.toContain(String.raw`\n`);
        expect(problems).toContain('ChangeRateNotImplemented: (failure) => mapChangeRateOriginalProblem(failure)');
        const before = yield* snapshotTree(root, ['node_modules']);
        yield* scaffoldFixture(root, ACTION_HTTP_COMMAND, flags);
        expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
        const omitted = yield* Effect.exit(scaffoldHttp(root));
        expect(Exit.isFailure(omitted)).toBe(true);
        expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
      }),
    );
  }),
);

it.live(
  'rejects private/traversing/escaped/invalid/unknown-tag custom Problems before any writes',
  Effect.fn(function* rejectDomainProblems() {
    yield* withPublishedClientFixture(false)(
      Effect.fn(function* invalidCustomFixture(root) {
        yield* write(root, `${OWNER_DIRECTORY}/${CUSTOM_PROBLEM_MODULE}`, customProblemSource);
        yield* write(root, 'outside-problem.ts', customProblemSource);
        yield* Effect.promise(() =>
          symlink(path.join(root, 'outside-problem.ts'), path.join(root, OWNER_DIRECTORY, 'shared/escaped-problem.ts')),
        );
        yield* write(
          root,
          `${OWNER_DIRECTORY}/shared/private-problem.ts`,
          "export { missing } from '../src/actions/change-rate.action.ts';\n",
        );
        for (const specification of [
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_TAG_PREFIX, 'ActionPermissionDenied='),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_MODULE, 'src/private.ts'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_MODULE, 'shared/../src/private.ts'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_MODULE, 'shared/escaped-problem.ts'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_MODULE, 'shared/private-problem.ts'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_SCHEMA, 'MissingSchema'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_SCHEMA, 'InvalidProblemSchema'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_SCHEMA, 'InvalidProblemUnionSchema'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_SCHEMA, 'MissingStatusAnnotationSchema'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_SCHEMA, 'MismatchedStatusSchema'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_SCHEMA, 'ClearedStatusSchema'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_SCHEMA, 'InvalidCheckedStatusSchema'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_SCHEMA, 'InvalidCheckedStatusUnionSchema'),
          CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_TAG_PREFIX, '*='),
          CUSTOM_PROBLEM_SPEC.replace('mapChangeRateOriginalProblem', 'invalidMapper'),
        ]) {
          const before = yield* snapshotTree(root, ['node_modules']);
          const result = yield* Effect.exit(
            scaffoldFixture(root, ACTION_HTTP_COMMAND, [
              VERTICAL_FLAG,
              OWNER_SLUG,
              '--action',
              FIXTURE_ACTION,
              CUSTOM_PROBLEM_FLAG,
              specification,
            ]),
          );
          expect(Exit.isFailure(result)).toBe(true);
          expect(yield* snapshotTree(root, ['node_modules'])).toEqual(before);
        }
      }),
    );
  }),
);

it.live(
  'rejects a declared Core error tag as an owner custom projection before writes',
  Effect.fn(function* rejectCoreProjection() {
    yield* withPublishedClientFixture(false)(
      Effect.fn(function* declaredCoreFixture(root) {
        yield* write(root, `${OWNER_DIRECTORY}/${CUSTOM_PROBLEM_MODULE}`, customProblemSource);
        const actionSource = yield* Effect.promise(() => readFile(path.join(root, PRIVATE_ACTION_PATH), 'utf-8'));
        yield* write(
          root,
          PRIVATE_ACTION_PATH,
          actionSource.replace(
            'domainErrorSchema: ChangeRateNotImplemented,',
            "domainErrorSchema: Schema.Struct({ _tag: Schema.Literal('ActionPermissionDenied'), code: Schema.Literal('action_permission_denied') }),",
          ),
        );
        const beforeCoreOverride = yield* snapshotTree(root, ['node_modules']);
        const coreOverride = yield* Effect.exit(
          scaffoldFixture(root, ACTION_HTTP_COMMAND, [
            VERTICAL_FLAG,
            OWNER_SLUG,
            '--action',
            FIXTURE_ACTION,
            CUSTOM_PROBLEM_FLAG,
            CUSTOM_PROBLEM_SPEC.replace(CUSTOM_PROBLEM_TAG_PREFIX, 'ActionPermissionDenied='),
          ]),
        );
        expect(Exit.isFailure(coreOverride)).toBe(true);
        expect(yield* snapshotTree(root, ['node_modules'])).toEqual(beforeCoreOverride);
      }),
    );
  }),
);
