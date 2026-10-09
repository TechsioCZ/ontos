import { createHash } from 'node:crypto';

import type { Effect as EffectType, Option as OptionType } from 'effect';
import { Effect, Option, Schema } from 'effect';

import type {
  InventorySourceImportLedgerEntry,
  InventorySourceImportOutcome,
} from '../../shared/domain/inventory-source-import-outcome.ts';
import { InventorySourceImportUnavailable as InventorySourceImportUnavailableError } from '../../shared/domain/inventory-source-import-outcome.ts';
import type {
  AssertionIntegrityConflictCandidateSchema,
  CorrelationConflictCandidateSchema,
  FactValueConflictCandidateSchema,
} from '../../shared/domain/inventory-source-conflict.ts';
import type { InventorySourceAssertionProposal } from '../../shared/domain/inventory-source-assertion.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryBackendConfigurationPersistenceUnavailable } from '../../shared/domain/inventory-backend-configuration-persistence-unavailable.ts';
import { AmbiguousExternalStockCorrelationSchema } from '../../shared/domain/external-stock-correlation.ts';
import type {
  ExternalStockCorrelationPersistenceError,
  ExternalStockCorrelationResolution,
} from '../../shared/domain/external-stock-correlation.ts';
import {
  canonicalInventorySourceAssertionMaterial,
  compareInventorySourceOrdering,
  inventorySourceAssertionsClaimSameIdentityOrRevision,
  inventorySourceAssertionsHaveSameMaterialContent,
  inventorySourceAssertionsShareStream,
} from '../../shared/domain/inventory-source-ordering.ts';
import { InventorySourceConflictRefSchema } from '../../shared/resources/inventory-source-conflict.ts';
import type { InventorySourceConflictRef } from '../../shared/resources/inventory-source-conflict.ts';
import type { InventorySourceConflictService } from './inventory-source-conflict.service.ts';

interface ConfigurationReader {
  readonly findCurrent: (
    customerConfigurationId: string,
  ) => EffectType.Effect<
    OptionType.Option<InventoryBackendConfiguration>,
    InventoryBackendConfigurationPersistenceUnavailable
  >;
}

interface CorrelationResolver {
  readonly resolve: (input: {
    readonly asOf: string;
    readonly externalKey: InventorySourceAssertionProposal['itemExternalKey'];
    readonly selectedConfiguration: InventoryBackendConfiguration;
  }) => EffectType.Effect<ExternalStockCorrelationResolution, ExternalStockCorrelationPersistenceError>;
}

interface InventorySourceConflictOutcomeFinalizerDependencies {
  readonly configurations: ConfigurationReader;
  readonly conflicts: Pick<InventorySourceConflictService, 'register'>;
  readonly correlations: CorrelationResolver;
}

export interface InventorySourceConflictOutcomeFinalizerInput {
  readonly acceptedHistory: readonly InventorySourceImportLedgerEntry[];
  readonly outcome: InventorySourceImportOutcome;
  readonly proposal: InventorySourceAssertionProposal;
}

const unavailable = (cause?: unknown) => {
  const failure = new InventorySourceImportUnavailableError({
    code: 'inventory_source_import_unavailable',
    reason: 'Inventory Source Import persistence is temporarily unavailable',
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const stableParts = (parts: readonly (number | string)[]) =>
  parts.map((part) => `${String(part).length}:${String(part)}`).join('|');

const refIdentity = (reference: {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}) => stableParts([reference.moduleId, reference.resourceId, reference.resourceType, reference.tenantId]);

const externalKeyIdentity = (externalKey: InventorySourceAssertionProposal['itemExternalKey']) =>
  stableParts([
    externalKey.customerConfigurationId,
    externalKey.externalScope,
    externalKey.externalValue,
    externalKey.identifierKind,
    externalKey.issuer.backendId,
    externalKey.issuer.backendKind,
    externalKey.namespace,
    externalKey.tenantId,
  ]);

const materialIdentity = (proposal: InventorySourceAssertionProposal) => {
  const material = canonicalInventorySourceAssertionMaterial(proposal);
  return stableParts([
    proposal.assertionId,
    material.businessObservedAt,
    ...material.coverage.flatMap((coverage) => [coverage.effectId, coverage.ownerEvidenceRef, coverage.relation]),
    material.customerConfigurationId,
    material.factMeaning,
    material.issuer.backendId,
    material.issuer.backendKind,
    externalKeyIdentity(material.itemExternalKey),
    externalKeyIdentity(material.locationExternalKey),
    material.orderingEvidence._tag,
    material.orderingEvidence.value,
    material.ownerEvidenceRef,
    refIdentity(material.positionRef),
    material.quantity.amount,
    refIdentity(material.quantity.unitRef),
    material.sourceReference,
  ]);
};

const stableConflictRef = (
  proposal: InventorySourceAssertionProposal,
  discriminator: 'ASSERTION_INTEGRITY' | 'CORRELATION_ITEM' | 'CORRELATION_LOCATION' | 'FACT_VALUE',
  evidenceIdentity: string,
): InventorySourceConflictRef => {
  const digest = createHash('sha256')
    .update(
      stableParts([
        'commerce.inventory.inventory-source-conflict',
        proposal.positionRef.tenantId,
        discriminator,
        evidenceIdentity,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(digest[16] ?? '0', 16) % 4] ?? '8';
  const resourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20)}`;
  // oxlint-disable-next-line effect-native/no-sync-schema-codec -- Hash formatting is deterministic internal construction and the branded ref cannot fail after the fixed UUID layout; expires: 2027-03-31.
  return Schema.decodeSync(InventorySourceConflictRefSchema)({
    moduleId: 'commerce.inventory',
    resourceId,
    resourceType: 'commerce.inventory.inventory-source-conflict',
    tenantId: proposal.positionRef.tenantId,
  });
};

const sameUnit = (
  left: InventorySourceAssertionProposal['quantity']['unitRef'],
  right: InventorySourceAssertionProposal['quantity']['unitRef'],
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const acceptedFor = (
  history: readonly InventorySourceImportLedgerEntry[],
  proposal: InventorySourceAssertionProposal,
) =>
  history.filter(
    (entry) => entry.outcome.status === 'ACCEPTED' && inventorySourceAssertionsShareStream(proposal, entry.proposal),
  );

const preflightCandidate = (
  history: readonly InventorySourceImportLedgerEntry[],
  proposal: InventorySourceAssertionProposal,
  selectedConfiguration: InventoryBackendConfiguration,
): typeof AssertionIntegrityConflictCandidateSchema.Type | typeof FactValueConflictCandidateSchema.Type | undefined => {
  const accepted = acceptedFor(history, proposal);
  const integrity = accepted.find(
    (entry) =>
      inventorySourceAssertionsClaimSameIdentityOrRevision(proposal, entry.proposal) &&
      !inventorySourceAssertionsHaveSameMaterialContent(proposal, entry.proposal),
  );
  if (integrity !== undefined) {
    return {
      _tag: 'ASSERTION_INTEGRITY',
      accepted: integrity.proposal,
      conflictRef: stableConflictRef(
        proposal,
        'ASSERTION_INTEGRITY',
        stableParts([materialIdentity(integrity.proposal), materialIdentity(proposal)].toSorted()),
      ),
      detectedAt: proposal.receivedAt,
      incoming: proposal,
      selectedConfiguration,
    };
  }
  const factValue = accepted.find(
    (entry) =>
      sameUnit(entry.proposal.quantity.unitRef, proposal.quantity.unitRef) &&
      entry.proposal.quantity.amount !== proposal.quantity.amount &&
      compareInventorySourceOrdering(entry.proposal.orderingEvidence, proposal.orderingEvidence) === 'INCOMPARABLE',
  );
  return factValue === undefined
    ? undefined
    : {
        _tag: 'FACT_VALUE',
        conflictRef: stableConflictRef(
          proposal,
          'FACT_VALUE',
          stableParts([materialIdentity(factValue.proposal), materialIdentity(proposal)].toSorted()),
        ),
        detectedAt: proposal.receivedAt,
        evidence: [factValue.proposal, proposal],
        selectedConfiguration,
      };
};

const correlationCandidate = (
  proposal: InventorySourceAssertionProposal,
  selectedConfiguration: InventoryBackendConfiguration,
  resolution: ExternalStockCorrelationResolution,
): typeof CorrelationConflictCandidateSchema.Type | undefined => {
  if (!Schema.is(AmbiguousExternalStockCorrelationSchema)(resolution)) {
    return undefined;
  }
  return {
    _tag: 'CORRELATION',
    ambiguousExternalKey: resolution.externalKey,
    candidateCorrelationRefs: resolution.candidateCorrelationRefs,
    conflictRef: stableConflictRef(
      proposal,
      resolution.externalKey.identifierKind === 'ITEM' ? 'CORRELATION_ITEM' : 'CORRELATION_LOCATION',
      stableParts([
        externalKeyIdentity(resolution.externalKey),
        ...resolution.candidateCorrelationRefs.map(refIdentity).toSorted(),
        materialIdentity(proposal),
      ]),
    ),
    detectedAt: proposal.receivedAt,
    proposal,
    selectedConfiguration,
  };
};

const withConflictRefs = (
  outcome: InventorySourceImportOutcome,
  conflictRefs: readonly InventorySourceConflictRef[],
): InventorySourceImportOutcome => ({
  assertionId: outcome.assertionId,
  conflictRefs,
  reason: 'INVENTORY_SOURCE_CONFLICT',
  reconciliationRequired: true,
  status: 'INDETERMINATE',
});

/**
 * Finalizes #834 classification before its single immutable ledger append. Registered conflicts
 * become actionable INDETERMINATE outcomes, and ledger replay returns those exact stable refs.
 */
/* oxlint-disable effect-native/no-dependency-parameters, effect-native/no-wide-factory-signature, unicorn/no-array-method-this-argument -- The finalizer runs within #834's transaction before its one ledger append; correlation scopes use explicit Effect concurrency so either all exact refs commit or the transaction rolls back; expires: 2027-03-31. */
export const makeInventorySourceConflictOutcomeFinalizer = (
  dependencies: InventorySourceConflictOutcomeFinalizerDependencies,
) =>
  Effect.fn('InventorySourceConflictOutcomeFinalizer.finalize')(function* finalize(
    input: InventorySourceConflictOutcomeFinalizerInput,
  ) {
    const { outcome, proposal } = input;
    if (
      outcome.status !== 'INDETERMINATE' &&
      !(outcome.status === 'REJECTED' && outcome.reason === 'CORRELATION_AMBIGUOUS')
    ) {
      return outcome;
    }
    const configuration = yield* dependencies.configurations
      .findCurrent(proposal.customerConfigurationId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(configuration)) {
      return outcome;
    }
    if (outcome.status === 'INDETERMINATE') {
      const candidate = preflightCandidate(input.acceptedHistory, proposal, configuration.value);
      if (candidate === undefined) {
        return outcome;
      }
      const registered = yield* dependencies.conflicts.register(candidate).pipe(
        Effect.asSome,
        Effect.catchTag('InventorySourceConflictRejected', (failure) =>
          failure.reason === 'POSITION_NOT_FOUND' ||
          failure.reason === 'POSITION_NOT_CURRENT' ||
          failure.reason === 'ASSERTION_AUTHORITY_MISMATCH'
            ? Effect.succeedNone
            : Effect.fail(unavailable(failure)),
        ),
        Effect.mapError(unavailable),
      );
      return Option.isSome(registered) ? withConflictRefs(outcome, [registered.value.conflict.conflictRef]) : outcome;
    }
    const resolutions = yield* Effect.forEach(
      (externalKey: InventorySourceAssertionProposal['itemExternalKey']) =>
        dependencies.correlations
          .resolve({ asOf: proposal.businessObservedAt, externalKey, selectedConfiguration: configuration.value })
          .pipe(Effect.mapError(unavailable)),
      { concurrency: 2 },
    )([proposal.itemExternalKey, proposal.locationExternalKey]);
    const candidates = resolutions
      .map((resolution) => correlationCandidate(proposal, configuration.value, resolution))
      .filter((candidate) => candidate !== undefined);
    if (candidates.length === 0) {
      return outcome;
    }
    const registrations = yield* Effect.forEach(
      (candidate: (typeof candidates)[number]) =>
        dependencies.conflicts.register(candidate).pipe(Effect.mapError(unavailable)),
      { concurrency: 1 },
    )(candidates);
    return withConflictRefs(
      outcome,
      registrations.map(({ conflict }) => conflict.conflictRef),
    );
  });
/* oxlint-enable effect-native/no-dependency-parameters, effect-native/no-wide-factory-signature, unicorn/no-array-method-this-argument */
