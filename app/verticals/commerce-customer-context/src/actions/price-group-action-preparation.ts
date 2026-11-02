import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type {
  ActionServiceFactory,
  ActionServicePreparationContext,
  OperationalScope,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { AssignCustomerPriceGroupPayloadSchema } from '../../shared/actions/assign-customer-price-group.ts';
import { AssignCounterpartyPriceGroupPayloadSchema } from '../../shared/actions/assign-counterparty-price-group.ts';
import { MigrateCustomerPriceGroupPayloadSchema } from '../../shared/actions/migrate-customer-price-group.ts';
import { MigrateCounterpartyPriceGroupPayloadSchema } from '../../shared/actions/migrate-counterparty-price-group.ts';
import {
  PriceGroupCompatibilityEvidenceSchema,
  PriceGroupInstantJsonSchema,
  samePriceGroupRef,
} from '../../shared/domain/price-group-contracts.ts';
import type {
  PriceGroupCatalogOutcome,
  PriceGroupCompatibilityEvidence,
} from '../../shared/domain/price-group-contracts.ts';
import {
  CustomerPriceGroupCatalogUnavailable,
  CustomerPriceGroupPersistenceUnavailable,
  CustomerPriceGroupScopeMismatch,
} from '../../shared/domain/price-group-errors.ts';
import type { CustomerPriceGroupProfileUnavailable } from '../../shared/domain/price-group-errors.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';
import type {
  AssignCustomerPriceGroupStoreInput,
  CustomerPriceGroupProfileValidation,
  CustomerPriceGroupProfileValidationPort,
  MigrateCustomerPriceGroupStoreInput,
  PriceGroupCatalogPort,
} from '../../shared/domain/price-group-ports.ts';
import { priceGroupCatalogPortFromEnvironment } from '../integrations/price-group-catalog.ts';
import { customerPriceGroupProfileValidationForTransaction } from '../persistence/price-group-persistence.ts';
import { priceGroupLocalActionServicesForTransaction } from './price-group-action-services.ts';
import type { PriceGroupActionServices } from './price-group-action-services.ts';

const AssignmentPayloadSchema = Schema.Union([
  AssignCustomerPriceGroupPayloadSchema,
  AssignCounterpartyPriceGroupPayloadSchema,
]);
const CounterpartyPayloadSchema = Schema.Union([
  AssignCounterpartyPriceGroupPayloadSchema,
  MigrateCounterpartyPriceGroupPayloadSchema,
]);
const MutationPayloadSchema = Schema.Union([
  AssignCustomerPriceGroupPayloadSchema,
  AssignCounterpartyPriceGroupPayloadSchema,
  MigrateCustomerPriceGroupPayloadSchema,
  MigrateCounterpartyPriceGroupPayloadSchema,
]);
type MutationPayload = typeof MutationPayloadSchema.Type;
type UsableCatalogOutcome = Extract<PriceGroupCatalogOutcome, { readonly _tag: 'USABLE' }>;
type MutationInput = AssignCustomerPriceGroupStoreInput | MigrateCustomerPriceGroupStoreInput;
type AssignmentCandidate = Pick<
  AssignCustomerPriceGroupStoreInput,
  'counterpartyRef' | 'effectiveFrom' | 'expectedProfileRevision' | 'priceGroupRef' | 'profile' | 'reason'
> & {
  readonly effectiveTo?: string;
};
type MigrationCandidate = Pick<
  MigrateCustomerPriceGroupStoreInput,
  'counterpartyRef' | 'effectiveFrom' | 'reason' | 'sourcePriceGroupRef' | 'targetPriceGroupRef' | 'targets'
>;
type MutationCandidate = AssignmentCandidate | MigrationCandidate;

interface PreparedPriceGroupMutation {
  readonly actionInvocationId: string;
  readonly compositionRevision: string;
  readonly intent: MutationPayload;
  readonly outcome: PriceGroupCatalogOutcome | undefined;
  readonly scope: OperationalScope;
  readonly snapshot: readonly CustomerPriceGroupProfileValidation[];
  readonly trustedOperationAt: PriceGroupCompatibilityEvidence['trustedOperationAt'];
}

const catalogUnavailable = () =>
  new CustomerPriceGroupCatalogUnavailable({
    code: 'customer_price_group_catalog_unavailable',
    reason: 'Prepared PriceGroup evidence is unavailable, expired, or belongs to a different mutation',
  });
const contextUnavailable = () =>
  new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'The prepared PriceGroup owner snapshot or operation scope changed',
  });
const profileContextUnavailable = (cause: CustomerPriceGroupProfileUnavailable) =>
  Object.defineProperty(contextUnavailable(), 'cause', { configurable: true, value: cause });
const persistenceUnavailable = () =>
  new CustomerPriceGroupPersistenceUnavailable({
    code: 'customer_price_group_persistence_unavailable',
    reason: 'Prepared PriceGroup evidence does not authorize this exact current mutation',
  });
const instantMillis = (instant: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(instant));
const usableOutcome = (outcome: PriceGroupCatalogOutcome | undefined) =>
  outcome === undefined
    ? undefined
    : Match.value(outcome).pipe(
        Match.tag('USABLE', (usable) => usable),
        Match.option,
        Option.getOrUndefined,
      );
const counterpartyForMutation = (payload: MutationPayload) =>
  Schema.is(CounterpartyPayloadSchema)(payload) ? payload.counterpartyRef : undefined;
const catalogRefForMutation = (payload: MutationPayload) =>
  Schema.is(AssignmentPayloadSchema)(payload) ? payload.priceGroupRef : payload.targetPriceGroupRef;

/** A freshness cap can shorten the owner's End, never replace a missing period. */
export const preparedPriceGroupWindowOpen = (
  evidence: PriceGroupCompatibilityEvidence,
  trustedOperationAt: string,
  now: number,
): boolean => {
  if (!Schema.is(PriceGroupCompatibilityEvidenceSchema)(evidence)) {
    return false;
  }
  const trustedAt = instantMillis(trustedOperationAt);
  const verifiedAt = instantMillis(evidence.verifiedAt);
  const ownerEnd = evidence.definitionEffectivePeriod.effectiveTo;
  return (
    evidence.trustedOperationAt === trustedOperationAt &&
    Number.isFinite(now) &&
    trustedAt <= verifiedAt &&
    verifiedAt <= now &&
    now < trustedAt + 30_000 &&
    (ownerEnd === null || now < instantMillis(ownerEnd))
  );
};

export const preparedPriceGroupScopeMatches = (
  expected: OperationalScope,
  actual: OperationalScope,
  expectedRevision: string,
  actualRevision: string,
): boolean =>
  expectedRevision === actualRevision &&
  expected.legalEntityId !== undefined &&
  expected.legalEntityId === actual.legalEntityId &&
  expected.trustedStorefrontId === actual.trustedStorefrontId &&
  expected.audience === actual.audience &&
  expected.correlationId === actual.correlationId &&
  expected.traceId === actual.traceId &&
  Schema.toEquivalence(TrustedPrincipalContextSchema)(expected, actual);

export const preparedPriceGroupPayloadMatches = (expected: MutationPayload, actual: MutationCandidate): boolean =>
  Schema.is(MutationPayloadSchema)(actual) &&
  (counterpartyForMutation(expected) === undefined) === (actual.counterpartyRef === undefined) &&
  Schema.is(AssignmentPayloadSchema)(expected) === Schema.is(AssignmentPayloadSchema)(actual) &&
  Schema.toEquivalence(MutationPayloadSchema)(expected, actual);

export const samePreparedPriceGroupProfile = (
  expected: CustomerPriceGroupProfileValidation,
  actual: CustomerPriceGroupProfileValidation,
): boolean =>
  Match.value(expected).pipe(
    Match.tagsExhaustive({
      CURRENT: (previous) =>
        Match.value(actual).pipe(
          Match.tagsExhaustive({
            CURRENT: (current) =>
              previous.revision === current.revision &&
              previous.state === current.state &&
              (previous.counterpartyRef === null || current.counterpartyRef === null
                ? previous.counterpartyRef === current.counterpartyRef
                : samePriceGroupRef(previous.counterpartyRef, current.counterpartyRef)),
            NOT_FOUND: () => false,
          }),
        ),
      NOT_FOUND: () => Match.value(actual).pipe(Match.tagsExhaustive({ CURRENT: () => false, NOT_FOUND: () => true })),
    }),
  );

const profilesForMutation = (payload: MutationPayload) =>
  Schema.is(AssignmentPayloadSchema)(payload)
    ? [{ expectedProfileRevision: payload.expectedProfileRevision, profile: payload.profile }]
    : payload.targets;
const inspectMutationProfiles = (payload: MutationPayload, profiles: CustomerPriceGroupProfileValidationPort) =>
  Effect.forEach(
    profilesForMutation(payload),
    ({ profile }) => profiles.inspect(profile, payload.effectiveFrom, counterpartyForMutation(payload)),
    { concurrency: 1 },
  );
export const priceGroupMutationCanReachCatalog = (
  payload: MutationPayload,
  profiles: readonly CustomerPriceGroupProfileValidation[],
  now: number,
): boolean => {
  const targets = profilesForMutation(payload);
  const counterparty = counterpartyForMutation(payload);
  return (
    instantMillis(payload.effectiveFrom) >= now &&
    (Schema.is(AssignmentPayloadSchema)(payload) ||
      !samePriceGroupRef(payload.sourcePriceGroupRef, payload.targetPriceGroupRef)) &&
    profiles.length === targets.length &&
    profiles.every((profile, index) =>
      Match.value(profile).pipe(
        Match.tagsExhaustive({
          CURRENT: (current) =>
            current.state === 'ACTIVE' &&
            current.revision === targets[index]?.expectedProfileRevision &&
            (counterparty === undefined ||
              (current.counterpartyRef !== null && samePriceGroupRef(current.counterpartyRef, counterparty))),
          NOT_FOUND: () => false,
        }),
      ),
    )
  );
};
const assignmentPayload = (input: AssignCustomerPriceGroupStoreInput): AssignmentCandidate => {
  const base = {
    effectiveFrom: input.effectiveFrom,
    expectedProfileRevision: input.expectedProfileRevision,
    priceGroupRef: input.priceGroupRef,
    profile: input.profile,
    reason: input.reason,
  };
  const period = input.effectiveTo === null ? base : { ...base, effectiveTo: input.effectiveTo };
  return input.counterpartyRef === undefined ? period : { ...period, counterpartyRef: input.counterpartyRef };
};
const migrationPayload = (input: MigrateCustomerPriceGroupStoreInput): MigrationCandidate => {
  const base = {
    effectiveFrom: input.effectiveFrom,
    reason: input.reason,
    sourcePriceGroupRef: input.sourcePriceGroupRef,
    targetPriceGroupRef: input.targetPriceGroupRef,
    targets: input.targets,
  };
  return input.counterpartyRef === undefined ? base : { ...base, counterpartyRef: input.counterpartyRef };
};
const mutationMatches = (
  payload: MutationPayload,
  actionInvocationId: string,
  scope: OperationalScope,
  compatibility: PriceGroupCompatibilityEvidence,
  input: MutationInput,
  candidate: MutationCandidate,
): boolean =>
  input.actionInvocationId === actionInvocationId &&
  input.principalId === scope.principalId &&
  input.tenantId === scope.tenantId &&
  preparedPriceGroupPayloadMatches(payload, candidate) &&
  Schema.is(PriceGroupCompatibilityEvidenceSchema)(input.compatibility) &&
  Schema.toEquivalence(PriceGroupCompatibilityEvidenceSchema)(compatibility, input.compatibility);
export const preparedPriceGroupAssignmentMatches = (
  payload: MutationPayload,
  invocation: string,
  scope: OperationalScope,
  compatibility: PriceGroupCompatibilityEvidence,
  input: AssignCustomerPriceGroupStoreInput,
): boolean => mutationMatches(payload, invocation, scope, compatibility, input, assignmentPayload(input));
export const preparedPriceGroupMigrationMatches = (
  payload: MutationPayload,
  invocation: string,
  scope: OperationalScope,
  compatibility: PriceGroupCompatibilityEvidence,
  input: MigrateCustomerPriceGroupStoreInput,
): boolean => mutationMatches(payload, invocation, scope, compatibility, input, migrationPayload(input));
const exactCatalogEvidence = (
  outcome: UsableCatalogOutcome,
  payload: MutationPayload,
  trustedOperationAt: string,
  now: number,
) => {
  const ref = catalogRefForMutation(payload);
  return (
    samePriceGroupRef(outcome.priceGroupRef, ref) &&
    samePriceGroupRef(outcome.compatibility.priceGroupRef, ref) &&
    outcome.compatibility.requiredContract.contractId === CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT &&
    outcome.compatibility.requiredContract.version === 1 &&
    preparedPriceGroupWindowOpen(outcome.compatibility, trustedOperationAt, now)
  );
};
const windowOpen = (prepared: PreparedPriceGroupMutation, now: number) => {
  const usable = usableOutcome(prepared.outcome);
  return usable !== undefined && exactCatalogEvidence(usable, prepared.intent, prepared.trustedOperationAt, now);
};
const resolvePreparedCatalog = Effect.fn('PriceGroupAction.preparedCatalogRead')(function* resolve(
  prepared: PreparedPriceGroupMutation,
  requestedRef: Parameters<PriceGroupCatalogPort['resolveCurrent']>[0],
  contract: Parameters<PriceGroupCatalogPort['resolveCurrent']>[1],
  operationAt: string,
  expected: PriceGroupCompatibilityEvidence | undefined,
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (
    prepared.outcome === undefined ||
    !samePriceGroupRef(requestedRef, catalogRefForMutation(prepared.intent)) ||
    contract !== CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT ||
    expected !== undefined ||
    !Schema.is(PriceGroupInstantJsonSchema)(operationAt) ||
    instantMillis(operationAt) < instantMillis(prepared.trustedOperationAt) ||
    instantMillis(operationAt) > now ||
    (usableOutcome(prepared.outcome) !== undefined && !windowOpen(prepared, now))
  ) {
    return yield* catalogUnavailable();
  }
  // Preserve the owner's trustedOperationAt and actual exclusive definition End.
  return prepared.outcome;
});
const assignPrepared = Effect.fn('PriceGroupAction.assignPrepared')(function* assign(
  prepared: PreparedPriceGroupMutation,
  services: Omit<PriceGroupActionServices, 'catalog'>,
  input: AssignCustomerPriceGroupStoreInput,
) {
  const now = yield* DateTime.now;
  const usable = usableOutcome(prepared.outcome);
  if (
    usable === undefined ||
    !windowOpen(prepared, DateTime.toEpochMillis(now)) ||
    !preparedPriceGroupAssignmentMatches(
      prepared.intent,
      prepared.actionInvocationId,
      prepared.scope,
      usable.compatibility,
      input,
    )
  ) {
    return yield* persistenceUnavailable();
  }
  if (instantMillis(input.effectiveFrom) < DateTime.toEpochMillis(now)) {
    return { _tag: 'retroactive_schedule' } as const;
  }
  const result = yield* services.store.assign({ ...input, recordedAt: DateTime.formatIso(now) });
  const settledAt = DateTime.toEpochMillis(yield* DateTime.now);
  if (!windowOpen(prepared, settledAt)) {
    return yield* persistenceUnavailable();
  }
  if (instantMillis(input.effectiveFrom) < settledAt) {
    return { _tag: 'retroactive_schedule' } as const;
  }
  return result;
});
const migratePrepared = Effect.fn('PriceGroupAction.migratePrepared')(function* migrate(
  prepared: PreparedPriceGroupMutation,
  services: Omit<PriceGroupActionServices, 'catalog'>,
  input: MigrateCustomerPriceGroupStoreInput,
) {
  const now = yield* DateTime.now;
  const usable = usableOutcome(prepared.outcome);
  if (
    usable === undefined ||
    !windowOpen(prepared, DateTime.toEpochMillis(now)) ||
    !preparedPriceGroupMigrationMatches(
      prepared.intent,
      prepared.actionInvocationId,
      prepared.scope,
      usable.compatibility,
      input,
    )
  ) {
    return yield* persistenceUnavailable();
  }
  if (instantMillis(input.effectiveFrom) < DateTime.toEpochMillis(now)) {
    return { _tag: 'retroactive_schedule' } as const;
  }
  const result = yield* services.store.migrate({ ...input, recordedAt: DateTime.formatIso(now) });
  const settledAt = DateTime.toEpochMillis(yield* DateTime.now);
  if (!windowOpen(prepared, settledAt)) {
    return yield* persistenceUnavailable();
  }
  if (instantMillis(input.effectiveFrom) < settledAt) {
    return { _tag: 'retroactive_schedule' } as const;
  }
  return result;
});
const preparedServicesForTransaction = Effect.fn('PriceGroupAction.finalOwnerServices')(function* finalOwnerServices(
  prepared: PreparedPriceGroupMutation,
  transaction: ScopedTransactionExecutor,
  actualScope: OperationalScope,
  revision: string,
) {
  if (!preparedPriceGroupScopeMatches(prepared.scope, actualScope, prepared.compositionRevision, revision)) {
    return yield* contextUnavailable();
  }
  const services = yield* priceGroupLocalActionServicesForTransaction(transaction, actualScope);
  const current = yield* inspectMutationProfiles(prepared.intent, services.profileValidation).pipe(
    Effect.mapError(profileContextUnavailable),
  );
  if (
    current.length !== prepared.snapshot.length ||
    current.some((profile, index) => {
      const previous = prepared.snapshot[index];
      return previous === undefined || !samePreparedPriceGroupProfile(previous, profile);
    })
  ) {
    return yield* contextUnavailable();
  }
  const owner: PriceGroupActionServices = {
    ...services,
    catalog: {
      resolveCurrent: (ref, contract, at, expected) => resolvePreparedCatalog(prepared, ref, contract, at, expected),
    },
    store: {
      ...services.store,
      assign: (input) => assignPrepared(prepared, services, input),
      migrate: (input) => migratePrepared(prepared, services, input),
    },
  };
  return owner;
});

/** Snapshot SQL releases before Catalog HTTP. Final owner rechecks and native CAS still run in SQL. */
export const preparePriceGroupActionServices = Effect.fn('PriceGroupAction.prepareServices')(function* prepareServices(
  payload: MutationPayload,
  context: ActionServicePreparationContext,
) {
  const intent = structuredClone(payload);
  const scope = structuredClone(context.scope);
  const { actionInvocationId, compositionRevision } = context;
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return yield* contextUnavailable();
  }
  const assignment = Schema.is(AssignmentPayloadSchema)(intent);
  const counterparty = counterpartyForMutation(intent);
  const refs = [...profilesForMutation(intent).map(({ profile }) => profile), catalogRefForMutation(intent)];
  if (!assignment) {
    refs.push(intent.sourcePriceGroupRef, ...intent.targets.map((target) => target.assignmentRef));
  }
  if (counterparty !== undefined) {
    refs.push(counterparty);
  }
  if (refs.some((ref) => ref.tenantId !== scope.tenantId)) {
    return yield* new CustomerPriceGroupScopeMismatch({
      code: 'customer_price_group_scope_mismatch',
      reason: 'Every PriceGroup mutation reference must belong to the trusted Tenant',
    });
  }
  const trustedOperationAt = DateTime.formatIso(yield* DateTime.now);
  const { catalog, snapshot } = yield* Effect.all(
    {
      catalog: priceGroupCatalogPortFromEnvironment({ compositionRevision, requestCorrelation: scope.correlationId }),
      snapshot: context.transaction((transaction) =>
        inspectMutationProfiles(
          intent,
          customerPriceGroupProfileValidationForTransaction(transaction, { ...scope, legalEntityId }),
        ),
      ),
    },
    { concurrency: 1 },
  );
  // Adapter construction above issues no credential. HTTP starts only after the snapshot releases.
  // Already-retroactive intent reaches no Catalog. Final SQL permission admission must precede
  // the handler's fresh-time scheduling rejection, rather than preparation replacing a 403.
  const outcome = priceGroupMutationCanReachCatalog(intent, snapshot, DateTime.toEpochMillis(yield* DateTime.now))
    ? yield* catalog.resolveCurrent(
        catalogRefForMutation(intent),
        CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT,
        trustedOperationAt,
      )
    : undefined;
  const usable = usableOutcome(outcome);
  if (
    usable !== undefined &&
    !exactCatalogEvidence(usable, intent, trustedOperationAt, DateTime.toEpochMillis(yield* DateTime.now))
  ) {
    return yield* catalogUnavailable();
  }
  const prepared = { actionInvocationId, compositionRevision, intent, outcome, scope, snapshot, trustedOperationAt };
  const factory: ActionServiceFactory<PriceGroupActionServices> = (transaction, actualScope, revision) =>
    preparedServicesForTransaction(prepared, transaction, actualScope, revision);
  return factory;
});
