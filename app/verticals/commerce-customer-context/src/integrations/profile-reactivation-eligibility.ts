import { defineScopedRoutine } from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';

import type { ProfileLifecyclePayload } from '../../shared/actions/suspend-customer-profile.ts';
import {
  ProfileReconfirmationPolicy,
  ReactivationProfileFactsSchema,
} from './profile-reconfirmation-policy.ts';
import type {
  ReactivationProfileFacts,
  ReconfirmationEvaluator,
} from './profile-reconfirmation-policy.ts';
import type {
  CounterpartyRoleEligibility,
  ProfilePersistenceDependencies,
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from '../persistence/profile-persistence.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';

export {
  ProfileReconfirmationPolicy,
  noHighRiskProfileReconfirmationPolicy,
  profileReconfirmationPolicyUnavailable,
  profileReconfirmationPolicyUnavailableLive,
} from './profile-reconfirmation-policy.ts';
export type {
  ProfileReconfirmationPolicyService,
  ReconfirmationEvaluator,
  ReactivationProfileFacts,
} from './profile-reconfirmation-policy.ts';

const ReactivationProfileRowSchema = Schema.Struct({
  outcome: Schema.String,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- PostgreSQL returns a NULL payload for unavailable or reconciliation-required profile outcomes; this owner adapter rejects those rows before domain use; expires: 2027-03-31.
  payload: Schema.NullOr(ReactivationProfileFactsSchema),
});

const readReactivationProfileRoutine = defineScopedRoutine({
  name: 'read_customer_profile',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: ReactivationProfileRowSchema,
  routineKey: 'profile.reactivation-read',
  schema: 'commerce_customer_context',
});

type ResolveCounterpartyRole = NonNullable<
  ProfilePersistenceDependencies['resolveCounterpartyRole']
>;
type ReactivationEligibilityEvaluator = NonNullable<
  ProfilePersistenceDependencies['evaluateReactivation']
>;
const dependencyFailure = (
  reason: string,
  cause?: unknown,
): ProfilePersistenceDependencyFailure => {
  const failure = new ProfilePersistenceDependencyFailure({ reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const readExactProfileFacts = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  payload: ProfileLifecyclePayload,
): Effect.Effect<ReactivationProfileFacts, ProfilePersistenceDependencyFailure> => {
  if (payload.profileRef.tenantId !== scope.tenantId) {
    return Effect.fail(dependencyFailure('The reactivation profile belongs to another Tenant'));
  }

  return transaction
    .invoke(readReactivationProfileRoutine, [
      payload.profileRef.resourceId,
      payload.profileRef.kind,
    ])
    .pipe(
      Effect.mapError((cause) =>
        dependencyFailure('The current Customer Profile subject is unavailable', cause),
      ),
      Effect.flatMap(([row]) => {
        const facts = row?.payload;
        if (
          row === undefined ||
          row.outcome !== 'PROFILE_AVAILABLE' ||
          facts === null ||
          facts === undefined ||
          facts.profileId !== payload.profileRef.resourceId ||
          facts.profileKind !== payload.profileRef.kind ||
          facts.subject.kind !== payload.profileRef.kind
        ) {
          return Effect.fail(
            dependencyFailure('The current Customer Profile subject could not be resolved exactly'),
          );
        }
        return Effect.succeed(facts);
      }),
    );
};

const counterpartyDependenciesSatisfied = (
  eligibility: CounterpartyRoleEligibility,
  scope: ProfilePersistenceScope,
): Effect.Effect<boolean, ProfilePersistenceDependencyFailure> => {
  if (eligibility.outcome === 'INELIGIBLE') {
    return Effect.succeed(false);
  }
  if (eligibility.outcome !== 'ELIGIBLE') {
    return Effect.fail(
      dependencyFailure('Current Counterparty customer-role eligibility is indeterminate'),
    );
  }
  if (eligibility.managedLegalEntityId !== scope.legalEntityId) {
    return Effect.fail(
      dependencyFailure('The Counterparty customer role belongs to another managed Legal Entity'),
    );
  }
  return Effect.succeed(true);
};

/**
 * Builds the transaction-bound reactivation decision input. The profile subject is re-read from
 * CCC-owned durable state. The transition routine remains responsible for the final reconciliation
 * and expected-state/revision checks, so a concurrent change cannot be authorized by this read.
 */
export const makeProfileReactivationEligibilityEvaluator = (
  options: Readonly<{
    readonly evaluateReconfirmation: ReconfirmationEvaluator;
    readonly resolveCounterpartyRole: ResolveCounterpartyRole;
    readonly scope: ProfilePersistenceScope;
    readonly transaction: ProfileScopedRoutineInvoker;
  }>,
): ReactivationEligibilityEvaluator => {
  const { scope, transaction } = options;
  return (payload) =>
    readExactProfileFacts(transaction, scope, payload).pipe(
      Effect.flatMap((facts) => {
        const dependenciesSatisfied =
          facts.subject.kind === 'RETAIL'
            ? Effect.succeed(true)
            : options
                .resolveCounterpartyRole({
                  counterpartyResourceId: facts.subject.counterpartyResourceId,
                  tenantId: scope.tenantId,
                })
                .pipe(
                  Effect.mapError((cause) =>
                    dependencyFailure(
                      'Current Counterparty customer-role eligibility is unavailable',
                      cause,
                    ),
                  ),
                  Effect.flatMap((eligibility) =>
                    counterpartyDependenciesSatisfied(eligibility, scope),
                  ),
                );
        const reconfirmationSatisfied = options.evaluateReconfirmation(facts);

        return Effect.all({ dependenciesSatisfied, reconfirmationSatisfied }, { concurrency: 2 });
      }),
    );
};

export interface ProfileReactivationEligibilityEvaluatorFactoryInput {
  readonly resolveCounterpartyRole: ResolveCounterpartyRole;
  readonly scope: ProfilePersistenceScope;
  readonly transaction: ProfileScopedRoutineInvoker;
}

export interface ProfileReactivationEligibilityEvaluatorFactoryService {
  readonly make: (
    input: ProfileReactivationEligibilityEvaluatorFactoryInput,
  ) => ReactivationEligibilityEvaluator;
}

/**
 * Reconfirmation is an owner decision, not a convenience default.  Keeping it behind a
 * Context.Service makes the deployment policy explicit and prevents a missing policy from being
 * interpreted as permission to reactivate a profile.
 */
export class ProfileReactivationEligibilityEvaluatorFactory extends Context.Service<
  ProfileReactivationEligibilityEvaluatorFactory,
  ProfileReactivationEligibilityEvaluatorFactoryService
>()(
  '@app/commerce-customer-context/integrations/profile-reactivation-eligibility/ProfileReactivationEligibilityEvaluatorFactory',
) {}

export const profileReactivationEligibilityEvaluatorFactoryLive = Layer.effect(
  ProfileReactivationEligibilityEvaluatorFactory,
  Effect.gen(function* profileReactivationFactoryLayer() {
    const policy = yield* ProfileReconfirmationPolicy;
    return Object.freeze({
      make: (input: ProfileReactivationEligibilityEvaluatorFactoryInput) =>
        makeProfileReactivationEligibilityEvaluator({
          ...input,
          evaluateReconfirmation: policy.evaluate,
        }),
    });
  }),
);
