import { and, asc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { DateTime, Effect, Match, Schema } from 'effect';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import {
  AssortmentCatalogSelectorKindSchema,
  AssortmentCatalogSelectorSchema,
  AssortmentClosedBoundarySchema,
  AssortmentFactCurrentnessEvidenceSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentSetCompletenessEvidenceSchema,
  AssortmentTenantIdSchema,
  AssortmentTrustedCommerceContextSchema,
  AssortmentCandidateSchema,
  AssortmentCommercialScopeSchema,
} from '../../shared/domain/decision-contracts.ts';
import type {
  AssortmentCatalogSelectorKind,
  AssortmentTrustedCommerceContext,
} from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentCompleteDecisionSetV1Schema,
  AssortmentDecisionSetQueryV1Schema,
  AssortmentVerifyDecisionSetV1RequestSchema,
  AssortmentVerifyDecisionSetV1ResultSchema,
} from '../../shared/domain/decision-set-query.ts';
import type {
  AssortmentApplicableBoundaryQueryV1,
  AssortmentDecisionSetQueryV1,
  AssortmentOrdinaryCandidateQueryV1,
} from '../../shared/domain/decision-set-query.ts';
import { DecisionSetProofRefSchema } from '../../shared/resources/decision-set-proof.ts';
import { AssortmentPolicyPersistenceUnavailable } from '../../shared/domain/policy-errors.ts';
import {
  admissionSetEntries,
  admissionSets,
  applicabilityBindingEndFacts,
  applicabilityBindings,
  closedBoundaries,
  closedBoundaryEndFacts,
  collectionRevisions,
  ruleRetirementFacts,
  ruleRevisions,
  stableRules,
} from '../database/schema.ts';
import { assortmentMeaningFingerprint } from './policy-administration.service.ts';
import { decisionSetProofResourceId, readDecisionSetFenceToken } from './decision-set-proof.ts';

type Failure = InstanceType<typeof AssortmentPolicyPersistenceUnavailable>;
const assortmentOwnerModule = 'commerce.assortment' as const;
const instant = (value: Date) => DateTime.formatIso(DateTime.makeUnsafe(value));
const ownerRef = (moduleId: string, resourceId: string, resourceType: string, tenantId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
const resourceTypes = {
  binding: 'commerce.assortment.applicability-binding',
  boundary: 'commerce.assortment.closed-assortment-boundary',
  collectionRevision: 'commerce.assortment.collection-revision',
  ruleRevision: 'commerce.assortment.rule-revision',
  stableRule: 'commerce.assortment.stable-rule',
} as const;
const legalEntityOwner = { moduleId: 'party.registry', resourceType: 'party.registry.legal-entity' } as const;

const unavailable = (cause?: unknown): Failure => {
  const failure = new AssortmentPolicyPersistenceUnavailable({
    code: 'assortment_policy_persistence_unavailable',
    reason: 'Assortment decision-set proof is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const decode = <A, I, Input>(schema: Schema.Codec<A, I>, input: Input): Effect.Effect<A, Failure> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(unavailable));

const commercialScope = (context: AssortmentTrustedCommerceContext) => {
  const base = {
    channelRef: context.channelRef,
    sellingLegalEntityRef: context.sellingLegalEntityRef,
  };
  const withMarket =
    context.commerceMarketRef === undefined
      ? base
      : Object.assign(base, { commerceMarketRef: context.commerceMarketRef });
  return context.storefrontRef === undefined
    ? withMarket
    : Object.assign(withMarket, { storefrontRef: context.storefrontRef });
};

const commercialScopeForStored = Effect.fn('AssortmentDecisionSetReader.commercialScopeForStored')(
  function* commercialScopeForStored(
    context: AssortmentTrustedCommerceContext,
    marketResourceId: string | null,
    storefrontResourceId: string | null,
  ) {
    const scope = {
      channelRef: context.channelRef,
      sellingLegalEntityRef: context.sellingLegalEntityRef,
    };
    if (marketResourceId !== null) {
      if (context.commerceMarketRef === undefined || context.commerceMarketRef.resourceId !== marketResourceId) {
        return yield* unavailable();
      }
      Object.assign(scope, { commerceMarketRef: context.commerceMarketRef });
    }
    if (storefrontResourceId !== null) {
      if (context.storefrontRef === undefined || context.storefrontRef.resourceId !== storefrontResourceId) {
        return yield* unavailable();
      }
      Object.assign(scope, { storefrontRef: context.storefrontRef });
    }
    return yield* decode(AssortmentCommercialScopeSchema, scope);
  },
);

const audienceMatchesFor = (query: AssortmentOrdinaryCandidateQueryV1) => {
  const matchingSubject = query.subject.kind === 'IDENTIFIED' ? query.subject.subject : undefined;
  if (matchingSubject?.kind === 'RETAIL_CUSTOMER_PROFILE') {
    return or(
      eq(applicabilityBindings.bindingKind, 'SHARED'),
      and(
        eq(applicabilityBindings.bindingKind, 'SUBJECT'),
        eq(applicabilityBindings.subjectKind, 'RETAIL_CUSTOMER_PROFILE'),
        eq(applicabilityBindings.subjectResourceId, matchingSubject.profileRef.resourceId),
      ),
      eq(applicabilityBindings.bindingKind, 'COMMERCE_CUSTOMER_GROUP'),
    );
  }
  if (matchingSubject?.kind === 'COUNTERPARTY') {
    return or(
      eq(applicabilityBindings.bindingKind, 'SHARED'),
      and(
        eq(applicabilityBindings.bindingKind, 'SUBJECT'),
        eq(applicabilityBindings.subjectKind, 'COUNTERPARTY'),
        eq(applicabilityBindings.subjectResourceId, matchingSubject.counterpartyRef.resourceId),
      ),
    );
  }
  return eq(applicabilityBindings.bindingKind, 'SHARED');
};

const audienceFromBinding = (
  query: AssortmentOrdinaryCandidateQueryV1,
  bindingKind: string,
  customerGroupResourceId: string | null,
  subjectKind: string | null,
  subjectResourceId: string | null,
) => {
  if (bindingKind === 'SHARED') {
    return { kind: 'SHARED' as const };
  }
  if (bindingKind === 'COMMERCE_CUSTOMER_GROUP' && customerGroupResourceId !== null) {
    return {
      groupRef: ownerRef(
        'commerce.customer-context',
        customerGroupResourceId,
        'commerce.customer-context.customer-group',
        query.tenantId,
      ),
      kind: 'COMMERCE_CUSTOMER_GROUP' as const,
    };
  }
  if (
    bindingKind === 'SUBJECT' &&
    subjectKind !== null &&
    subjectResourceId !== null &&
    query.subject.kind === 'IDENTIFIED'
  ) {
    return { kind: 'SUBJECT' as const, subject: query.subject.subject };
  }
  return null;
};

const assertQueryScope = Effect.fn('AssortmentDecisionSetReader.assertQueryScope')(function* assertQueryScope(
  transaction: ScopedTransactionExecutor,
  query: AssortmentDecisionSetQueryV1,
) {
  const [context, tenant] = yield* Effect.all(
    [
      decode(Schema.toType(AssortmentTrustedCommerceContextSchema), query.trustedContext),
      decode(AssortmentTenantIdSchema, query.tenantId),
    ],
    { concurrency: 1 },
  );
  if (
    transaction.scope.tenantId !== tenant ||
    transaction.scope.legalEntityId !== query.legalEntityId ||
    context.tenantId !== tenant ||
    String(context.sellingLegalEntityRef.resourceId) !== String(query.legalEntityId) ||
    context.sellingLegalEntityRef.moduleId !== legalEntityOwner.moduleId ||
    context.sellingLegalEntityRef.resourceType !== legalEntityOwner.resourceType
  ) {
    return yield* unavailable();
  }
  const targetReferences: (typeof AssortmentOwnerResourceRefSchema.Type)[] = [];
  if (query.target.kind === 'PRODUCT') {
    targetReferences.push(query.target.productRef);
  } else {
    targetReferences.push(query.target.selection.productRef, query.target.selection.variantRef);
    if (query.kind === 'APPLICABLE_BOUNDARIES' && query.target.selection.packageOption !== undefined) {
      targetReferences.push(query.target.selection.packageOption.packageOptionRef);
    }
  }
  const subjectReferences: (typeof AssortmentOwnerResourceRefSchema.Type)[] = [];
  if (query.kind === 'APPLICABLE_BOUNDARIES') {
    subjectReferences.push(
      query.subject.kind === 'RETAIL_CUSTOMER_PROFILE' ? query.subject.profileRef : query.subject.counterpartyRef,
    );
  } else if (query.subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    subjectReferences.push(query.subject.guestEvidence.evidenceRef);
  } else {
    subjectReferences.push(
      query.subject.subject.kind === 'RETAIL_CUSTOMER_PROFILE'
        ? query.subject.subject.profileRef
        : query.subject.subject.counterpartyRef,
    );
  }
  if (
    ![...targetReferences, ...subjectReferences].every((reference) => reference.tenantId === tenant) ||
    DateTime.toEpochMillis(context.operationTime) !== DateTime.toEpochMillis(query.operationTime)
  ) {
    return yield* unavailable();
  }
  return true;
});

const proofRefFor = Effect.fn('AssortmentDecisionSetReader.proofRefFor')(function* proofRefFor(
  fenceToken: string,
  query: AssortmentDecisionSetQueryV1,
  materialRows: readonly Schema.Json[],
) {
  const encodedQuery = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(AssortmentDecisionSetQueryV1Schema))(
    query,
  ).pipe(Effect.mapError(unavailable));
  const resourceId = yield* decisionSetProofResourceId({
    fenceToken,
    query: encodedQuery,
    rows: materialRows,
  }).pipe(Effect.mapError(unavailable));
  return yield* decode(DecisionSetProofRefSchema, {
    moduleId: assortmentOwnerModule,
    resourceId,
    resourceType: 'commerce.assortment.decision-set-proof',
    tenantId: query.tenantId,
  });
});

const selectorForKind = (
  kind: AssortmentCatalogSelectorKind,
  ref: Readonly<{ moduleId: string; resourceId: string; resourceType: string; tenantId: string }> | null,
) =>
  Match.value(kind).pipe(
    Match.when('CATEGORY', () => (ref === null ? null : { categoryRef: ref, kind: 'CATEGORY' as const })),
    Match.when('PACKAGE_OPTION', () =>
      ref === null ? null : { kind: 'PACKAGE_OPTION' as const, packageOptionRef: ref },
    ),
    Match.when('PRODUCT', () => (ref === null ? null : { kind: 'PRODUCT' as const, productRef: ref })),
    Match.when('VARIANT', () => (ref === null ? null : { kind: 'VARIANT' as const, variantRef: ref })),
    Match.when('ALL', () => ({ kind: 'ALL' as const })),
    Match.exhaustive,
  );

const selectorFromStored = (
  kind: AssortmentCatalogSelectorKind,
  target: Readonly<{ moduleId: string; resourceId: string; resourceType: string; tenantId: string }> | null,
) => {
  if (kind === 'ALL') {
    return decode(AssortmentCatalogSelectorSchema, selectorForKind(kind, null));
  }
  if (target === null) {
    return Effect.fail(unavailable());
  }
  return decode(AssortmentCatalogSelectorSchema, selectorForKind(kind, target));
};

const queryBoundaryRows = (transaction: ScopedTransactionExecutor, query: AssortmentApplicableBoundaryQueryV1) => {
  const operationAt = DateTime.toDateUtc(query.operationTime);
  const context = query.trustedContext;
  const marketMatches =
    context.commerceMarketRef === undefined
      ? isNull(closedBoundaries.marketResourceId)
      : or(
          isNull(closedBoundaries.marketResourceId),
          eq(closedBoundaries.marketResourceId, context.commerceMarketRef.resourceId),
        );
  const storefrontMatches =
    context.storefrontRef === undefined
      ? isNull(closedBoundaries.storefrontResourceId)
      : or(
          isNull(closedBoundaries.storefrontResourceId),
          eq(closedBoundaries.storefrontResourceId, context.storefrontRef.resourceId),
        );
  return transaction
    .select({
      admissionSetId: admissionSets.admissionSetId,
      boundaryId: closedBoundaries.closedBoundaryId,
      channelResourceId: closedBoundaries.channelResourceId,
      collectionCompleteness: collectionRevisions.completeness,
      collectionContentHash: collectionRevisions.contentHash,
      collectionMemberCount: collectionRevisions.memberCount,
      collectionPurpose: collectionRevisions.purpose,
      collectionRevisionId: collectionRevisions.collectionRevisionId,
      effectiveFrom: closedBoundaries.effectiveFrom,
      effectiveTo: closedBoundaryEndFacts.effectiveAt,
      entryKind: admissionSetEntries.coverageKind,
      entryOwnerModuleId: admissionSetEntries.targetOwnerModuleId,
      entryResourceId: admissionSetEntries.targetResourceId,
      entryResourceType: admissionSetEntries.targetResourceType,
      legalEntityId: closedBoundaries.legalEntityId,
      marketResourceId: closedBoundaries.marketResourceId,
      ordinal: admissionSetEntries.ordinal,
      semanticFingerprint: closedBoundaries.semanticFingerprint,
      setKind: admissionSets.setKind,
      storefrontResourceId: closedBoundaries.storefrontResourceId,
      subjectKind: closedBoundaries.subjectKind,
      subjectResourceId: closedBoundaries.subjectResourceId,
    })
    .from(closedBoundaries)
    .leftJoin(
      admissionSets,
      and(
        eq(admissionSets.tenantId, closedBoundaries.tenantId),
        eq(admissionSets.legalEntityId, closedBoundaries.legalEntityId),
        eq(admissionSets.closedBoundaryId, closedBoundaries.closedBoundaryId),
        eq(admissionSets.purpose, closedBoundaries.purpose),
      ),
    )
    .leftJoin(
      collectionRevisions,
      and(
        eq(collectionRevisions.tenantId, admissionSets.tenantId),
        eq(collectionRevisions.legalEntityId, admissionSets.legalEntityId),
        eq(collectionRevisions.collectionRevisionId, admissionSets.collectionRevisionId),
        eq(collectionRevisions.aggregateId, admissionSets.closedBoundaryId),
      ),
    )
    .leftJoin(
      admissionSetEntries,
      and(
        eq(admissionSetEntries.tenantId, admissionSets.tenantId),
        eq(admissionSetEntries.legalEntityId, admissionSets.legalEntityId),
        eq(admissionSetEntries.admissionSetId, admissionSets.admissionSetId),
      ),
    )
    .leftJoin(
      closedBoundaryEndFacts,
      and(
        eq(closedBoundaryEndFacts.tenantId, closedBoundaries.tenantId),
        eq(closedBoundaryEndFacts.legalEntityId, closedBoundaries.legalEntityId),
        eq(closedBoundaryEndFacts.closedBoundaryId, closedBoundaries.closedBoundaryId),
      ),
    )
    .where(
      and(
        eq(closedBoundaries.tenantId, query.tenantId),
        eq(closedBoundaries.legalEntityId, query.legalEntityId),
        eq(closedBoundaries.subjectKind, query.subject.kind),
        eq(
          closedBoundaries.subjectResourceId,
          query.subject.kind === 'RETAIL_CUSTOMER_PROFILE'
            ? query.subject.profileRef.resourceId
            : query.subject.counterpartyRef.resourceId,
        ),
        eq(closedBoundaries.purpose, query.decisionPurpose),
        eq(closedBoundaries.channelResourceId, context.channelRef.resourceId),
        marketMatches,
        storefrontMatches,
        lte(closedBoundaries.effectiveFrom, operationAt),
        or(isNull(closedBoundaryEndFacts.effectiveAt), gt(closedBoundaryEndFacts.effectiveAt, operationAt)),
      ),
    )
    .orderBy(asc(closedBoundaries.closedBoundaryId), asc(admissionSetEntries.ordinal));
};

const readBoundaries = Effect.fn('AssortmentDecisionSetReader.readBoundaries')(function* readBoundaries(
  transaction: ScopedTransactionExecutor,
  query: AssortmentApplicableBoundaryQueryV1,
) {
  const { fenceToken, rows } = yield* readDecisionSetFenceToken(transaction).pipe(
    Effect.flatMap((lockedGeneration) =>
      queryBoundaryRows(transaction, query).pipe(
        Effect.map((selectedRows) => ({ fenceToken: lockedGeneration, rows: selectedRows })),
        Effect.mapError(unavailable),
      ),
    ),
    Effect.mapError(unavailable),
  );
  interface Accumulator {
    readonly admissionSetId: string;
    readonly boundaryId: string;
    readonly channelResourceId: string;
    readonly collectionCompleteness: string;
    readonly collectionContentHash: string;
    readonly collectionMemberCount: number;
    readonly collectionPurpose: string;
    readonly collectionRevisionId: string;
    readonly effectiveFrom: Date;
    readonly effectiveTo: Date | null;
    readonly entries: (typeof AssortmentCatalogSelectorSchema.Type)[];
    readonly legalEntityId: string;
    readonly marketResourceId: string | null;
    readonly semanticFingerprint: string;
    readonly setKind: string;
    readonly storefrontResourceId: string | null;
    readonly subjectKind: string;
    readonly subjectResourceId: string;
  }
  const accumulated = new Map<string, Accumulator>();
  const parseBoundaryRow = Effect.fn('AssortmentDecisionSetReader.parseBoundaryRow')(function* parseBoundaryRow(
    row: (typeof rows)[number],
  ) {
    if (
      row.admissionSetId === null ||
      row.collectionCompleteness === null ||
      row.collectionContentHash === null ||
      row.collectionMemberCount === null ||
      row.collectionPurpose === null ||
      row.collectionRevisionId === null ||
      row.setKind === null
    ) {
      return yield* unavailable();
    }
    let entry: typeof AssortmentCatalogSelectorSchema.Type | undefined;
    if (row.entryKind !== null) {
      const kind = yield* decode(AssortmentCatalogSelectorKindSchema, row.entryKind);
      const target =
        row.entryResourceId === null || row.entryResourceType === null || row.entryOwnerModuleId === null
          ? null
          : {
              moduleId: row.entryOwnerModuleId,
              resourceId: row.entryResourceId,
              resourceType: row.entryResourceType,
              tenantId: query.tenantId,
            };
      entry = yield* selectorFromStored(kind, target);
    }
    const completeRow = {
      ...row,
      admissionSetId: row.admissionSetId,
      collectionCompleteness: row.collectionCompleteness,
      collectionContentHash: row.collectionContentHash,
      collectionMemberCount: row.collectionMemberCount,
      collectionPurpose: row.collectionPurpose,
      collectionRevisionId: row.collectionRevisionId,
      setKind: row.setKind,
    };
    return { entry, row: completeRow };
  });
  const parsedRows = yield* Effect.forEach(rows, parseBoundaryRow, { concurrency: 1 });
  const groupBoundaryRow = Effect.fn('AssortmentDecisionSetReader.groupBoundaryRow')(function* groupBoundaryRow({
    entry,
    row,
  }: (typeof parsedRows)[number]) {
    const existing = accumulated.get(row.boundaryId);
    const value: Accumulator = existing ?? {
      admissionSetId: row.admissionSetId,
      boundaryId: row.boundaryId,
      channelResourceId: row.channelResourceId,
      collectionCompleteness: row.collectionCompleteness,
      collectionContentHash: row.collectionContentHash,
      collectionMemberCount: row.collectionMemberCount,
      collectionPurpose: row.collectionPurpose,
      collectionRevisionId: row.collectionRevisionId,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      entries: [],
      legalEntityId: row.legalEntityId,
      marketResourceId: row.marketResourceId,
      semanticFingerprint: row.semanticFingerprint,
      setKind: row.setKind,
      storefrontResourceId: row.storefrontResourceId,
      subjectKind: row.subjectKind,
      subjectResourceId: row.subjectResourceId,
    };
    if (
      value.admissionSetId !== row.admissionSetId ||
      value.collectionRevisionId !== row.collectionRevisionId ||
      value.setKind !== row.setKind
    ) {
      return yield* unavailable();
    }
    if (entry !== undefined) {
      value.entries.push(entry);
    }
    accumulated.set(row.boundaryId, value);
    return true;
  });
  yield* Effect.forEach(parsedRows, groupBoundaryRow, { concurrency: 1 });
  const buildBoundaryMaterial = Effect.fn('AssortmentDecisionSetReader.buildBoundaryMaterial')(
    function* buildBoundaryMaterial(value: Accumulator) {
      const contentHash = assortmentMeaningFingerprint({ entries: value.entries });
      const setKind = value.entries.length === 0 ? 'EMPTY' : 'ENTRIES';
      if (
        value.collectionCompleteness !== 'COMPLETE' ||
        value.collectionPurpose !== query.decisionPurpose ||
        value.collectionMemberCount !== value.entries.length ||
        value.collectionContentHash !== contentHash ||
        value.setKind !== setKind
      ) {
        return yield* unavailable();
      }
      const boundaryInput = {
        admissionSet: value.entries,
        boundaryRef: ownerRef(assortmentOwnerModule, value.boundaryId, resourceTypes.boundary, query.tenantId),
        commercialScope: yield* commercialScopeForStored(
          query.trustedContext,
          value.marketResourceId,
          value.storefrontResourceId,
        ),
        decisionPurpose: query.decisionPurpose,
        effectiveFrom: instant(value.effectiveFrom),
        subject:
          query.subject.kind === 'RETAIL_CUSTOMER_PROFILE'
            ? query.subject
            : { counterpartyRef: query.subject.counterpartyRef, kind: 'COUNTERPARTY' },
      };
      if (value.effectiveTo !== null) {
        Object.assign(boundaryInput, { effectiveTo: instant(value.effectiveTo) });
      }
      const boundary = yield* decode(AssortmentClosedBoundarySchema, boundaryInput);

      const boundaryJson = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(AssortmentClosedBoundarySchema))(
        boundary,
      ).pipe(Effect.mapError(unavailable));
      const encodedEntries = yield* Effect.forEach(
        value.entries,
        (entry) =>
          Schema.encodeUnknownEffect(Schema.toCodecJson(AssortmentCatalogSelectorSchema))(entry).pipe(
            Effect.mapError(unavailable),
          ),
        { concurrency: 1 },
      );
      const materialRow = {
        admissionSet: {
          admissionSetId: value.admissionSetId,
          collectionCompleteness: value.collectionCompleteness,
          collectionContentHash: value.collectionContentHash,
          collectionMemberCount: value.collectionMemberCount,
          collectionPurpose: value.collectionPurpose,
          collectionRevisionId: value.collectionRevisionId,
          entries: encodedEntries,
          setKind: value.setKind,
        },
        boundary: boundaryJson,
      } satisfies Schema.Json;
      return { boundary, materialRow };
    },
  );
  const boundaryMaterials = yield* Effect.forEach([...accumulated.values()], buildBoundaryMaterial, {
    concurrency: 1,
  });
  const boundaries = boundaryMaterials.map(({ boundary }) => boundary);
  const materialRows = boundaryMaterials.map(({ materialRow }) => materialRow);
  const evidence = yield* decode(AssortmentSetCompletenessEvidenceSchema, {
    predicate: 'all effective, applicable Assortment Closed Boundaries for this exact decision',
    proof: {
      evidenceRef: yield* proofRefFor(fenceToken, query, materialRows),
      ownerModuleId: assortmentOwnerModule,
    },
    scope: 'commerce.assortment.applicable-boundaries.v1',
    state: 'COMPLETE',
  });
  const result = yield* decode(Schema.toType(AssortmentCompleteDecisionSetV1Schema), {
    boundaries,
    completeness: {
      evidence,
      scope: {
        commercialScope: commercialScope(query.trustedContext),
        decisionPurpose: query.decisionPurpose,
        kind: 'APPLICABLE_CLOSED_BOUNDARIES',
        operationTime: query.operationTime,
        subject: query.subject,
        tenantId: query.tenantId,
      },
    },
    kind: 'COMPLETE_BOUNDARY_SET',
    query,
    version: 1,
  });
  return result;
});

const queryOrdinaryCandidateRows = (
  transaction: ScopedTransactionExecutor,
  query: AssortmentOrdinaryCandidateQueryV1,
) => {
  const operationAt = DateTime.toDateUtc(query.operationTime);
  const context = query.trustedContext;
  const marketMatches =
    context.commerceMarketRef === undefined
      ? isNull(applicabilityBindings.marketResourceId)
      : or(
          isNull(applicabilityBindings.marketResourceId),
          eq(applicabilityBindings.marketResourceId, context.commerceMarketRef.resourceId),
        );
  const storefrontMatches =
    context.storefrontRef === undefined
      ? isNull(applicabilityBindings.storefrontResourceId)
      : or(
          isNull(applicabilityBindings.storefrontResourceId),
          eq(applicabilityBindings.storefrontResourceId, context.storefrontRef.resourceId),
        );
  const audienceMatches = audienceMatchesFor(query);
  return transaction
    .select({
      bindingEnd: applicabilityBindingEndFacts.effectiveAt,
      bindingId: applicabilityBindings.applicabilityBindingId,
      bindingKind: applicabilityBindings.bindingKind,
      channelResourceId: applicabilityBindings.channelResourceId,
      customerGroupResourceId: applicabilityBindings.customerGroupResourceId,
      effectiveFrom: applicabilityBindings.effectiveFrom,
      legalEntityId: applicabilityBindings.legalEntityId,
      marketResourceId: applicabilityBindings.marketResourceId,
      revisionEffect: ruleRevisions.effect,
      revisionId: ruleRevisions.ruleRevisionId,
      revisionNumber: ruleRevisions.revisionNumber,
      revisionPurpose: ruleRevisions.purpose,
      selectorKind: ruleRevisions.selectorKind,
      selectorOwnerModuleId: ruleRevisions.selectorTargetOwnerModuleId,
      selectorResourceId: ruleRevisions.selectorTargetResourceId,
      selectorResourceType: ruleRevisions.selectorTargetResourceType,
      semanticFingerprint: ruleRevisions.semanticFingerprint,
      stableRuleId: stableRules.stableRuleId,
      stableRuleRetiredAt: ruleRetirementFacts.effectiveAt,
      storefrontResourceId: applicabilityBindings.storefrontResourceId,
      subjectKind: applicabilityBindings.subjectKind,
      subjectResourceId: applicabilityBindings.subjectResourceId,
      tenantId: applicabilityBindings.tenantId,
    })
    .from(applicabilityBindings)
    .innerJoin(
      ruleRevisions,
      and(
        eq(ruleRevisions.tenantId, applicabilityBindings.tenantId),
        eq(ruleRevisions.ruleRevisionId, applicabilityBindings.ruleRevisionId),
        eq(ruleRevisions.purpose, query.decisionPurpose),
      ),
    )
    .innerJoin(
      stableRules,
      and(eq(stableRules.tenantId, ruleRevisions.tenantId), eq(stableRules.stableRuleId, ruleRevisions.stableRuleId)),
    )
    .leftJoin(
      applicabilityBindingEndFacts,
      and(
        eq(applicabilityBindingEndFacts.tenantId, applicabilityBindings.tenantId),
        eq(applicabilityBindingEndFacts.legalEntityId, applicabilityBindings.legalEntityId),
        eq(applicabilityBindingEndFacts.applicabilityBindingId, applicabilityBindings.applicabilityBindingId),
      ),
    )
    .leftJoin(
      ruleRetirementFacts,
      and(
        eq(ruleRetirementFacts.tenantId, stableRules.tenantId),
        eq(ruleRetirementFacts.stableRuleId, stableRules.stableRuleId),
      ),
    )
    .where(
      and(
        eq(applicabilityBindings.tenantId, query.tenantId),
        eq(applicabilityBindings.legalEntityId, query.legalEntityId),
        eq(applicabilityBindings.channelResourceId, context.channelRef.resourceId),
        marketMatches,
        storefrontMatches,
        audienceMatches,
        lte(applicabilityBindings.effectiveFrom, operationAt),
        or(isNull(applicabilityBindingEndFacts.effectiveAt), gt(applicabilityBindingEndFacts.effectiveAt, operationAt)),
      ),
    )
    .orderBy(
      asc(stableRules.stableRuleId),
      asc(ruleRevisions.revisionNumber),
      asc(applicabilityBindings.applicabilityBindingId),
    );
};

type OrdinaryCandidateRow = Effect.Success<ReturnType<typeof queryOrdinaryCandidateRows>>[number];

const materializeOrdinaryCandidate = Effect.fn('AssortmentDecisionSetReader.materializeOrdinaryCandidate')(
  function* materializeOrdinaryCandidate(query: AssortmentOrdinaryCandidateQueryV1, row: OrdinaryCandidateRow) {
    const selectorKind = yield* decode(AssortmentCatalogSelectorKindSchema, row.selectorKind);
    const selectorTarget =
      row.selectorOwnerModuleId === null || row.selectorResourceId === null || row.selectorResourceType === null
        ? null
        : {
            moduleId: row.selectorOwnerModuleId,
            resourceId: row.selectorResourceId,
            resourceType: row.selectorResourceType,
            tenantId: query.tenantId,
          };
    const selector = yield* selectorFromStored(selectorKind, selectorTarget);
    const audience = audienceFromBinding(
      query,
      row.bindingKind,
      row.customerGroupResourceId,
      row.subjectKind,
      row.subjectResourceId,
    );
    if (audience === null) {
      return yield* unavailable();
    }
    const context = query.trustedContext;
    if (
      (row.marketResourceId !== null && context.commerceMarketRef?.resourceId !== row.marketResourceId) ||
      (row.storefrontResourceId !== null && context.storefrontRef?.resourceId !== row.storefrontResourceId)
    ) {
      return yield* unavailable();
    }
    const bindingRef = ownerRef(assortmentOwnerModule, row.bindingId, resourceTypes.binding, query.tenantId);
    const revisionRef = ownerRef(assortmentOwnerModule, row.revisionId, resourceTypes.ruleRevision, query.tenantId);
    const stableRuleRef = ownerRef(assortmentOwnerModule, row.stableRuleId, resourceTypes.stableRule, query.tenantId);
    const candidate = yield* decode(AssortmentCandidateSchema, {
      audience,
      bindingRef,
      commercialScope: yield* commercialScopeForStored(context, row.marketResourceId, row.storefrontResourceId),
      decisionPurpose: row.revisionPurpose,
      effect: row.revisionEffect,
      ruleRevision: {
        ownerModuleId: assortmentOwnerModule,
        revision: String(row.revisionNumber),
        sourceRef: revisionRef,
      },
      selector,
      stableRuleRef,
    });
    const [bindingFactRef, revisionFactRef, stableRuleFactRef] = yield* Effect.forEach(
      [bindingRef, revisionRef, stableRuleRef],
      (reference) => decode(AssortmentOwnerResourceRefSchema, reference),
      { concurrency: 1 },
    );
    const candidateJson = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(AssortmentCandidateSchema))(
      candidate,
    ).pipe(Effect.mapError(unavailable));
    const materialRow = {
      bindingEnd: row.bindingEnd === null ? null : instant(row.bindingEnd),
      candidate: candidateJson,
      effectiveFrom: instant(row.effectiveFrom),
      revisionFingerprint: row.semanticFingerprint,
      stableRuleRetiredAt: row.stableRuleRetiredAt === null ? null : instant(row.stableRuleRetiredAt),
    } satisfies Schema.Json;
    return { candidate, factRefs: [bindingFactRef, revisionFactRef, stableRuleFactRef], materialRow };
  },
);

const readOrdinaryCandidates = Effect.fn('AssortmentDecisionSetReader.readOrdinaryCandidates')(
  function* readOrdinaryCandidates(transaction: ScopedTransactionExecutor, query: AssortmentOrdinaryCandidateQueryV1) {
    const { fenceToken, rows } = yield* readDecisionSetFenceToken(transaction).pipe(
      Effect.flatMap((lockedGeneration) =>
        queryOrdinaryCandidateRows(transaction, query).pipe(
          Effect.map((selectedRows) => ({ fenceToken: lockedGeneration, rows: selectedRows })),
          Effect.mapError(unavailable),
        ),
      ),
      Effect.mapError(unavailable),
    );
    const materialized = yield* Effect.forEach(rows, (row) => materializeOrdinaryCandidate(query, row), {
      concurrency: 1,
    });
    const candidates = materialized.map(({ candidate }) => candidate);
    const factCurrentnessRefs = materialized.flatMap(({ factRefs: candidateFactRefs }) => candidateFactRefs);
    const materialRows = materialized.map(({ materialRow }) => materialRow);
    const proofRef = yield* proofRefFor(fenceToken, query, materialRows);
    const completeness = yield* decode(AssortmentSetCompletenessEvidenceSchema, {
      predicate: 'all effective Candidate-producing Assortment Bindings and Rule Revisions for this exact decision',
      proof: { evidenceRef: proofRef, ownerModuleId: assortmentOwnerModule },
      scope: 'commerce.assortment.ordinary-candidates.v1',
      state: 'COMPLETE',
    });
    const factCurrentness = yield* Effect.forEach(
      factCurrentnessRefs,
      (factRef) =>
        decode(AssortmentFactCurrentnessEvidenceSchema, {
          factRef,
          proof: { evidenceRef: proofRef, ownerModuleId: assortmentOwnerModule },
          state: 'CURRENT',
        }),
      { concurrency: 1 },
    );
    return yield* decode(Schema.toType(AssortmentCompleteDecisionSetV1Schema), {
      candidates,
      completeness: {
        evidence: completeness,
        scope: {
          commercialScope: commercialScope(query.trustedContext),
          decisionPurpose: query.decisionPurpose,
          kind: 'ORDINARY_CANDIDATES',
          operationTime: query.operationTime,
          subject: query.subject,
          target: query.target,
          tenantId: query.tenantId,
        },
      },
      factCurrentness,
      kind: 'COMPLETE_ORDINARY_CANDIDATE_SET',
      query,
      version: 1,
    });
  },
);

export const readAssortmentDecisionSetV1 = Effect.fn('AssortmentDecisionSetReader.readV1')(function* readV1(
  transaction: ScopedTransactionExecutor,
  input: AssortmentDecisionSetQueryV1,
) {
  const query = yield* decode(Schema.toType(AssortmentDecisionSetQueryV1Schema), input);
  yield* assertQueryScope(transaction, query);
  return yield* query.kind === 'APPLICABLE_BOUNDARIES'
    ? readBoundaries(transaction, query)
    : readOrdinaryCandidates(transaction, query);
});

export const verifyAssortmentDecisionSetV1 = Effect.fn('AssortmentDecisionSetReader.verifyV1')(function* verifyV1(
  transaction: ScopedTransactionExecutor,
  input: typeof AssortmentVerifyDecisionSetV1RequestSchema.Type,
) {
  const request = yield* decode(Schema.toType(AssortmentVerifyDecisionSetV1RequestSchema), input);
  const [expectedProof, current] = yield* Effect.all(
    [
      decode(DecisionSetProofRefSchema, request.expectedProofRef),
      readAssortmentDecisionSetV1(transaction, request.query),
    ],
    { concurrency: 1 },
  );
  const currentProof = current.completeness.evidence.proof.evidenceRef;
  const state =
    expectedProof.moduleId === currentProof.moduleId &&
    expectedProof.resourceId === currentProof.resourceId &&
    expectedProof.resourceType === currentProof.resourceType &&
    expectedProof.tenantId === currentProof.tenantId
      ? 'CURRENT'
      : 'STALE';
  return yield* decode(AssortmentVerifyDecisionSetV1ResultSchema, { state, version: 1 });
});
