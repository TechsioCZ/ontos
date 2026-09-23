import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, inArray, or } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type {
  ChangeProductManufacturerPayload,
  RemoveProductManufacturerPayload,
  SetProductManufacturerPayload,
} from '../../shared/actions/manufacturer-mutations.ts';
import { ManufacturerRelationHistorySchema } from '../../shared/domain/manufacturer-relation.ts';
import type {
  ManufacturerRelationHistory,
  ManufacturerSubject,
  ManufacturerTarget,
} from '../../shared/domain/manufacturer-relation.ts';
import { manufacturerRelationRevisions, manufacturerRelations, productVariants, products } from '../database/schema.ts';
import { manufacturerTargetResolver } from './manufacturer-target-resolver.ts';
import type { ResolvedManufacturerTarget } from './manufacturer-target-resolver.ts';
import type { ManufacturerTargetForbidden } from './manufacturer-target-forbidden.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type RelationRow = typeof manufacturerRelations.$inferSelect;
type RevisionRow = typeof manufacturerRelationRevisions.$inferSelect;
interface MutationEvidence {
  readonly actionInvocationId: string;
  readonly principalId: string;
}
interface EffectivePeriodSnapshot {
  effectiveFrom?: string;
  effectiveTo?: string;
}
type MutationInput<Payload> = MutationEvidence & { readonly payload: Payload };
type TargetResolver = typeof manufacturerTargetResolver;

const ManufacturerMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('applied', {
    relationId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CatalogManufacturerRelationId')),
    revision: Schema.Int,
  }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Int }),
  Schema.TaggedStruct('identity_conflict', {}),
  Schema.TaggedStruct('invalid_change', {}),
]);
type ManufacturerMutationOutcome = typeof ManufacturerMutationOutcomeSchema.Type;

export class ManufacturerPersistenceUnavailable extends Schema.TaggedError<ManufacturerPersistenceUnavailable>()(
  'ManufacturerPersistenceUnavailable',
  { code: Schema.Literal('manufacturer_persistence_unavailable'), reason: Schema.String },
) {}

export interface ManufacturerPersistence {
  readonly change: (
    input: MutationInput<ChangeProductManufacturerPayload>,
  ) => Effect.Effect<ManufacturerMutationOutcome, ManufacturerPersistenceUnavailable | ManufacturerTargetForbidden>;
  readonly history: (
    relationId: string,
    subject: ManufacturerSubject,
  ) => Effect.Effect<Option.Option<ManufacturerRelationHistory>, ManufacturerPersistenceUnavailable>;
  readonly remove: (
    input: MutationInput<RemoveProductManufacturerPayload>,
  ) => Effect.Effect<ManufacturerMutationOutcome, ManufacturerPersistenceUnavailable>;
  readonly set: (
    input: MutationInput<SetProductManufacturerPayload>,
  ) => Effect.Effect<ManufacturerMutationOutcome, ManufacturerPersistenceUnavailable | ManufacturerTargetForbidden>;
}

const unavailable = (cause?: unknown) => {
  const failure = new ManufacturerPersistenceUnavailable({
    code: 'manufacturer_persistence_unavailable',
    reason: 'Manufacturer relation or authoritative owner read is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
const PRODUCT_TYPE = 'commerce.catalog.product';
const columns = (subject: ManufacturerSubject) => ({
  productId: subject.resourceType === PRODUCT_TYPE ? subject.resourceId : null,
  variantId: subject.resourceType === 'commerce.catalog.variant' ? subject.resourceId : null,
});
const validSubject = (subject: ManufacturerSubject, tenantId: string) =>
  subject.tenantId === tenantId && subject.moduleId === 'commerce.catalog';
const sameSubject = (row: RelationRow, subject: ManufacturerSubject) =>
  row.productId === columns(subject).productId && row.variantId === columns(subject).variantId;
const asDate = (value: string | undefined) =>
  value === undefined ? null : DateTime.toDateUtc(DateTime.makeUnsafe(value));
const active = (row: RelationRow, now: Date) =>
  row.disposition === 'CONFIRMED' && (row.effectiveTo === null || row.effectiveTo > now);
const hasConflict = (rows: readonly RelationRow[], except: string | undefined, now: Date) =>
  rows.some((row) => row.relationId !== except && active(row, now));
const applied = (
  row: RelationRow,
  relationId: SetProductManufacturerPayload['relationId'],
): ManufacturerMutationOutcome => ({ _tag: 'applied', relationId, revision: row.currentRevision });
const targetOf = (row: RevisionRow): ManufacturerTarget =>
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
const canonicalAssignment = (owner: ResolvedManufacturerTarget, tenantId: string) => {
  if (owner.kind === 'PARTY') {
    return owner.state === 'ARCHIVED' || owner.canonicalTarget.partyRef.tenantId !== tenantId
      ? Option.none<{ targetId: string; targetKind: 'PARTY' | 'LEGAL_ENTITY' }>()
      : Option.some({ targetId: owner.canonicalTarget.partyRef.resourceId, targetKind: 'PARTY' as const });
  }
  return owner.state !== 'CURRENT' ||
    owner.lifecycleStatus !== 'active' ||
    owner.canonicalTarget.legalEntityRef.tenantId !== tenantId ||
    owner.canonicalTarget.legalEntityRef.resourceId !== owner.requestedTarget.legalEntityRef.resourceId
    ? Option.none<{ targetId: string; targetKind: 'PARTY' | 'LEGAL_ENTITY' }>()
    : Option.some({ targetId: owner.canonicalTarget.legalEntityRef.resourceId, targetKind: 'LEGAL_ENTITY' as const });
};

/** All queries use Core's already tenant-scoped transaction; target existence comes only from its owner. */
export const manufacturerPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Owner-read test seam, pending #445 governed Core target read. expires: 2027-03-31.
  configured?: { readonly targetResolver: TargetResolver },
): ManufacturerPersistence => {
  const { tenantId } = scope;
  const resolver = configured?.targetResolver ?? manufacturerTargetResolver;
  const get = (id: string) =>
    transaction
      .select()
      .from(manufacturerRelations)
      .where(and(eq(manufacturerRelations.tenantId, tenantId), eq(manufacturerRelations.relationId, id)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const read = (id: string) =>
    transaction
      .select()
      .from(manufacturerRelations)
      .where(and(eq(manufacturerRelations.tenantId, tenantId), eq(manufacturerRelations.relationId, id)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  // Product lock serializes both Product-wide and Variant-level assertions for its exact form family.
  const lock = Effect.fn('ManufacturerPersistence.lock')(function* lock(subject: ManufacturerSubject) {
    let productId = subject.resourceId;
    if (subject.resourceType !== PRODUCT_TYPE) {
      const [variant] = yield* transaction
        .select()
        .from(productVariants)
        .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, subject.resourceId)))
        .limit(1);
      if (variant === undefined) {
        return Option.none<string>();
      }
      const { productId: variantProductId } = variant;
      productId = variantProductId;
    }
    const [product] = yield* transaction
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
      .for('update')
      .limit(1);
    return product === undefined ? Option.none<string>() : Option.some(productId);
  }, Effect.mapError(unavailable));
  const conflicts = Effect.fn('ManufacturerPersistence.conflicts')(function* conflicts(
    subject: ManufacturerSubject,
    productId: string,
    except?: string,
  ) {
    const variantIds =
      subject.resourceType === PRODUCT_TYPE
        ? (yield* transaction
            .select({ variantId: productVariants.variantId })
            .from(productVariants)
            .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, productId)))
            .pipe(Effect.mapError(unavailable))).map((row) => row.variantId)
        : [subject.resourceId];
    const rows = yield* transaction
      .select()
      .from(manufacturerRelations)
      .where(
        and(
          eq(manufacturerRelations.tenantId, tenantId),
          variantIds.length === 0
            ? eq(manufacturerRelations.productId, productId)
            : or(eq(manufacturerRelations.productId, productId), inArray(manufacturerRelations.variantId, variantIds)),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(unavailable));
    return hasConflict(rows, except, DateTime.toDateUtc(yield* DateTime.now));
  });
  const resolve = (target: ManufacturerTarget) =>
    resolver.resolve(target, { requestId: scope.correlationId, tenantId }).pipe(
      Effect.catchTags({
        // oxlint-disable sonarjs/function-name -- Effect catchTags keys are schema-owned error tags; #445 target read integration. expires: 2027-03-31.
        ManufacturerTargetAbsent: () => Effect.succeed({ _tag: 'not_found' as const }),
        ManufacturerTargetInvalid: () => Effect.succeed({ _tag: 'invalid_change' as const }),
        ManufacturerTargetUnavailable: (failure) => Effect.fail(unavailable(failure)),
        // oxlint-enable sonarjs/function-name
      }),
    );
  const append = (row: RelationRow, evidence: MutationEvidence) =>
    transaction
      .insert(manufacturerRelationRevisions)
      .values({
        actingPrincipalId: evidence.principalId,
        actionInvocationId: evidence.actionInvocationId,
        disposition: row.disposition,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        evidenceRefs: row.evidenceRefs,
        productId: row.productId,
        reason: row.reason,
        relationId: row.relationId,
        revision: row.currentRevision,
        targetId: row.targetId,
        targetKind: row.targetKind,
        tenantId,
        variantId: row.variantId,
      })
      .pipe(Effect.mapError(unavailable));

  const set: ManufacturerPersistence['set'] = Effect.fn('ManufacturerPersistence.set')(function* set(input) {
    const { payload } = input;
    if (!validSubject(payload.subject, tenantId)) {
      return { _tag: 'invalid_change' };
    }
    const resolution = yield* resolve(payload.target);
    if (Schema.is(ManufacturerMutationOutcomeSchema)(resolution)) {
      return resolution;
    }
    const canonical = canonicalAssignment(resolution, tenantId);
    if (Option.isNone(canonical)) {
      return { _tag: 'invalid_change' };
    }
    const lockedProductId = yield* lock(payload.subject);
    if (Option.isNone(lockedProductId)) {
      return { _tag: 'not_found' };
    }
    if (yield* conflicts(payload.subject, lockedProductId.value)) {
      return { _tag: 'identity_conflict' };
    }
    const [row] = yield* transaction
      .insert(manufacturerRelations)
      .values({
        ...columns(payload.subject),
        currentRevision: 1,
        disposition: 'CONFIRMED',
        effectiveFrom: asDate(payload.effectivePeriod.effectiveFrom),
        effectiveTo: asDate(payload.effectivePeriod.effectiveTo),
        evidenceRefs: [...payload.evidenceRefs],
        reason: payload.reason,
        relationId: payload.relationId,
        targetId: canonical.value.targetId,
        targetKind: canonical.value.targetKind,
        tenantId,
      })
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* unavailable();
    }
    yield* append(row, input);
    return applied(row, payload.relationId);
  });
  const change: ManufacturerPersistence['change'] = Effect.fn('ManufacturerPersistence.change')(
    function* change(input) {
      const { payload } = input;
      if (!validSubject(payload.subject, tenantId)) {
        return { _tag: 'invalid_change' };
      }
      const resolution = yield* resolve(payload.target);
      if (Schema.is(ManufacturerMutationOutcomeSchema)(resolution)) {
        return resolution;
      }
      const canonical = canonicalAssignment(resolution, tenantId);
      if (Option.isNone(canonical)) {
        return { _tag: 'invalid_change' };
      }
      const lockedProductId = yield* lock(payload.subject);
      if (Option.isNone(lockedProductId)) {
        return { _tag: 'not_found' };
      }
      const [current] = yield* get(payload.relationId);
      if (current === undefined || !sameSubject(current, payload.subject)) {
        return { _tag: 'not_found' };
      }
      if (current.currentRevision !== payload.expectedRevision) {
        return { _tag: 'revision_conflict', actualRevision: current.currentRevision };
      }
      if (
        current.disposition !== 'CONFIRMED' ||
        (yield* conflicts(payload.subject, lockedProductId.value, current.relationId))
      ) {
        return { _tag: 'identity_conflict' };
      }
      const [row] = yield* transaction
        .update(manufacturerRelations)
        .set({
          currentRevision: current.currentRevision + 1,
          effectiveFrom: asDate(payload.effectivePeriod.effectiveFrom),
          effectiveTo: asDate(payload.effectivePeriod.effectiveTo),
          evidenceRefs: [...payload.evidenceRefs],
          reason: payload.reason,
          targetId: canonical.value.targetId,
          targetKind: canonical.value.targetKind,
          updatedAt: DateTime.toDateUtc(yield* DateTime.now),
        })
        .where(
          and(
            eq(manufacturerRelations.tenantId, tenantId),
            eq(manufacturerRelations.relationId, current.relationId),
            eq(manufacturerRelations.currentRevision, current.currentRevision),
          ),
        )
        .returning()
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return { _tag: 'revision_conflict', actualRevision: current.currentRevision };
      }
      yield* append(row, input);
      return applied(row, payload.relationId);
    },
  );
  const remove: ManufacturerPersistence['remove'] = Effect.fn('ManufacturerPersistence.remove')(
    function* remove(input) {
      const { payload } = input;
      if (!validSubject(payload.subject, tenantId)) {
        return { _tag: 'invalid_change' };
      }
      const lockedProductId = yield* lock(payload.subject);
      if (Option.isNone(lockedProductId)) {
        return { _tag: 'not_found' };
      }
      const [current] = yield* get(payload.relationId);
      if (current === undefined || !sameSubject(current, payload.subject)) {
        return { _tag: 'not_found' };
      }
      if (current.currentRevision !== payload.expectedRevision) {
        return { _tag: 'revision_conflict', actualRevision: current.currentRevision };
      }
      if (current.disposition !== 'CONFIRMED') {
        return { _tag: 'invalid_change' };
      }
      const [row] = yield* transaction
        .update(manufacturerRelations)
        .set({
          currentRevision: current.currentRevision + 1,
          disposition: 'RETRACTED',
          evidenceRefs: [...payload.evidenceRefs],
          reason: payload.reason,
          updatedAt: DateTime.toDateUtc(yield* DateTime.now),
        })
        .where(
          and(
            eq(manufacturerRelations.tenantId, tenantId),
            eq(manufacturerRelations.relationId, current.relationId),
            eq(manufacturerRelations.currentRevision, current.currentRevision),
          ),
        )
        .returning()
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return { _tag: 'revision_conflict', actualRevision: current.currentRevision };
      }
      yield* append(row, input);
      return applied(row, payload.relationId);
    },
  );
  const history: ManufacturerPersistence['history'] = Effect.fn('ManufacturerPersistence.history')(
    function* history(id, subject) {
      if (!validSubject(subject, tenantId)) {
        return yield* unavailable();
      }
      const [relation] = yield* read(id);
      if (relation === undefined || !sameSubject(relation, subject)) {
        return Option.none();
      }
      const rows = yield* transaction
        .select()
        .from(manufacturerRelationRevisions)
        .where(
          and(eq(manufacturerRelationRevisions.tenantId, tenantId), eq(manufacturerRelationRevisions.relationId, id)),
        )
        .orderBy(manufacturerRelationRevisions.revision)
        .pipe(Effect.mapError(unavailable));
      if (rows.length !== relation.currentRevision) {
        return yield* unavailable();
      }
      const records = rows.map((row) => {
        const effectivePeriod: EffectivePeriodSnapshot = {};
        if (row.effectiveFrom !== null) {
          effectivePeriod.effectiveFrom = row.effectiveFrom.toISOString();
        }
        if (row.effectiveTo !== null) {
          effectivePeriod.effectiveTo = row.effectiveTo.toISOString();
        }
        return {
          disposition: row.disposition,
          effectivePeriod,
          evidenceRefs: row.evidenceRefs,
          reason: row.reason,
          recordedAt: row.recordedAt.toISOString(),
          relationId: row.relationId,
          revision: row.revision,
          subject,
          target: targetOf(row),
        };
      });
      const decoded = yield* Schema.decodeUnknownEffect(ManufacturerRelationHistorySchema)(records).pipe(
        Effect.mapError(unavailable),
      );
      return Option.some(decoded);
    },
  );
  return { change, history, remove, set };
};
