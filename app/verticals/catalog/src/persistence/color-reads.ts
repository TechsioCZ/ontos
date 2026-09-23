import { isDeepStrictEqual } from 'node:util';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { ColorDetailsSchema } from '../../shared/domain/color.ts';
import type { ColorDetails } from '../../shared/domain/color.ts';
import { ControlledAttributeValueRefSchema } from '../../shared/resources/controlled-attribute-value.ts';
import type { ControlledAttributeValueRef } from '../../shared/resources/controlled-attribute-value.ts';
import { controlledAttributeValueRevisions, controlledAttributeValues } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type RevisionRow = typeof controlledAttributeValueRevisions.$inferSelect;

interface ColorRevisionRead {
  readonly attributeDefinitionId: string;
  readonly colorDetails: ColorDetails | null;
  readonly displayName: string;
  readonly evidenceRefs: readonly string[];
  readonly lifecycleState: 'ACTIVE' | 'RETIRED';
  readonly reason: string;
  readonly recordedAt: Date;
  readonly revision: number;
  readonly valueRef: ControlledAttributeValueRef;
}

interface ColorCurrentRead extends ColorRevisionRead {
  readonly assignable: boolean;
}

export interface ColorReads {
  readonly current: (
    ref: ControlledAttributeValueRef,
  ) => Effect.Effect<Option.Option<ColorCurrentRead>, CatalogPersistenceUnavailable>;
  readonly history: (
    ref: ControlledAttributeValueRef,
  ) => Effect.Effect<readonly ColorRevisionRead[], CatalogPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const error = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog Color read is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const validId = Schema.is(Schema.String.check(Schema.isUUID()));
const validText = (value: string) => value.length > 0 && value.trim() === value;
const validDetails = Schema.is(Schema.Union([Schema.Null, ColorDetailsSchema]));

const decodeRevision = (row: RevisionRow, ref: ControlledAttributeValueRef): ColorRevisionRead | null => {
  if (
    row.tenantId !== ref.tenantId ||
    row.controlledAttributeValueId !== ref.resourceId ||
    row.specialization !== 'COLOR' ||
    !validId(row.attributeDefinitionId) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !validText(row.name) ||
    !validText(row.reason) ||
    !validDetails(row.colorDetails) ||
    (row.lifecycleState !== 'ACTIVE' && row.lifecycleState !== 'RETIRED') ||
    !Array.isArray(row.evidenceRefs) ||
    row.evidenceRefs.some((evidenceRef) => !validText(evidenceRef)) ||
    Object.prototype.toString.call(row.recordedAt) !== '[object Date]' ||
    Number.isNaN(row.recordedAt.getTime())
  ) {
    return null;
  }
  return {
    attributeDefinitionId: row.attributeDefinitionId,
    colorDetails: row.colorDetails,
    displayName: row.name,
    evidenceRefs: row.evidenceRefs,
    lifecycleState: row.lifecycleState,
    reason: row.reason,
    recordedAt: row.recordedAt,
    revision: row.revision,
    valueRef: ref,
  };
};

/** Runs only inside Core's verified, tenant-scoped read transaction. */
export const colorReadsForScope = (transaction: ScopedTransaction, scope: OperationalScope): ColorReads => {
  const validRef = (ref: ControlledAttributeValueRef) =>
    Schema.is(ControlledAttributeValueRefSchema)(ref) && ref.tenantId === scope.tenantId;
  const history = Effect.fn('ColorReads.history')(function* history(ref: ControlledAttributeValueRef) {
    if (!validRef(ref)) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .select()
      .from(controlledAttributeValueRevisions)
      .where(
        and(
          eq(controlledAttributeValueRevisions.tenantId, scope.tenantId),
          eq(controlledAttributeValueRevisions.controlledAttributeValueId, ref.resourceId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const sorted = rows.toSorted((a, b) => a.revision - b.revision);
    const revisions: ColorRevisionRead[] = [];
    for (const [index, row] of sorted.entries()) {
      if (row.revision !== index + 1) {
        return yield* unavailable();
      }
      const decoded = decodeRevision(row, ref);
      if (decoded === null || (index > 0 && decoded.attributeDefinitionId !== revisions[0]?.attributeDefinitionId)) {
        return yield* unavailable();
      }
      revisions.push(decoded);
    }
    return revisions;
  });
  return {
    current: Effect.fn('ColorReads.current')(function* current(ref) {
      if (!validRef(ref)) {
        return yield* unavailable();
      }
      const [head] = yield* transaction
        .select()
        .from(controlledAttributeValues)
        .where(
          and(
            eq(controlledAttributeValues.tenantId, scope.tenantId),
            eq(controlledAttributeValues.controlledAttributeValueId, ref.resourceId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (head === undefined || head.specialization !== 'COLOR') {
        return Option.none();
      }
      const revisions = yield* history(ref);
      const latest = revisions.at(-1);
      if (
        latest === undefined ||
        head.attributeDefinitionId !== latest.attributeDefinitionId ||
        head.currentRevision !== latest.revision ||
        head.name !== latest.displayName ||
        head.lifecycleState !== latest.lifecycleState ||
        !validDetails(head.colorDetails) ||
        !isDeepStrictEqual(head.colorDetails, latest.colorDetails)
      ) {
        return yield* unavailable();
      }
      return Option.some({ ...latest, assignable: latest.lifecycleState === 'ACTIVE' });
    }),
    history,
  };
};
