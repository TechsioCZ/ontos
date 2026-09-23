/* oxlint-disable effect-native/no-string-timestamp-schema -- These owner-private command DTOs carry already-encoded UTC instants into JSONB routine parameters; the public schemas remain the temporal authority; expires: 2027-03-31. */
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import type {
  AssociateStorefrontPayload,
  CreateMarketPayload,
  RemoveStorefrontAssociationPayload,
  ReviseMarketDefinitionPayload,
  ReviseStorefrontAssociationPayload,
} from '../../shared/action-contracts.ts';
import type { MarketRetirementImpactAssessment } from '../../shared/domain/market-retirement-impact.ts';
import type { MarketLifecycle } from '../../shared/market-contracts.ts';
import {
  associateStorefrontRoutine,
  createMarketRoutine,
  removeStorefrontAssociationRoutine,
  reviseMarketDefinitionRoutine,
  reviseStorefrontAssociationRoutine,
  transitionMarketLifecycleRoutine,
} from './scoped-routine.ts';

const UuidSchema = Schema.String.check(Schema.isUUID());
const DefinitionRevisionIdSchema = UuidSchema.pipe(
  Schema.brand('CommerceMarketDefinitionRevisionId'),
  Schema.decodeTo(UuidSchema),
);
const PositiveRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const GenerationSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const ConflictOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: PositiveRevisionSchema }),
  Schema.TaggedStruct('cross_tenant_reference', {}),
  Schema.TaggedStruct('inconsistent_seller_or_channel', {}),
  Schema.TaggedStruct('invalid_lifecycle_transition', {}),
  Schema.TaggedStruct('market_code_conflict', {}),
  Schema.TaggedStruct('overlapping_association', {}),
  Schema.TaggedStruct('replacement_impact_unresolved', {}),
  Schema.TaggedStruct('seller_identity_immutable', {}),
]);

const CreateOutcomeSchema = Schema.Union([
  ConflictOutcomeSchema,
  Schema.TaggedStruct('created', {
    changed: Schema.Literal(true),
    definitionRevisionId: DefinitionRevisionIdSchema,
    generation: GenerationSchema,
    revision: Schema.Literal(1),
  }),
  Schema.TaggedStruct('reused', {
    changed: Schema.Literal(false),
    definitionRevisionId: DefinitionRevisionIdSchema,
    generation: GenerationSchema,
    revision: PositiveRevisionSchema,
  }),
]);
type CreateMarketPersistenceOutcome = typeof CreateOutcomeSchema.Type;

const RevisionOutcomeSchema = Schema.Union([
  ConflictOutcomeSchema,
  Schema.TaggedStruct('revised', {
    changed: Schema.Boolean,
    definitionRevisionId: DefinitionRevisionIdSchema,
    generation: GenerationSchema,
    previousDefinitionRevisionId: DefinitionRevisionIdSchema,
    revision: PositiveRevisionSchema,
  }),
]);
type ReviseMarketDefinitionPersistenceOutcome = typeof RevisionOutcomeSchema.Type;

const LifecycleOutcomeSchema = Schema.Union([
  ConflictOutcomeSchema,
  Schema.TaggedStruct('transitioned', {
    changed: Schema.Boolean,
    definitionRevisionId: DefinitionRevisionIdSchema,
    generation: GenerationSchema,
    lifecycle: Schema.Literals(['ACTIVE', 'SUSPENDED', 'RETIRED']),
    revision: PositiveRevisionSchema,
  }),
]);
type MarketLifecyclePersistenceOutcome = typeof LifecycleOutcomeSchema.Type;

const AssociationOutcomeSchema = Schema.Union([
  ConflictOutcomeSchema,
  Schema.TaggedStruct('associated', {
    changed: Schema.Boolean,
    generation: GenerationSchema,
    revision: PositiveRevisionSchema,
  }),
  Schema.TaggedStruct('revised', {
    changed: Schema.Boolean,
    generation: GenerationSchema,
    previousRevision: PositiveRevisionSchema,
    revision: PositiveRevisionSchema,
  }),
  Schema.TaggedStruct('removed', {
    changed: Schema.Boolean,
    generation: GenerationSchema,
    revision: PositiveRevisionSchema,
  }),
]);
type StorefrontAssociationPersistenceOutcome = typeof AssociationOutcomeSchema.Type;

export class MarketAdministrationPersistenceUnavailable extends Schema.TaggedError<MarketAdministrationPersistenceUnavailable>()(
  'MarketAdministrationPersistenceUnavailable',
  {
    code: Schema.Literal('market_administration_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

interface MarketAdministrationCommandContext {
  readonly actionInvocationId: string;
  readonly principalId: string;
  readonly recordedAt: string;
}

type EncodedEffectivePeriod = Readonly<{ readonly endsAt?: string; readonly startsAt: string }>;
type CreateCommand = Omit<CreateMarketPayload, 'effectivePeriod'> &
  MarketAdministrationCommandContext &
  Readonly<{ readonly effectivePeriod: EncodedEffectivePeriod }>;
type ReviseDefinitionCommand = Omit<ReviseMarketDefinitionPayload, 'effectivePeriod'> &
  MarketAdministrationCommandContext &
  Readonly<{ readonly effectivePeriod: EncodedEffectivePeriod }>;
type AssociateCommand = Omit<AssociateStorefrontPayload, 'effectivePeriod'> &
  MarketAdministrationCommandContext &
  Readonly<{ readonly effectivePeriod: EncodedEffectivePeriod }>;
type ReviseAssociationCommand = Omit<ReviseStorefrontAssociationPayload, 'effectivePeriod'> &
  MarketAdministrationCommandContext &
  Readonly<{ readonly effectivePeriod: EncodedEffectivePeriod }>;
type RemoveAssociationCommand = Omit<RemoveStorefrontAssociationPayload, 'effectiveAt'> &
  MarketAdministrationCommandContext &
  Readonly<{ readonly effectiveAt: string }>;

interface LifecycleCommand extends MarketAdministrationCommandContext {
  readonly effectiveAt: string;
  readonly expectedCurrentDefinitionRevisionId: string;
  readonly expectedRevision: number;
  readonly lifecycle: MarketLifecycle;
  readonly marketId: string;
  readonly reason: string;
  readonly retirementImpactAssessment?: MarketRetirementImpactAssessment;
  readonly tenantId: string;
}

export interface MarketAdministrationPersistence {
  readonly associateStorefront: (
    input: AssociateCommand,
  ) => Effect.Effect<StorefrontAssociationPersistenceOutcome, MarketAdministrationPersistenceUnavailable>;
  readonly createMarket: (
    input: CreateCommand,
  ) => Effect.Effect<CreateMarketPersistenceOutcome, MarketAdministrationPersistenceUnavailable>;
  readonly removeStorefrontAssociation: (
    input: RemoveAssociationCommand,
  ) => Effect.Effect<StorefrontAssociationPersistenceOutcome, MarketAdministrationPersistenceUnavailable>;
  readonly reviseMarketDefinition: (
    input: ReviseDefinitionCommand,
  ) => Effect.Effect<ReviseMarketDefinitionPersistenceOutcome, MarketAdministrationPersistenceUnavailable>;
  readonly reviseStorefrontAssociation: (
    input: ReviseAssociationCommand,
  ) => Effect.Effect<StorefrontAssociationPersistenceOutcome, MarketAdministrationPersistenceUnavailable>;
  readonly transitionLifecycle: (
    input: LifecycleCommand,
  ) => Effect.Effect<MarketLifecyclePersistenceOutcome, MarketAdministrationPersistenceUnavailable>;
}

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (cause: unknown): MarketAdministrationPersistenceUnavailable => {
  const failure = new MarketAdministrationPersistenceUnavailable({
    code: 'market_administration_persistence_unavailable',
    reason: 'Market administration persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const invoke = <A, I extends object>(
  transaction: ScopedTransaction,
  routine: typeof associateStorefrontRoutine,
  input: I,
  schema: Schema.Decoder<A>,
): Effect.Effect<A, MarketAdministrationPersistenceUnavailable> =>
  transaction.invoke(routine, [input]).pipe(
    Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
    Effect.flatMap((rows) => {
      const [row] = rows;
      return row === undefined
        ? Effect.fail(unavailable({ reason: `The ${routine.routineKey} routine returned no outcome` }))
        : Schema.decodeUnknownEffect(schema)(row.payload).pipe(Effect.mapError(unavailable));
    }),
  );

const scopeMatches = (
  scope: OperationalScope & { readonly legalEntityId: string },
  tenantId: string,
  legalEntityId: string,
): boolean => scope.tenantId === tenantId && scope.legalEntityId === legalEntityId;

const marketAdministrationPersistenceForTransaction = (
  transaction: ScopedTransaction,
  scope: OperationalScope & { readonly legalEntityId: string },
): MarketAdministrationPersistence => ({
  associateStorefront: (input) =>
    scopeMatches(scope, input.marketRef.tenantId, input.sellingLegalEntityRef.resourceId)
      ? invoke(transaction, associateStorefrontRoutine, input, AssociationOutcomeSchema)
      : Effect.fail(unavailable({ reason: 'The Storefront association scope is inconsistent' })),
  createMarket: (input) =>
    scopeMatches(scope, input.sellingLegalEntityRef.tenantId, input.sellingLegalEntityRef.resourceId)
      ? invoke(transaction, createMarketRoutine, input, CreateOutcomeSchema)
      : Effect.fail(unavailable({ reason: 'The Market creation scope is inconsistent' })),
  removeStorefrontAssociation: (input) =>
    scope.tenantId === input.marketRef.tenantId
      ? invoke(transaction, removeStorefrontAssociationRoutine, input, AssociationOutcomeSchema)
      : Effect.fail(unavailable({ reason: 'The Storefront association removal scope is inconsistent' })),
  reviseMarketDefinition: (input) =>
    scope.tenantId === input.marketRef.tenantId
      ? invoke(transaction, reviseMarketDefinitionRoutine, input, RevisionOutcomeSchema)
      : Effect.fail(unavailable({ reason: 'The Market definition scope is inconsistent' })),
  reviseStorefrontAssociation: (input) =>
    scope.tenantId === input.marketRef.tenantId
      ? invoke(transaction, reviseStorefrontAssociationRoutine, input, AssociationOutcomeSchema)
      : Effect.fail(unavailable({ reason: 'The Storefront association revision scope is inconsistent' })),
  transitionLifecycle: (input) =>
    scope.tenantId === input.tenantId
      ? invoke(transaction, transitionMarketLifecycleRoutine, input, LifecycleOutcomeSchema)
      : Effect.fail(unavailable({ reason: 'The Market lifecycle scope is inconsistent' })),
});

export const marketAdministrationPersistenceForScope: ReadServiceFactory<MarketAdministrationPersistence> = (
  transaction,
  scope,
) => {
  const { legalEntityId } = scope;
  return legalEntityId === undefined
    ? Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Market administration requires a trusted Legal Entity scope',
        }),
      )
    : Effect.succeed(marketAdministrationPersistenceForTransaction(transaction, { ...scope, legalEntityId }));
};
