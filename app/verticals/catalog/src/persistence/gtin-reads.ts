import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { Effect, Option } from 'effect';

import { commercialGtinAssignmentRevisions, commercialGtinAssignments } from '../database/schema.ts';
import type { GtinTarget } from '../../shared/domain/commercial-code.ts';
import { GtinPersistenceUnavailable } from './gtin-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Assignment = typeof commercialGtinAssignments.$inferSelect;
type Revision = typeof commercialGtinAssignmentRevisions.$inferSelect;

export const gtinTargetFromRow = (
  row: Pick<Assignment, 'packageDefinitionId' | 'variantId'>,
  tenantId: string,
): GtinTarget =>
  row.packageDefinitionId === null
    ? { kind: 'VARIANT', tenantId, variantId: row.variantId }
    : { kind: 'PACKAGE_LEVEL', packageDefinitionId: row.packageDefinitionId, tenantId };

export interface GtinReads {
  readonly current: (
    code: string,
  ) => Effect.Effect<
    Option.Option<{ readonly assignment: Assignment; readonly head: Revision }>,
    GtinPersistenceUnavailable
  >;
  readonly history: (code: string) => Effect.Effect<readonly Revision[], GtinPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const error = new GtinPersistenceUnavailable({
    code: 'gtin_persistence_unavailable',
    reason: 'Authoritative GTIN attribution or history is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const matchesHead = (assignment: Assignment, head: Revision): boolean =>
  head.gtin === assignment.gtin &&
  head.revision === assignment.currentRevision &&
  head.state === assignment.state &&
  head.productId === assignment.productId &&
  head.variantId === assignment.variantId &&
  head.packageDefinitionId === assignment.packageDefinitionId;

/** Owner-local governed reads never infer GTIN ownership from Product names or SKU values. */
export const gtinReadsForScope = (transaction: ScopedTransaction, scope: OperationalScope): GtinReads => {
  const { tenantId } = scope;
  const assignment = (code: string) =>
    transaction
      .select()
      .from(commercialGtinAssignments)
      .where(and(eq(commercialGtinAssignments.tenantId, tenantId), eq(commercialGtinAssignments.gtin, code)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const revision = (code: string, number: number) =>
    transaction
      .select()
      .from(commercialGtinAssignmentRevisions)
      .where(
        and(
          eq(commercialGtinAssignmentRevisions.tenantId, tenantId),
          eq(commercialGtinAssignmentRevisions.gtin, code),
          eq(commercialGtinAssignmentRevisions.revision, number),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const current: GtinReads['current'] = Effect.fn('GtinReads.current')(function* current(code) {
    const [row] = yield* assignment(code);
    if (row === undefined) {
      return Option.none();
    }
    if (row.tenantId !== tenantId || row.gtin !== code) {
      return yield* unavailable();
    }
    const [head] = yield* revision(code, row.currentRevision);
    if (head === undefined || head.tenantId !== tenantId || !matchesHead(row, head)) {
      return yield* unavailable();
    }
    return Option.some({ assignment: row, head });
  });
  const history: GtinReads['history'] = Effect.fn('GtinReads.history')(function* history(code) {
    const [row] = yield* assignment(code);
    if (row === undefined) {
      return [];
    }
    if (row.tenantId !== tenantId || row.gtin !== code) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .select()
      .from(commercialGtinAssignmentRevisions)
      .where(
        and(eq(commercialGtinAssignmentRevisions.tenantId, tenantId), eq(commercialGtinAssignmentRevisions.gtin, code)),
      )
      .orderBy(asc(commercialGtinAssignmentRevisions.revision))
      .pipe(Effect.mapError(unavailable));
    if (
      rows.length !== row.currentRevision ||
      !rows.every((item, index) => item.tenantId === tenantId && item.gtin === code && item.revision === index + 1)
    ) {
      return yield* unavailable();
    }
    const head = rows.at(-1);
    if (head === undefined || !matchesHead(row, head)) {
      return yield* unavailable();
    }
    return rows;
  });
  return { current, history };
};
