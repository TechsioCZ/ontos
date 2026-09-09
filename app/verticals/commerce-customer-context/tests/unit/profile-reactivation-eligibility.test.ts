import { ScopedRoutineInvocationError } from '@app/core-runtime';
import type { ScopedRoutineDefinition, ScopedRoutineParameter } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ProfileReactivationEligibilityEvaluatorFactory,
  ProfileReconfirmationPolicy,
  makeProfileReactivationEligibilityEvaluator,
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailable,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';
import type {
  CounterpartyRoleEligibility,
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const profileId = '30000000-0000-4000-8000-000000000003';
const principalId = '40000000-0000-4000-8000-000000000004';
const scope: ProfilePersistenceScope = { legalEntityId, principalId, tenantId };

const retailProfileRef = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: profileId,
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const counterpartyProfileRef = {
  kind: 'COUNTERPARTY',
  moduleId: 'commerce.customer-context',
  resourceId: profileId,
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const lifecyclePayload = {
  effectiveAt: '2026-09-09T10:00:00.000Z',
  expectedRevision: 4,
  expectedState: 'SUSPENDED',
  reason: 'Relationship hold resolved',
} as const;

const routineFailure = (routineKey: string) =>
  new ScopedRoutineInvocationError({
    code: 'scoped_routine_invocation_failed',
    constraint: Option.none(),
    ownerModuleKey: 'commerce.customer-context',
    postgresCode: Option.none(),
    reason: 'sanitized',
    routineKey,
  });

const decodeRoutineRows = <
  RowSchema extends Schema.ConstraintDecoder<object>,
  const Parameters extends readonly ScopedRoutineParameter[],
>(
  routine: ScopedRoutineDefinition<RowSchema, Parameters>,
  rows: readonly object[],
): Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError> =>
  Schema.decodeUnknownEffect(Schema.Array(Schema.toType(routine.resultSchema)))(rows).pipe(
    Effect.mapError(() => routineFailure(routine.routineKey)),
  );

const transactionReturning = (
  rows: readonly object[],
  capture?: (routine: ScopedRoutineDefinition, values: readonly unknown[]) => void,
): ProfileScopedRoutineInvoker => ({
  invoke: (routine, values) => {
    capture?.(routine, values);
    return decodeRoutineRows(routine, rows);
  },
});

const retailProfileRow = (outcome = 'PROFILE_AVAILABLE') => ({
  outcome,
  payload: {
    profileId,
    profileKind: 'RETAIL',
    revision: 4,
    state: 'SUSPENDED',
    subject: {
      attributionKind: 'AUTHENTICATED',
      kind: 'RETAIL',
      partyResourceId: 'party-1',
      partyResourceRevision: 'party-revision-1',
    },
  },
});

const counterpartyProfileRow = (outcome = 'PROFILE_AVAILABLE') => ({
  outcome,
  payload: {
    profileId,
    profileKind: 'COUNTERPARTY',
    revision: 4,
    state: 'SUSPENDED',
    subject: {
      counterpartyResourceId: 'counterparty-1',
      counterpartyResourceRevision: 'counterparty-revision-1',
      customerRoleResourceId: 'historic-customer-role',
      customerRoleResourceRevision: 'historic-role-revision',
      kind: 'COUNTERPARTY',
    },
  },
});

const roleResolver = (eligibility: CounterpartyRoleEligibility) => () =>
  Effect.succeed(eligibility);
const noReconfirmationRequired = () => Effect.succeed(true);

it.effect('re-reads a Retail profile subject through the exact scoped owner routine', () => {
  let observedRoutine: ScopedRoutineDefinition | undefined;
  let observedValues: readonly unknown[] | undefined;
  let roleCalls = 0;
  return Effect.gen(function* retailReactivation() {
    const evaluate = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: () => {
        roleCalls += 1;
        return Effect.succeed({ outcome: 'INDETERMINATE' });
      },
      scope,
      transaction: transactionReturning([retailProfileRow()], (routine, values) => {
        observedRoutine = routine;
        observedValues = values;
      }),
    });

    const result = yield* evaluate({ ...lifecyclePayload, profileRef: retailProfileRef });

    expect(result).toEqual({
      dependenciesSatisfied: true,
      reconfirmationSatisfied: true,
    });
    expect(roleCalls).toBe(0);
    expect(observedRoutine?.name).toBe('read_customer_profile');
    expect(observedRoutine?.routineKey).toBe('profile.reactivation-read');
    expect(observedValues).toEqual([profileId, 'RETAIL']);
  });
});

it.effect('requires the stored Counterparty subject to have a Current customer role', () => {
  let roleInput: { readonly counterpartyResourceId: string; readonly tenantId: string } | undefined;
  return Effect.gen(function* counterpartyReactivation() {
    const evaluate = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: (input) => {
        roleInput = input;
        return Effect.succeed({
          managedLegalEntityId: legalEntityId,
          outcome: 'ELIGIBLE',
          roleResourceId: 'current-customer-role',
          roleResourceRevision: '2026-09-09T09:59:00.000Z',
        });
      },
      scope,
      transaction: transactionReturning([counterpartyProfileRow()]),
    });

    const result = yield* evaluate({ ...lifecyclePayload, profileRef: counterpartyProfileRef });

    expect(roleInput).toEqual({ counterpartyResourceId: 'counterparty-1', tenantId });
    expect(result).toEqual({
      dependenciesSatisfied: true,
      reconfirmationSatisfied: true,
    });
  });
});

it.effect('returns a definite unsatisfied dependency when the customer role is absent', () =>
  Effect.gen(function* ineligibleCounterparty() {
    const evaluate = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: roleResolver({ outcome: 'INELIGIBLE' }),
      scope,
      transaction: transactionReturning([counterpartyProfileRow()]),
    });

    expect(yield* evaluate({ ...lifecyclePayload, profileRef: counterpartyProfileRef })).toEqual({
      dependenciesSatisfied: false,
      reconfirmationSatisfied: true,
    });
  }),
);

it.effect('rejects a reconciliation-required profile snapshot before dependency evaluation', () => {
  let roleCalls = 0;
  return Effect.gen(function* reconciliationRequired() {
    const evaluate = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: () => {
        roleCalls += 1;
        return Effect.succeed({ outcome: 'INELIGIBLE' });
      },
      scope,
      transaction: transactionReturning([
        counterpartyProfileRow('PROFILE_RECONCILIATION_REQUIRED'),
      ]),
    });

    const failure = yield* Effect.flip(
      evaluate({ ...lifecyclePayload, profileRef: counterpartyProfileRef }),
    );

    expect(failure.reason).toContain('could not be resolved exactly');
    expect(roleCalls).toBe(0);
  });
});

it.effect('fails closed on an indeterminate role or a different managed Legal Entity', () =>
  Effect.gen(function* indeterminateCounterparty() {
    const indeterminate = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: roleResolver({ outcome: 'INDETERMINATE' }),
      scope,
      transaction: transactionReturning([counterpartyProfileRow()]),
    });
    const wrongLegalEntity = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: roleResolver({
        managedLegalEntityId: '50000000-0000-4000-8000-000000000005',
        outcome: 'ELIGIBLE',
        roleResourceId: 'current-customer-role',
        roleResourceRevision: '2026-09-09T09:59:00.000Z',
      }),
      scope,
      transaction: transactionReturning([counterpartyProfileRow()]),
    });

    expect(
      (yield* Effect.flip(
        indeterminate({ ...lifecyclePayload, profileRef: counterpartyProfileRef }),
      )).reason,
    ).toContain('indeterminate');
    expect(
      (yield* Effect.flip(
        wrongLegalEntity({ ...lifecyclePayload, profileRef: counterpartyProfileRef }),
      )).reason,
    ).toContain('another managed Legal Entity');
  }),
);

it.effect(
  'uses an explicit owner reconfirmation evaluator without exposing the Action reason',
  () =>
    Effect.gen(function* explicitReconfirmation() {
      let observedFacts: unknown;
      const evaluate = makeProfileReactivationEligibilityEvaluator({
        evaluateReconfirmation: (facts) => {
          observedFacts = facts;
          return Effect.succeed(false);
        },
        resolveCounterpartyRole: roleResolver({ outcome: 'INDETERMINATE' }),
        scope,
        transaction: transactionReturning([retailProfileRow()]),
      });

      expect(yield* evaluate({ ...lifecyclePayload, profileRef: retailProfileRef })).toEqual({
        dependenciesSatisfied: true,
        reconfirmationSatisfied: false,
      });
      expect(observedFacts).not.toHaveProperty('reason');
      expect(observedFacts).toMatchObject({
        profileId,
        profileKind: 'RETAIL',
        revision: 4,
        state: 'SUSPENDED',
      });
    }),
);

it.effect('preserves typed failures from role and reconfirmation dependencies', () =>
  Effect.gen(function* typedDependencyFailures() {
    const roleFailure = new ProfilePersistenceDependencyFailure({
      reason: 'Party Registry unavailable',
    });
    const reconfirmationFailure = new ProfilePersistenceDependencyFailure({
      reason: 'Reconfirmation policy unavailable',
    });
    const roleUnavailable = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: () => Effect.fail(roleFailure),
      scope,
      transaction: transactionReturning([counterpartyProfileRow()]),
    });
    const reconfirmationUnavailable = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: () => Effect.fail(reconfirmationFailure),
      resolveCounterpartyRole: roleResolver({ outcome: 'INDETERMINATE' }),
      scope,
      transaction: transactionReturning([retailProfileRow()]),
    });

    expect(
      Schema.is(ProfilePersistenceDependencyFailure)(
        yield* Effect.flip(
          roleUnavailable({ ...lifecyclePayload, profileRef: counterpartyProfileRef }),
        ),
      ),
    ).toBe(true);
    expect(
      yield* Effect.flip(
        reconfirmationUnavailable({ ...lifecyclePayload, profileRef: retailProfileRef }),
      ),
    ).toBe(reconfirmationFailure);
  }),
);

it.effect('rejects cross-Tenant references and stored kind mismatches before reactivation', () =>
  Effect.gen(function* exactProfileIdentity() {
    let transactionCalls = 0;
    const crossTenant = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: roleResolver({ outcome: 'INDETERMINATE' }),
      scope,
      transaction: {
        invoke: () => {
          transactionCalls += 1;
          return Effect.die(new Error('Cross-Tenant input must not reach persistence'));
        },
      },
    });
    const kindMismatch = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: roleResolver({ outcome: 'INDETERMINATE' }),
      scope,
      transaction: transactionReturning([counterpartyProfileRow()]),
    });

    const crossTenantFailure = yield* Effect.flip(
      crossTenant({
        ...lifecyclePayload,
        profileRef: { ...retailProfileRef, tenantId: '60000000-0000-4000-8000-000000000006' },
      }),
    );
    const kindFailure = yield* Effect.flip(
      kindMismatch({ ...lifecyclePayload, profileRef: retailProfileRef }),
    );

    expect(crossTenantFailure.reason).toContain('another Tenant');
    expect(transactionCalls).toBe(0);
    expect(kindFailure.reason).toContain('could not be resolved exactly');
  }),
);

it.effect('maps missing, mismatched, and unavailable durable profile facts to typed failure', () =>
  Effect.gen(function* unavailableProfileFacts() {
    const missing = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: roleResolver({ outcome: 'INDETERMINATE' }),
      scope,
      transaction: transactionReturning([{ outcome: 'PROFILE_NOT_FOUND', payload: null }]),
    });
    const mismatched = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: roleResolver({ outcome: 'INDETERMINATE' }),
      scope,
      transaction: transactionReturning([
        {
          ...retailProfileRow(),
          payload: { ...retailProfileRow().payload, profileId: 'different-profile' },
        },
      ]),
    });
    const unavailable: ProfileScopedRoutineInvoker = {
      invoke: (routine) => Effect.fail(routineFailure(routine.routineKey)),
    };
    const unavailableEvaluation = makeProfileReactivationEligibilityEvaluator({
      evaluateReconfirmation: noReconfirmationRequired,
      resolveCounterpartyRole: roleResolver({ outcome: 'INDETERMINATE' }),
      scope,
      transaction: unavailable,
    });

    expect(
      (yield* Effect.flip(missing({ ...lifecyclePayload, profileRef: retailProfileRef }))).reason,
    ).toContain('could not be resolved exactly');
    expect(
      (yield* Effect.flip(mismatched({ ...lifecyclePayload, profileRef: retailProfileRef })))
        .reason,
    ).toContain('could not be resolved exactly');
    expect(
      (yield* Effect.flip(
        unavailableEvaluation({ ...lifecyclePayload, profileRef: retailProfileRef }),
      )).reason,
    ).toContain('unavailable');
  }),
);

it.effect('fails closed when its factory has no reviewed reconfirmation policy', () =>
  Effect.gen(function* contextualReactivationFactory() {
    const factory = yield* ProfileReactivationEligibilityEvaluatorFactory;
    const evaluate = factory.make({
      resolveCounterpartyRole: roleResolver({ outcome: 'INDETERMINATE' }),
      scope,
      transaction: transactionReturning([retailProfileRow()]),
    });

    const failure = yield* Effect.flip(
      evaluate({ ...lifecyclePayload, profileRef: retailProfileRef }),
    );
    expect(failure.reason).toContain('reconfirmation policy is configured');
  }).pipe(
    Effect.provide(profileReactivationEligibilityEvaluatorFactoryLive),
    Effect.provideService(ProfileReconfirmationPolicy, profileReconfirmationPolicyUnavailable),
  ),
);
