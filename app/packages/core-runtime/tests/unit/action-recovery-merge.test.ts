import { NodeCrypto } from '@effect/platform-node';
import { Context, Crypto, Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineAction } from '../../src/actions/definition.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { fixtureActionAccess } from '../support/access-declaration-fixtures.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { makeTestDatabase } from '../support/database.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:recovery-merge',
  authMethod: 'session',
  legalEntityId: '10000000-0000-4000-8000-000000000002',
  principalId: '10000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000004',
});
const invocationId = '10000000-0000-4000-8000-000000000005';
const actionKey = 'test.recovery-merge.execute';
const idempotencyKey = 'recovery-merge-once';
const registration = defineAction(
  {
    accessDeclaration: fixtureActionAccess('test.recovery-merge'),
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.recovery-merge.evidence' },
    actionKey,
    auditProfile: 'minimal',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: actionKey,
      moduleKey: 'test.recovery-merge',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'test.recovery-merge',
    payloadSchema: Schema.Struct({}),
    policies: [],
    resultSchema: Schema.Struct({ committed: Schema.Boolean }),
    schemaVersion: '1',
  },
  () => Effect.succeed({ committed: true }),
);
const { ownerRegistration } = makeTestOperationOwner({
  actions: [registration],
  moduleId: 'test.recovery-merge',
});
const committedHarness = Effect.fn('RecoveryMerge.committedHarness')(function* committedHarness() {
  const harness = yield* makeActionTestHarness({ actionPermission: 'allowed', ownerRegistration });
  yield* harness.runtime.runAction({
    payload: {},
    principal,
    registration,
    transport: { correlationId: 'recovery-merge', idempotencyKey },
  });
  const [invocation] = harness.snapshot().invocations;
  if (invocation === undefined) {
    return expect.fail('The Action must persist its invocation');
  }
  return { harness, invocation };
});

it.effect('retains demo execution lookups and main Action-pinned commit resolution together', () =>
  Effect.gen(function* bothResolutionContracts() {
    const { harness, invocation } = yield* committedHarness();
    for (const identity of [{ invocationId: invocation.actionInvocationId }, { actionKey, idempotencyKey }]) {
      expect(
        yield* harness.runtime.resolveActionExecution({
          ...identity,
          expectedRequestHash: invocation.requestHash,
          principal,
        }),
      ).toEqual({
        actionKey,
        invocationId: invocation.actionInvocationId,
        retryCommand: false,
        state: 'COMMITTED',
      });
    }
    const lookup = { invocationId: invocation.actionInvocationId, principal };
    expect(
      Predicate.isTagged(
        yield* Effect.flip(harness.runtime.resolveActionCommit({ ...lookup, expectedActionKey: actionKey })),
        'ActionAlreadyCommitted',
      ),
    ).toBe(true);
    expect(
      Predicate.isTagged(
        yield* Effect.flip(
          harness.runtime.resolveActionCommit({ ...lookup, expectedActionKey: 'test.recovery-merge.other' }),
        ),
        'ActionInvocationNotFound',
      ),
    ).toBe(true);
    expect(
      Predicate.isTagged(
        yield* Effect.flip(harness.runtime.resolveActionCommit({ invocationId: 'invalid', principal })),
        'ActionPayloadValidationError',
      ),
    ).toBe(true);
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);

it.effect('never resolves another company, tenant, caller or request through either execution lookup', () =>
  Effect.gen(function* exactExecutionOwnership() {
    const { harness, invocation } = yield* committedHarness();
    for (const identity of [{ invocationId: invocation.actionInvocationId }, { actionKey, idempotencyKey }]) {
      for (const foreign of [
        { ...principal, legalEntityId: '20000000-0000-4000-8000-000000000001' },
        { ...principal, tenantId: '20000000-0000-4000-8000-000000000002' },
        { ...principal, principalId: '20000000-0000-4000-8000-000000000003' },
      ]) {
        expect(yield* harness.runtime.resolveActionExecution({ ...identity, principal: foreign })).toEqual({
          retryCommand: true,
          state: 'NOT_STARTED',
        });
      }
      for (const expectedRequestHash of ['not-a-hash', 'f'.repeat(64)]) {
        expect(
          Predicate.isTagged(
            yield* Effect.flip(harness.runtime.resolveActionExecution({ ...identity, expectedRequestHash, principal })),
            'ActionPayloadValidationError',
          ),
        ).toBe(true);
      }
    }
    expect(
      yield* harness.runtime.resolveActionExecution({ actionKey, idempotencyKey: 'never-started', principal }),
    ).toEqual({ retryCommand: true, state: 'NOT_STARTED' });
  }),
);

it.effect('the production repository executes both exact lookup predicates and keeps the Action pin', () =>
  Effect.gen(function* productionResolutionQueries() {
    const statements: { readonly parameters: readonly unknown[]; readonly sql: string }[] = [];
    const database = yield* makeTestDatabase((sql, parameters) => {
      if (!sql.includes('"core"."action_invocations"')) {
        return Effect.succeed([]);
      }
      statements.push({ parameters, sql });
      return Effect.succeed([
        {
          actionInvocationId: invocationId,
          actionKey,
          completedAt: null,
          requestHash: 'a'.repeat(64),
          status: 'received',
        },
      ]);
    });
    const crypto = Context.get(yield* Layer.build(NodeCrypto.layer), Crypto.Crypto);
    const repository = makeActionRepository(crypto);
    expect(
      (yield* repository.resolveInvocation(database, { expectedActionKey: actionKey, invocationId, principal }))
        .actionKey,
    ).toBe(actionKey);
    expect((yield* repository.resolveInvocation(database, { actionKey, idempotencyKey, principal })).actionKey).toBe(
      actionKey,
    );
    expect(statements).toHaveLength(2);
    const [byInvocation, byKey] = statements;
    expect(byInvocation?.sql).toContain('"action_invocation_id" =');
    expect(byInvocation?.sql).toContain('"action_key" =');
    expect(byInvocation?.parameters).toContain(invocationId);
    expect(byInvocation?.parameters).toContain(actionKey);
    expect(byKey?.sql).toContain('"action_key" =');
    expect(byKey?.sql).toContain('"idempotency_key" =');
    expect(byKey?.parameters).toContain(actionKey);
    expect(byKey?.parameters).toContain(idempotencyKey);
    for (const statement of statements) {
      expect(statement.sql).toContain('"legal_entity_id" =');
      expect(statement.sql).toContain('"tenant_id" =');
      expect(statement.sql).toContain('"principal_id" =');
      expect(statement.parameters).toContain(principal.legalEntityId);
      expect(statement.parameters).toContain(principal.tenantId);
      expect(statement.parameters).toContain(principal.principalId);
    }
  }),
);
