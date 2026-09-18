import { NodeServices } from '@effect/platform-node';
import { Cause, Effect, Exit, Option, Predicate, Schema, SchemaAST } from 'effect';
import { expect, it } from 'effect-rstest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  inspectAction,
  renderActionHttpClient,
  renderActionHttpContract,
  renderActionHttpProblems,
} from '../action-http/scaffold.mts';
import { createOrUpdateOwnedGeneratedMutationEffect } from '../shared.mts';
import type { OntosVerticalMetadata } from '../shared.mts';

const vertical = {
  appId: 'pricing-policy',
  directory: '/workspace/verticals/pricing-policy',
  manifestContent: '',
  manifestPath: '/workspace/verticals/pricing-policy/vertical.manifest.ts',
  moduleId: 'pricing.policy',
  packageContent: '{}',
  packageJson: {},
  packageName: '@app/pricing-policy',
  packagePath: '/workspace/verticals/pricing-policy/package.json',
  registrationContent: '',
  registrationPath: '/workspace/verticals/pricing-policy/vertical.registration.ts',
  slug: 'pricing-policy',
  topologyEntry: {},
} satisfies OntosVerticalMetadata;
const appRoot = path.resolve(import.meta.dirname, '../../..');

it('renders one exact typed Action endpoint and exhaustive domain mapping', () => {
  const action = 'change-rate';
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

  expect(contract).toContain("SubmitFulfillmentRequestActionConflictProblem', 409");
  expect(contract).toContain("SubmitFulfillmentRequestActionRateLimitedProblem', 429");
  expect(contract).toContain("SubmitFulfillmentRequestActionIneligibleProblem', 422");
  expect(problems).toContain("'REQUEST_CONFLICT': { code: 'fulfillment_request_rejected', kind: 'conflict' }");
  expect(problems).toContain("'RATE_LIMITED': { code: 'fulfillment_request_rejected', kind: 'rateLimited' }");
  expect(problems).toContain('fulfillmentRequestRejectedProblemByReasonCode[failure.reasonCode]');
});

it('renders required idempotency and governed assertion acquisition in the Action client', () => {
  const client = renderActionHttpClient(vertical, 'change-rate', true);
  expect(client).toContain('readonly idempotencyKey: string;');
  expect(client).toContain('operationGateway.invoke(');
  expect(client).toContain("headers: { 'idempotency-key': options.idempotencyKey }");
  expect(client).toContain("defaultApiPrefix: '/pricing-policy-api'");
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
