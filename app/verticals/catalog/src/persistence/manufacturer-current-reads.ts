import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, inArray, or } from 'drizzle-orm';
import { DateTime, Effect, Equal, Option, Schema } from 'effect';

import { ManufacturerSubjectSchema } from '../../shared/domain/manufacturer-relation.ts';
import type { ManufacturerSubject, ManufacturerTarget } from '../../shared/domain/manufacturer-relation.ts';
import { manufacturerRelationRevisions, manufacturerRelations, productVariants, products } from '../database/schema.ts';
import { ManufacturerPersistenceUnavailable } from './manufacturer-persistence.ts';
import type { ManufacturerTargetAbsent } from './manufacturer-target-absent.ts';
import type { ManufacturerTargetForbidden } from './manufacturer-target-forbidden.ts';
import type { ManufacturerTargetInvalid } from './manufacturer-target-invalid.ts';
import { manufacturerTargetResolver } from './manufacturer-target-resolver.ts';
import type { ResolvedManufacturerTarget } from './manufacturer-target-resolver.ts';
import type { ManufacturerTargetUnavailable } from './manufacturer-target-unavailable.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type RelationRow = typeof manufacturerRelations.$inferSelect;
type RevisionRow = typeof manufacturerRelationRevisions.$inferSelect;
type TargetResolver = typeof manufacturerTargetResolver;

interface ManufacturerCurrentClaim {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly effectiveFrom: string | undefined;
  readonly effectiveTo: string | undefined;
  readonly evidenceRefs: readonly string[];
  readonly owner: ResolvedManufacturerTarget;
  readonly reason: string;
  readonly recordedAt: Date;
  readonly relationId: string;
  readonly revision: number;
  /** The original Catalog assertion, even when an owner resolves an alias. */
  readonly subject: ManufacturerSubject;
  readonly target: ManufacturerTarget;
}

type ManufacturerCurrentResult =
  | { readonly kind: 'ABSENT' }
  | { readonly claim: ManufacturerCurrentClaim; readonly kind: 'CURRENT' };

export interface ManufacturerCurrentReads {
  readonly effective: (
    subject: ManufacturerSubject,
    at: string,
  ) => Effect.Effect<
    ManufacturerCurrentResult,
    | ManufacturerPersistenceUnavailable
    | ManufacturerTargetAbsent
    | ManufacturerTargetForbidden
    | ManufacturerTargetInvalid
    | ManufacturerTargetUnavailable
  >;
}

const unavailable = (cause?: unknown) => {
  const failure = new ManufacturerPersistenceUnavailable({
    code: 'manufacturer_persistence_unavailable',
    reason: 'Manufacturer Current relation is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const validDate = (value: Date | null) => value === null || !Number.isNaN(value.getTime());
const active = (row: RelationRow, at: Date) =>
  row.disposition === 'CONFIRMED' &&
  (row.effectiveFrom === null || row.effectiveFrom <= at) &&
  (row.effectiveTo === null || at < row.effectiveTo);

const targetOf = (row: RelationRow): ManufacturerTarget =>
  row.targetKind === 'PARTY'
    ? {
        kind: 'PARTY',
        partyRef: {
          moduleId: 'party.registry',
          resourceId: row.targetId,
          resourceType: 'party.registry.party',
          tenantId: row.tenantId,
        },
      }
    : {
        kind: 'LEGAL_ENTITY',
        legalEntityRef: {
          moduleId: 'core.identity',
          resourceId: row.targetId,
          resourceType: 'core.identity.legal-entity',
          tenantId: row.tenantId,
        },
      };

const matchingRevision = (head: RelationRow, row: RevisionRow) =>
  head.tenantId === row.tenantId &&
  head.relationId === row.relationId &&
  head.currentRevision === row.revision &&
  head.productId === row.productId &&
  head.variantId === row.variantId &&
  head.targetKind === row.targetKind &&
  head.targetId === row.targetId &&
  head.disposition === row.disposition &&
  head.effectiveFrom?.getTime() === row.effectiveFrom?.getTime() &&
  head.effectiveTo?.getTime() === row.effectiveTo?.getTime() &&
  head.reason === row.reason &&
  Equal.equals(head.evidenceRefs, row.evidenceRefs);

/** Uses only Catalog's tenant-scoped transaction and an injected authoritative owner resolver. */
export const manufacturerCurrentReadsForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Owner-read port is injected by the governed read service factory.
  configured?: { readonly targetResolver: TargetResolver },
): ManufacturerCurrentReads => {
  const { tenantId } = scope;
  const resolver = configured?.targetResolver ?? manufacturerTargetResolver;
  const effective: ManufacturerCurrentReads['effective'] = Effect.fn('ManufacturerCurrentReads.effective')(
    // oxlint-disable-next-line eslint/complexity -- One fail-closed read transaction validates subject, competing heads, revision evidence, and owner status together.
    function* effective(subject, at) {
      if (
        !Schema.is(ManufacturerSubjectSchema)(subject) ||
        subject.tenantId !== tenantId ||
        !Option.isSome(DateTime.make(at))
      ) {
        return yield* unavailable();
      }
      let productId = subject.resourceId;
      if (subject.resourceType === 'commerce.catalog.variant') {
        const [variant] = yield* transaction
          .select()
          .from(productVariants)
          .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, subject.resourceId)))
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        if (variant === undefined) {
          return { kind: 'ABSENT' };
        }
        ({ productId } = variant);
      }
      const [product] = yield* transaction
        .select()
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (product === undefined) {
        return { kind: 'ABSENT' };
      }
      const condition =
        subject.resourceType === 'commerce.catalog.product'
          ? eq(manufacturerRelations.productId, productId)
          : or(eq(manufacturerRelations.productId, productId), eq(manufacturerRelations.variantId, subject.resourceId));
      const heads = yield* transaction
        .select()
        .from(manufacturerRelations)
        .where(and(eq(manufacturerRelations.tenantId, tenantId), condition))
        .pipe(Effect.mapError(unavailable));
      const instant = DateTime.toDateUtc(DateTime.makeUnsafe(at));
      if (
        heads.some((row) => row.tenantId !== tenantId || !validDate(row.effectiveFrom) || !validDate(row.effectiveTo))
      ) {
        return yield* unavailable();
      }
      const current = heads.filter((row) => active(row, instant));
      if (current.length === 0) {
        return { kind: 'ABSENT' };
      }
      // A Product-wide and Variant assertion are not ordered overrides.
      if (current.length !== 1) {
        return yield* unavailable();
      }
      const [head] = current;
      if (head === undefined || head.currentRevision < 1 || !Number.isSafeInteger(head.currentRevision)) {
        return yield* unavailable();
      }
      const revisions = yield* transaction
        .select()
        .from(manufacturerRelationRevisions)
        .where(
          and(
            eq(manufacturerRelationRevisions.tenantId, tenantId),
            inArray(manufacturerRelationRevisions.relationId, [head.relationId]),
          ),
        )
        .pipe(Effect.mapError(unavailable));
      const ordered = revisions.toSorted((a, b) => a.revision - b.revision);
      const latest = ordered.at(-1);
      if (
        ordered.length !== head.currentRevision ||
        ordered.some((row, index) => row.revision !== index + 1 || row.tenantId !== tenantId) ||
        latest === undefined ||
        !matchingRevision(head, latest) ||
        !validDate(latest.recordedAt) ||
        latest.evidenceRefs.length === 0 ||
        (head.productId === null) === (head.variantId === null) ||
        !['PARTY', 'LEGAL_ENTITY'].includes(head.targetKind)
      ) {
        return yield* unavailable();
      }
      const target = targetOf(head);
      const owner = yield* resolver.resolve(target, { requestId: scope.correlationId, tenantId });
      return {
        claim: {
          actingPrincipalId: latest.actingPrincipalId,
          actionInvocationId: latest.actionInvocationId,
          effectiveFrom: latest.effectiveFrom?.toISOString(),
          effectiveTo: latest.effectiveTo?.toISOString(),
          evidenceRefs: latest.evidenceRefs,
          owner,
          reason: latest.reason,
          recordedAt: latest.recordedAt,
          relationId: head.relationId,
          revision: latest.revision,
          subject:
            head.productId === null
              ? {
                  moduleId: 'commerce.catalog',
                  resourceId: head.variantId ?? '',
                  resourceType: 'commerce.catalog.variant',
                  tenantId,
                }
              : {
                  moduleId: 'commerce.catalog',
                  resourceId: head.productId,
                  resourceType: 'commerce.catalog.product',
                  tenantId,
                },
          target,
        },
        kind: 'CURRENT',
      };
    },
  );
  return { effective };
};
