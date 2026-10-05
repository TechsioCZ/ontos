import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { and, eq } from 'drizzle-orm';
import {
  admissionSetEntries,
  admissionSets,
  closedBoundaries,
  closedBoundaryEndFacts,
  collectionRevisions,
} from '../database/schema.ts';
import type {
  CreateClosedAssortmentBoundaryPayload,
  EndClosedAssortmentBoundaryPayload,
  ReplaceClosedAssortmentBoundaryPayload,
} from '../../shared/actions/boundary-administration.ts';
import {
  boundaryAdmissionEvidence,
  boundaryMeaningFingerprint,
  collectionRevisionRef,
} from '../actions/boundary-administration-support.ts';
import type { BoundaryAdmissionEvidence } from '../actions/boundary-administration-support.ts';
import { AssortmentPolicyPersistenceUnavailable } from '../../shared/domain/policy-errors.ts';

type Failure = InstanceType<typeof AssortmentPolicyPersistenceUnavailable>;
type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Common = Readonly<{
  actionInvocationId: string;
  actorPrincipalId: string;
  legalEntityId: string;
  tenantId: string;
}>;
type Conflict = Readonly<{
  readonly conflict: 'IDEMPOTENCY_REUSED' | 'CONCURRENT_OVERLAP' | 'LIFECYCLE';
  readonly kind: 'conflict';
}>;
type NotFound = Readonly<{ readonly kind: 'not_found' }>;
type Stale = Readonly<{ readonly kind: 'stale_basis' }>;
export type BoundaryOutcome =
  | Readonly<{
      readonly admissionSet: PersistedAdmissionSetEvidence;
      readonly boundaryId: string;
      readonly created: boolean;
    }>
  | Conflict
  | NotFound
  | Stale;
export type EndBoundaryOutcome = Readonly<{ readonly ended: boolean }> | Conflict | NotFound | Stale;
export type ReplaceBoundaryOutcome =
  | Readonly<{ readonly createdBoundaryId: string; readonly replaced: boolean }>
  | Conflict
  | NotFound
  | Stale;
export interface BoundaryAdministrationService {
  readonly create: (input: CreateClosedAssortmentBoundaryPayload & Common) => Effect.Effect<BoundaryOutcome, Failure>;
  readonly end: (input: EndClosedAssortmentBoundaryPayload & Common) => Effect.Effect<EndBoundaryOutcome, Failure>;
  readonly replace: (
    input: ReplaceClosedAssortmentBoundaryPayload & Common,
  ) => Effect.Effect<ReplaceBoundaryOutcome, Failure>;
}
const unavailable = () =>
  new AssortmentPolicyPersistenceUnavailable({
    code: 'assortment_policy_persistence_unavailable',
    reason: 'Assortment boundary persistence is unavailable',
  });
const notFound = () => ({ kind: 'not_found' as const });
const lockClosedBoundaryScope = defineScopedRoutine({
  name: 'lock_closed_assortment_boundary_scope',
  ownerModuleKey: 'commerce.assortment',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ locked: Schema.Boolean }),
  routineKey: 'boundary.lock-scope',
  schema: 'assortment',
});
const db = <Value, FailureError>(effect: Effect.Effect<Value, FailureError>) =>
  effect.pipe(
    Effect.mapError((failure) => {
      void failure;
      return unavailable();
    }),
  );
const subjectKey = (input: CreateClosedAssortmentBoundaryPayload) =>
  input.subject.kind === 'COUNTERPARTY'
    ? { id: input.subject.counterpartyRef.resourceId, kind: input.subject.kind }
    : { id: input.subject.profileRef.resourceId, kind: input.subject.kind };
export const boundaryRef = (tenantId: string, resourceId: string) => ({
  moduleId: 'commerce.assortment' as const,
  resourceId,
  resourceType: 'commerce.assortment.closed-assortment-boundary' as const,
  tenantId,
});
type PersistedAdmissionSetEvidence = BoundaryAdmissionEvidence &
  Readonly<{
    readonly collectionRevisionRef: ReturnType<typeof collectionRevisionRef>;
  }>;

const persistedAdmissionSetEvidence = (
  tenantId: string,
  revision: Readonly<{
    readonly collectionKind: string;
    readonly collectionRevisionId: string;
    readonly completeness: string;
    readonly contentHash: string;
    readonly memberCount: number;
  }>,
  admissionSet: Readonly<{ readonly setKind: string }>,
): PersistedAdmissionSetEvidence | undefined => {
  if (
    revision.collectionKind !== 'CLOSED_BOUNDARY_ADMISSION_SET' ||
    revision.completeness !== 'COMPLETE' ||
    !/^[0-9a-f]{64}$/u.test(revision.contentHash) ||
    !Number.isInteger(revision.memberCount) ||
    revision.memberCount < 0 ||
    (admissionSet.setKind !== 'EMPTY' && admissionSet.setKind !== 'ENTRIES') ||
    (admissionSet.setKind === 'EMPTY' && revision.memberCount !== 0) ||
    (admissionSet.setKind === 'ENTRIES' && revision.memberCount === 0)
  ) {
    return undefined;
  }
  return {
    collectionRevisionRef: collectionRevisionRef(tenantId, revision.collectionRevisionId),
    contentHash: revision.contentHash,
    memberCount: revision.memberCount,
    setKind: admissionSet.setKind,
  };
};
const lock = (tx: ScopedTransaction, key: readonly [string, string, string, string]) =>
  db(tx.invoke(lockClosedBoundaryScope, key)).pipe(
    Effect.flatMap((rows) => (rows[0]?.locked === true ? Effect.succeed(true) : Effect.fail(unavailable()))),
  );
const entryTarget = (entry: CreateClosedAssortmentBoundaryPayload['admissionSet']['entries'][number]) => {
  if (entry.kind === 'ALL') {
    return { id: null, moduleId: null, type: null };
  }
  if (entry.kind === 'CATEGORY') {
    return {
      id: entry.categoryRef.resourceId,
      moduleId: entry.categoryRef.moduleId,
      type: entry.categoryRef.resourceType,
    };
  }
  if (entry.kind === 'PRODUCT') {
    return {
      id: entry.productRef.resourceId,
      moduleId: entry.productRef.moduleId,
      type: entry.productRef.resourceType,
    };
  }
  if (entry.kind === 'VARIANT') {
    return {
      id: entry.variantRef.resourceId,
      moduleId: entry.variantRef.moduleId,
      type: entry.variantRef.resourceType,
    };
  }
  const ref = entry.packageOptionRef;
  return { id: ref.resourceId, moduleId: ref.moduleId, type: ref.resourceType };
};
export const matchesBoundaryCreateReplay = (
  row: Readonly<{ actor: string; provenance: string; reason: string; semanticFingerprint: string }>,
  input: CreateClosedAssortmentBoundaryPayload & Common,
): boolean =>
  row.actor === input.actorPrincipalId &&
  row.provenance === input.provenanceRef &&
  row.reason === input.reason &&
  row.semanticFingerprint === boundaryMeaningFingerprint(input);
export const matchesBoundaryEndReplay = (
  row: Readonly<{
    actor: string;
    basisFingerprint: string;
    boundaryId: string;
    effectiveAt: Date;
    provenance: string;
    reason: string;
  }>,
  input: EndClosedAssortmentBoundaryPayload & Common,
): boolean =>
  row.actor === input.actorPrincipalId &&
  row.basisFingerprint === input.expectedBasisFingerprint &&
  row.boundaryId === input.boundaryRef.resourceId &&
  row.effectiveAt.getTime() === DateTime.toDateUtc(input.effectiveAt).getTime() &&
  row.provenance === input.provenanceRef &&
  row.reason === input.reason;
type ScopeRow = Readonly<{ marketResourceId: string | null; storefrontResourceId: string | null }>;
type BoundaryStateRow = ScopeRow & Readonly<{ boundaryId: string; effectiveFrom: Date; effectiveTo?: Date }>;
type BoundaryGroup = readonly [subjectKind: string, subjectId: string, purpose: string, channelId: string];
const narrower = (left: ScopeRow, right: ScopeRow): boolean => {
  const leftAdds =
    (left.marketResourceId !== null && right.marketResourceId === null) ||
    (left.storefrontResourceId !== null && right.storefrontResourceId === null);
  return (
    leftAdds &&
    (right.marketResourceId === null || right.marketResourceId === left.marketResourceId) &&
    (right.storefrontResourceId === null || right.storefrontResourceId === left.storefrontResourceId)
  );
};
const overlapConflict = (left: ScopeRow, right: ScopeRow): boolean =>
  !(
    (left.marketResourceId !== null &&
      right.marketResourceId !== null &&
      left.marketResourceId !== right.marketResourceId) ||
    (left.storefrontResourceId !== null &&
      right.storefrontResourceId !== null &&
      left.storefrontResourceId !== right.storefrontResourceId)
  ) &&
  ((left.marketResourceId === right.marketResourceId && left.storefrontResourceId === right.storefrontResourceId) ||
    (!narrower(left, right) && !narrower(right, left)));
export const boundaryScopeConflict = overlapConflict;
export const boundaryIntervalsOverlap = (existingEnd: number | undefined, proposedStart: number): boolean =>
  existingEnd === undefined || existingEnd > proposedStart;

const loadPersistedAdmissionSetEvidence = (
  tx: ScopedTransaction,
  tenantId: string,
  legalEntityId: string,
  boundaryId: string,
): Effect.Effect<PersistedAdmissionSetEvidence, Failure> =>
  Effect.all(
    [
      db(
        tx
          .select({
            collectionKind: collectionRevisions.collectionKind,
            collectionRevisionId: collectionRevisions.collectionRevisionId,
            completeness: collectionRevisions.completeness,
            contentHash: collectionRevisions.contentHash,
            memberCount: collectionRevisions.memberCount,
          })
          .from(collectionRevisions)
          .where(
            and(
              eq(collectionRevisions.tenantId, tenantId),
              eq(collectionRevisions.legalEntityId, legalEntityId),
              eq(collectionRevisions.aggregateId, boundaryId),
            ),
          )
          .limit(1),
      ),
      db(
        tx
          .select({ setKind: admissionSets.setKind })
          .from(admissionSets)
          .where(
            and(
              eq(admissionSets.tenantId, tenantId),
              eq(admissionSets.legalEntityId, legalEntityId),
              eq(admissionSets.closedBoundaryId, boundaryId),
            ),
          )
          .limit(1),
      ),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.flatMap(([revision, admissionSet]) => {
      const evidence =
        revision[0] === undefined || admissionSet[0] === undefined
          ? undefined
          : persistedAdmissionSetEvidence(tenantId, revision[0], admissionSet[0]);
      return evidence === undefined ? Effect.fail(unavailable()) : Effect.succeed(evidence);
    }),
  );

const resolveCreateReplay = Effect.fn('BoundaryAdministrationService.resolveCreateReplay')(
  function* resolveCreateReplayEffect(tx: ScopedTransaction, input: CreateClosedAssortmentBoundaryPayload & Common) {
    const replay = yield* db(
      tx
        .select({
          actor: closedBoundaries.actorPrincipalId,
          id: closedBoundaries.closedBoundaryId,
          provenance: closedBoundaries.provenanceRef,
          reason: closedBoundaries.reason,
          semanticFingerprint: closedBoundaries.semanticFingerprint,
        })
        .from(closedBoundaries)
        .where(
          and(
            eq(closedBoundaries.tenantId, input.tenantId),
            eq(closedBoundaries.legalEntityId, input.legalEntityId),
            eq(closedBoundaries.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
    const [row] = replay;
    if (row === undefined) {
      return Option.none<BoundaryOutcome>();
    }
    if (!matchesBoundaryCreateReplay(row, input)) {
      return Option.some<BoundaryOutcome>({ conflict: 'IDEMPOTENCY_REUSED' as const, kind: 'conflict' as const });
    }
    const admissionSet = yield* loadPersistedAdmissionSetEvidence(tx, input.tenantId, input.legalEntityId, row.id);
    return Option.some<BoundaryOutcome>({ admissionSet, boundaryId: row.id, created: false });
  },
);

const scopeMatchesCell = (scope: ScopeRow, cell: ScopeRow): boolean =>
  (scope.marketResourceId === null || scope.marketResourceId === cell.marketResourceId) &&
  (scope.storefrontResourceId === null || scope.storefrontResourceId === cell.storefrontResourceId);

/** Named equality cells plus null cover every optional context value, including absence. */
export const boundaryResultingStateConflict = (
  rows: readonly BoundaryStateRow[],
  affected: readonly ScopeRow[],
  effectiveAt: number,
): boolean => {
  const markets = new Set([null, ...rows.map((row) => row.marketResourceId)]);
  const storefronts = new Set([null, ...rows.map((row) => row.storefrontResourceId)]);
  const times = new Set([effectiveAt]);
  for (const row of rows) {
    if (row.effectiveFrom.getTime() >= effectiveAt) {
      times.add(row.effectiveFrom.getTime());
    }
    if (row.effectiveTo !== undefined && row.effectiveTo.getTime() >= effectiveAt) {
      times.add(row.effectiveTo.getTime());
    }
  }
  for (const at of times) {
    const active = rows.filter(
      (row) => row.effectiveFrom.getTime() <= at && (row.effectiveTo === undefined || at < row.effectiveTo.getTime()),
    );
    for (const marketResourceId of markets) {
      for (const storefrontResourceId of storefronts) {
        const cell = { marketResourceId, storefrontResourceId };
        if (!affected.some((scope) => scopeMatchesCell(scope, cell))) {
          continue;
        }
        const applicable = active.filter((row) => scopeMatchesCell(row, cell));
        const maximal = applicable.filter((row) => !applicable.some((other) => narrower(other, row)));
        if (maximal.length > 1) {
          return true;
        }
      }
    }
  }
  return false;
};

const groupForCreate = (input: CreateClosedAssortmentBoundaryPayload): BoundaryGroup => {
  const subject = subjectKey(input);
  return [subject.kind, subject.id, input.decisionPurpose, input.commercialScope.channelRef.resourceId];
};
const scopeForCreate = (input: CreateClosedAssortmentBoundaryPayload): ScopeRow => ({
  marketResourceId: input.commercialScope.commerceMarketRef?.resourceId ?? null,
  storefrontResourceId: input.commercialScope.storefrontRef?.resourceId ?? null,
});
const sameGroup = (left: BoundaryGroup, right: BoundaryGroup) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const compareGroups = (left: BoundaryGroup, right: BoundaryGroup): number => {
  for (const [index, value] of left.entries()) {
    const other = right[index];
    if (other !== undefined && value !== other) {
      return value < other ? -1 : 1;
    }
  }
  return 0;
};
const overlapOutcome = (): Conflict => ({ conflict: 'CONCURRENT_OVERLAP', kind: 'conflict' });

const loadBoundaryGroup = Effect.fn('BoundaryAdministrationService.loadBoundaryGroup')(
  function* loadBoundaryGroupEffect(tx: ScopedTransaction, input: Common, group: BoundaryGroup) {
    const [subjectKind, subjectId, purpose, channelId] = group;
    const [rows, ended] = yield* Effect.all(
      [
        db(
          tx
            .select({
              boundaryId: closedBoundaries.closedBoundaryId,
              effectiveFrom: closedBoundaries.effectiveFrom,
              marketResourceId: closedBoundaries.marketResourceId,
              storefrontResourceId: closedBoundaries.storefrontResourceId,
            })
            .from(closedBoundaries)
            .where(
              and(
                eq(closedBoundaries.tenantId, input.tenantId),
                eq(closedBoundaries.legalEntityId, input.legalEntityId),
                eq(closedBoundaries.subjectKind, subjectKind),
                eq(closedBoundaries.subjectResourceId, subjectId),
                eq(closedBoundaries.purpose, purpose),
                eq(closedBoundaries.channelResourceId, channelId),
              ),
            ),
        ),
        db(
          tx
            .select({
              boundaryId: closedBoundaryEndFacts.closedBoundaryId,
              effectiveAt: closedBoundaryEndFacts.effectiveAt,
            })
            .from(closedBoundaryEndFacts)
            .where(
              and(
                eq(closedBoundaryEndFacts.tenantId, input.tenantId),
                eq(closedBoundaryEndFacts.legalEntityId, input.legalEntityId),
              ),
            ),
        ),
      ],
      { concurrency: 2 },
    );
    const ends = new Map(ended.map((row) => [row.boundaryId, row.effectiveAt]));
    return rows.map((row): BoundaryStateRow => {
      const effectiveTo = ends.get(row.boundaryId);
      return effectiveTo === undefined ? row : { ...row, effectiveTo };
    });
  },
);

const loadBoundary = (tx: ScopedTransaction, input: Common, boundaryId: string) =>
  db(
    tx
      .select({
        boundaryId: closedBoundaries.closedBoundaryId,
        channel: closedBoundaries.channelResourceId,
        effectiveFrom: closedBoundaries.effectiveFrom,
        marketResourceId: closedBoundaries.marketResourceId,
        purpose: closedBoundaries.purpose,
        semanticFingerprint: closedBoundaries.semanticFingerprint,
        storefrontResourceId: closedBoundaries.storefrontResourceId,
        subjectKind: closedBoundaries.subjectKind,
        subjectResourceId: closedBoundaries.subjectResourceId,
      })
      .from(closedBoundaries)
      .where(
        and(
          eq(closedBoundaries.tenantId, input.tenantId),
          eq(closedBoundaries.legalEntityId, input.legalEntityId),
          eq(closedBoundaries.closedBoundaryId, boundaryId),
        ),
      )
      .limit(1),
  );
const groupForBoundary = (row: {
  channel: string;
  purpose: string;
  subjectKind: string;
  subjectResourceId: string;
}): BoundaryGroup => [row.subjectKind, row.subjectResourceId, row.purpose, row.channel];
const loadEndReplay = (tx: ScopedTransaction, input: Common) =>
  db(
    tx
      .select({
        actor: closedBoundaryEndFacts.actorPrincipalId,
        basisFingerprint: closedBoundaryEndFacts.basisFingerprint,
        boundaryId: closedBoundaryEndFacts.closedBoundaryId,
        effectiveAt: closedBoundaryEndFacts.effectiveAt,
        provenance: closedBoundaryEndFacts.provenanceRef,
        reason: closedBoundaryEndFacts.reason,
      })
      .from(closedBoundaryEndFacts)
      .where(
        and(
          eq(closedBoundaryEndFacts.tenantId, input.tenantId),
          eq(closedBoundaryEndFacts.legalEntityId, input.legalEntityId),
          eq(closedBoundaryEndFacts.idempotencyKey, input.actionInvocationId),
        ),
      )
      .limit(1),
  );
const persistBoundaryEnd = (tx: ScopedTransaction, input: EndClosedAssortmentBoundaryPayload & Common) =>
  db(
    tx
      .insert(closedBoundaryEndFacts)
      .values({
        actionInvocationId: input.actionInvocationId,
        actorPrincipalId: input.actorPrincipalId,
        basisFingerprint: input.expectedBasisFingerprint,
        closedBoundaryId: input.boundaryRef.resourceId,
        effectiveAt: DateTime.toDateUtc(input.effectiveAt),
        idempotencyKey: input.actionInvocationId,
        legalEntityId: input.legalEntityId,
        provenanceRef: input.provenanceRef,
        reason: input.reason,
        tenantId: input.tenantId,
      })
      .returning({ id: closedBoundaryEndFacts.closedBoundaryEndFactId }),
  ).pipe(
    Effect.flatMap((rows) => (rows[0] === undefined ? Effect.fail(unavailable()) : Effect.succeed({ ended: true }))),
  );

const persistCreatedBoundary = Effect.fn('BoundaryAdministrationService.persistCreatedBoundary')(
  function* persistCreatedBoundaryEffect(
    tx: ScopedTransaction,
    input: CreateClosedAssortmentBoundaryPayload & Common,
    evidence: BoundaryAdmissionEvidence,
  ) {
    const subject = subjectKey(input);
    const rows = yield* db(
      tx
        .insert(closedBoundaries)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          channelResourceId: input.commercialScope.channelRef.resourceId,
          effectiveFrom: DateTime.toDateUtc(input.effectiveFrom),
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          marketResourceId: input.commercialScope.commerceMarketRef?.resourceId ?? null,
          provenanceRef: input.provenanceRef,
          purpose: input.decisionPurpose,
          reason: input.reason,
          semanticFingerprint: boundaryMeaningFingerprint(input),
          storefrontResourceId: input.commercialScope.storefrontRef?.resourceId ?? null,
          subjectKind: subject.kind,
          subjectResourceId: subject.id,
          tenantId: input.tenantId,
        })
        .returning({ id: closedBoundaries.closedBoundaryId }),
    );
    const boundaryId = rows[0]?.id;
    if (boundaryId === undefined) {
      return yield* unavailable();
    }
    const revisionRows = yield* db(
      tx
        .insert(collectionRevisions)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          aggregateId: boundaryId,
          collectionKind: 'CLOSED_BOUNDARY_ADMISSION_SET',
          completeness: 'COMPLETE',
          contentHash: evidence.contentHash,
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          memberCount: evidence.memberCount,
          provenanceRef: input.provenanceRef,
          purpose: input.decisionPurpose,
          reason: input.reason,
          revision: 1,
          tenantId: input.tenantId,
        })
        .returning({ id: collectionRevisions.collectionRevisionId }),
    );
    const collectionRevisionId = revisionRows[0]?.id;
    if (collectionRevisionId === undefined) {
      return yield* unavailable();
    }
    const setRows = yield* db(
      tx
        .insert(admissionSets)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          closedBoundaryId: boundaryId,
          collectionRevisionId,
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          provenanceRef: input.provenanceRef,
          purpose: input.decisionPurpose,
          reason: input.reason,
          setKind: evidence.setKind,
          tenantId: input.tenantId,
        })
        .returning({ id: admissionSets.admissionSetId }),
    );
    const setId = setRows[0]?.id;
    if (setId === undefined) {
      return yield* unavailable();
    }
    if (input.admissionSet.entries.length > 0) {
      yield* db(
        tx.insert(admissionSetEntries).values(
          input.admissionSet.entries.map((entry, ordinal) => {
            const target = entryTarget(entry);
            return {
              actionInvocationId: input.actionInvocationId,
              actorPrincipalId: input.actorPrincipalId,
              admissionSetId: setId,
              coverageKind: entry.kind,
              idempotencyKey: input.actionInvocationId,
              legalEntityId: input.legalEntityId,
              ordinal,
              provenanceRef: input.provenanceRef,
              reason: input.reason,
              targetOwnerModuleId: target.moduleId,
              targetResourceId: target.id,
              targetResourceType: target.type,
              tenantId: input.tenantId,
            };
          }),
        ),
      );
    }
    return {
      admissionSet: { ...evidence, collectionRevisionRef: collectionRevisionRef(input.tenantId, collectionRevisionId) },
      boundaryId,
      created: true,
    };
  },
);

const resolveReplaceReplay = Effect.fn('BoundaryAdministrationService.resolveReplaceReplay')(
  function* resolveReplaceReplayEffect(
    tx: ScopedTransaction,
    input: ReplaceClosedAssortmentBoundaryPayload & Common,
    proposed: CreateClosedAssortmentBoundaryPayload & Common,
  ) {
    const replay = yield* db(
      tx
        .select({
          actor: closedBoundaries.actorPrincipalId,
          id: closedBoundaries.closedBoundaryId,
          provenance: closedBoundaries.provenanceRef,
          reason: closedBoundaries.reason,
          semanticFingerprint: closedBoundaries.semanticFingerprint,
        })
        .from(closedBoundaries)
        .where(
          and(
            eq(closedBoundaries.tenantId, input.tenantId),
            eq(closedBoundaries.legalEntityId, input.legalEntityId),
            eq(closedBoundaries.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
    const [created] = replay;
    if (created === undefined) {
      return Option.none<ReplaceBoundaryOutcome>();
    }
    const [ended] = yield* loadEndReplay(tx, input);
    const exact =
      ended !== undefined &&
      matchesBoundaryCreateReplay(created, proposed) &&
      matchesBoundaryEndReplay(ended, {
        ...input,
        boundaryRef: input.existingBoundaryRef,
        expectedBasisFingerprint: input.expectedExistingBasisFingerprint,
      });
    return Option.some<ReplaceBoundaryOutcome>(
      exact ? { createdBoundaryId: created.id, replaced: false } : { conflict: 'IDEMPOTENCY_REUSED', kind: 'conflict' },
    );
  },
);

const endProjection = (rows: readonly BoundaryStateRow[], boundaryId: string, effectiveTo: Date) =>
  rows.map((row) => (row.boundaryId === boundaryId ? { ...row, effectiveTo } : row));
const proposedRow = (input: CreateClosedAssortmentBoundaryPayload): BoundaryStateRow => ({
  ...scopeForCreate(input),
  boundaryId: 'proposed',
  effectiveFrom: DateTime.toDateUtc(input.effectiveFrom),
});
const stateIsVerifiable = (rows: readonly BoundaryStateRow[]): boolean =>
  rows.every(
    (row) =>
      Schema.is(Schema.Date)(row.effectiveFrom) &&
      Number.isFinite(row.effectiveFrom.getTime()) &&
      (row.effectiveTo === undefined ||
        (Schema.is(Schema.Date)(row.effectiveTo) && Number.isFinite(row.effectiveTo.getTime()))),
  );

export const boundaryAdministrationPersistenceForScope = (
  tx: ScopedTransaction,
  _scope: OperationalScope,
): BoundaryAdministrationService => {
  const create: BoundaryAdministrationService['create'] = Effect.fn('boundaryAdministration.create')(
    function* create(input) {
      const group = groupForCreate(input);
      yield* lock(tx, group);
      const replay = yield* resolveCreateReplay(tx, input);
      if (Option.isSome(replay)) {
        return replay.value;
      }
      const existing = yield* loadBoundaryGroup(tx, input, group);
      if (!stateIsVerifiable(existing)) {
        return yield* unavailable();
      }
      const proposed = proposedRow(input);
      if (boundaryResultingStateConflict([...existing, proposed], [proposed], proposed.effectiveFrom.getTime())) {
        return overlapOutcome();
      }
      return yield* persistCreatedBoundary(tx, input, boundaryAdmissionEvidence(input));
    },
  );
  const end: BoundaryAdministrationService['end'] = Effect.fn('boundaryAdministration.end')(function* end(input) {
    const [replay] = yield* loadEndReplay(tx, input);
    if (replay !== undefined) {
      return matchesBoundaryEndReplay(replay, input)
        ? { ended: false }
        : { conflict: 'IDEMPOTENCY_REUSED', kind: 'conflict' };
    }
    const [boundary] = yield* loadBoundary(tx, input, input.boundaryRef.resourceId);
    if (boundary === undefined) {
      return notFound();
    }
    if (boundary.semanticFingerprint !== input.expectedBasisFingerprint) {
      return { kind: 'stale_basis' };
    }
    const group = groupForBoundary(boundary);
    yield* lock(tx, group);
    const [completedReplay] = yield* loadEndReplay(tx, input);
    if (completedReplay !== undefined) {
      return matchesBoundaryEndReplay(completedReplay, input)
        ? { ended: false }
        : { conflict: 'IDEMPOTENCY_REUSED', kind: 'conflict' };
    }
    const existing = yield* loadBoundaryGroup(tx, input, group);
    if (!stateIsVerifiable(existing)) {
      return yield* unavailable();
    }
    const current = existing.find((row) => row.boundaryId === input.boundaryRef.resourceId);
    if (current === undefined) {
      return notFound();
    }
    if (current.effectiveTo !== undefined) {
      return { conflict: 'LIFECYCLE', kind: 'conflict' };
    }
    const at = DateTime.toDateUtc(input.effectiveAt);
    if (boundaryResultingStateConflict(endProjection(existing, current.boundaryId, at), [current], at.getTime())) {
      return overlapOutcome();
    }
    return yield* persistBoundaryEnd(tx, input);
  });
  const replace: BoundaryAdministrationService['replace'] = Effect.fn('boundaryAdministration.replace')(
    function* replace(input) {
      const proposed = {
        ...input,
        admissionSet: input.proposedAdmissionSet,
        commercialScope: input.proposedCommercialScope,
        decisionPurpose: input.proposedDecisionPurpose,
        effectiveFrom: input.proposedEffectiveFrom,
        subject: input.proposedSubject,
      };
      const replay = yield* resolveReplaceReplay(tx, input, proposed);
      if (Option.isSome(replay)) {
        return replay.value;
      }
      const [old] = yield* loadBoundary(tx, input, input.existingBoundaryRef.resourceId);
      if (old === undefined) {
        return notFound();
      }
      if (old.semanticFingerprint !== input.expectedExistingBasisFingerprint) {
        return { kind: 'stale_basis' };
      }
      const oldGroup = groupForBoundary(old);
      const newGroup = groupForCreate(proposed);
      const groups = sameGroup(oldGroup, newGroup) ? [oldGroup] : [oldGroup, newGroup].toSorted(compareGroups);
      yield* Effect.forEach(groups, (group) => lock(tx, group), { concurrency: 1, discard: true });
      const completedReplay = yield* resolveReplaceReplay(tx, input, proposed);
      if (Option.isSome(completedReplay)) {
        return completedReplay.value;
      }
      const at = DateTime.toDateUtc(input.effectiveAt);
      const candidate = proposedRow(proposed);
      const states = yield* Effect.forEach(
        groups,
        (group) => loadBoundaryGroup(tx, input, group).pipe(Effect.map((existing) => ({ existing, group }))),
        { concurrency: 1 },
      );
      if (states.some(({ existing }) => !stateIsVerifiable(existing))) {
        return yield* unavailable();
      }
      for (const { existing, group } of states) {
        const isOldGroup = sameGroup(group, oldGroup);
        const isNewGroup = sameGroup(group, newGroup);
        const current = isOldGroup ? existing.find((row) => row.boundaryId === old.boundaryId) : undefined;
        if (isOldGroup && current === undefined) {
          return notFound();
        }
        if (current?.effectiveTo !== undefined) {
          return { conflict: 'LIFECYCLE', kind: 'conflict' };
        }
        const projected = isOldGroup ? endProjection(existing, old.boundaryId, at) : existing;
        const resulting = isNewGroup ? [...projected, candidate] : projected;
        const affected = [...(current === undefined ? [] : [current]), ...(isNewGroup ? [candidate] : [])];
        if (boundaryResultingStateConflict(resulting, affected, at.getTime())) {
          return overlapOutcome();
        }
      }
      yield* persistBoundaryEnd(tx, {
        ...input,
        boundaryRef: input.existingBoundaryRef,
        expectedBasisFingerprint: input.expectedExistingBasisFingerprint,
      });
      const created = yield* persistCreatedBoundary(tx, proposed, boundaryAdmissionEvidence(proposed));
      return { createdBoundaryId: created.boundaryId, replaced: true };
    },
  );
  return { create, end, replace };
};
export const boundaryAdministrationService = (tx: ScopedTransaction, scope: OperationalScope) =>
  Effect.succeed(boundaryAdministrationPersistenceForScope(tx, scope));
