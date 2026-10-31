import { defineScopedRoutine } from '@app/core-runtime';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import type { ProfileLifecyclePayload } from '../../shared/actions/suspend-customer-profile.ts';
import { ProfileReconfirmationPolicy, ReactivationProfileFactsSchema } from './profile-reconfirmation-policy.ts';
import type { ReactivationProfileFacts, ReconfirmationEvaluator } from './profile-reconfirmation-policy.ts';
import type {
  CounterpartyRoleEligibility,
  ProfilePersistenceDependencies,
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from '../persistence/profile-persistence.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';

export {
  ProfileReconfirmationPolicy,
  profileReconfirmationPolicyUnavailable,
  profileReconfirmationPolicyUnavailableLive,
} from './profile-reconfirmation-policy.ts';
export type { ReconfirmationEvaluator } from './profile-reconfirmation-policy.ts';

const ReactivationProfileRowSchema = Schema.Struct({
  outcome: Schema.String,
  payload: Schema.OptionFromNullOr(ReactivationProfileFactsSchema),
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

type ResolveCounterpartyRole = NonNullable<ProfilePersistenceDependencies['resolveCounterpartyRole']>;
type ReactivationEligibilityEvaluator = NonNullable<ProfilePersistenceDependencies['evaluateReactivation']>;
const dependencyFailure = (reason: string, cause?: unknown): ProfilePersistenceDependencyFailure => {
  const failure = new ProfilePersistenceDependencyFailure({ reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

export const readExactProfileFacts = (
  transaction: ProfileScopedRoutineInvoker,
  scope: ProfilePersistenceScope,
  payload: ProfileLifecyclePayload,
): Effect.Effect<ReactivationProfileFacts, ProfilePersistenceDependencyFailure> => {
  if (payload.profileRef.tenantId !== scope.tenantId) {
    return Effect.fail(dependencyFailure('The reactivation profile belongs to another Tenant'));
  }

  return transaction
    .invoke(readReactivationProfileRoutine, [payload.profileRef.resourceId, payload.profileRef.kind])
    .pipe(
      Effect.mapError((cause) => dependencyFailure('The current Customer Profile subject is unavailable', cause)),
      Effect.flatMap(([row]) => {
        const facts = row?.payload.pipe(Option.getOrUndefined);
        if (
          row === undefined ||
          row.outcome !== 'PROFILE_AVAILABLE' ||
          facts === undefined ||
          facts.profileId !== payload.profileRef.resourceId ||
          facts.profileKind !== payload.profileRef.kind ||
          facts.subject.kind !== payload.profileRef.kind
        ) {
          return Effect.fail(dependencyFailure('The current Customer Profile subject could not be resolved exactly'));
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
    return Effect.fail(dependencyFailure('Current Counterparty customer-role eligibility is indeterminate'));
  }
  if (eligibility.managedLegalEntityId !== scope.legalEntityId) {
    return Effect.fail(dependencyFailure('The Counterparty customer role belongs to another managed Legal Entity'));
  }
  return Effect.succeed(true);
};

export interface PreparedReactivationObservation {
  readonly dependenciesSatisfied: boolean;
  readonly reconfirmationSatisfied: boolean;
  readonly role: CounterpartyRoleEligibility | null;
}

/** Observe external authority using only the immutable owner facts, never a SQL executor. */
export const observeProfileReactivation = (
  facts: ReactivationProfileFacts,
  scope: ProfilePersistenceScope,
  resolveCounterpartyRole: ResolveCounterpartyRole,
  evaluateReconfirmation: ReconfirmationEvaluator,
): Effect.Effect<PreparedReactivationObservation, ProfilePersistenceDependencyFailure> => {
  const role =
    facts.subject.kind === 'RETAIL'
      ? Effect.succeed(null)
      : resolveCounterpartyRole({
          counterpartyResourceId: facts.subject.counterpartyResourceId,
          tenantId: scope.tenantId,
        }).pipe(
          Effect.mapError((cause) =>
            dependencyFailure('Current Counterparty customer-role eligibility is unavailable', cause),
          ),
        );
  return Effect.all({ reconfirmationSatisfied: evaluateReconfirmation(facts), role }, { concurrency: 2 }).pipe(
    Effect.flatMap(({ reconfirmationSatisfied, role: resolvedRole }) =>
      (resolvedRole === null ? Effect.succeed(true) : counterpartyDependenciesSatisfied(resolvedRole, scope)).pipe(
        Effect.map((dependenciesSatisfied) => ({ dependenciesSatisfied, reconfirmationSatisfied, role: resolvedRole })),
      ),
    ),
  );
};

/** Compatibility evaluator for direct owner callers; Actions use the released observation path. */
export const makeProfileReactivationEligibilityEvaluator =
  (
    options: Readonly<{
      readonly evaluateReconfirmation: ReconfirmationEvaluator;
      readonly resolveCounterpartyRole: ResolveCounterpartyRole;
      readonly scope: ProfilePersistenceScope;
      readonly transaction: ProfileScopedRoutineInvoker;
    }>,
  ): ReactivationEligibilityEvaluator =>
  (payload) =>
    readExactProfileFacts(options.transaction, options.scope, payload).pipe(
      Effect.flatMap((facts) =>
        observeProfileReactivation(
          facts,
          options.scope,
          options.resolveCounterpartyRole,
          options.evaluateReconfirmation,
        ),
      ),
      Effect.map(({ dependenciesSatisfied, reconfirmationSatisfied }) => ({
        dependenciesSatisfied,
        reconfirmationSatisfied,
      })),
    );

export interface ProfileReactivationEligibilityEvaluatorFactoryInput {
  readonly resolveCounterpartyRole: ResolveCounterpartyRole;
  readonly scope: ProfilePersistenceScope;
  readonly transaction: ProfileScopedRoutineInvoker;
}

export interface ProfileReactivationObservationInput {
  readonly facts: ReactivationProfileFacts;
  readonly resolveCounterpartyRole: ResolveCounterpartyRole;
  readonly scope: ProfilePersistenceScope;
}

export interface ProfileReactivationEligibilityEvaluatorFactoryService {
  readonly make: (input: ProfileReactivationEligibilityEvaluatorFactoryInput) => ReactivationEligibilityEvaluator;
  readonly observe: (
    input: ProfileReactivationObservationInput,
  ) => Effect.Effect<PreparedReactivationObservation, ProfilePersistenceDependencyFailure>;
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
      observe: ({ facts, resolveCounterpartyRole, scope }: ProfileReactivationObservationInput) =>
        observeProfileReactivation(facts, scope, resolveCounterpartyRole, policy.evaluate),
    });
  }),
);
