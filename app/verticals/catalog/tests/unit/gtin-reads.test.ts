import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { GtinCurrentRequestSchema, GtinCurrentResponseSchema } from '../../shared/apis/gtin-current.ts';
import { GtinHistoryRequestSchema, GtinHistoryResponseSchema } from '../../shared/apis/gtin-history.ts';
import { gtinCurrentEntrypoint } from '../../src/api/gtin-current.read.ts';
import { gtinHistoryEntrypoint } from '../../src/api/gtin-history.read.ts';
import { gtinResultPermissionTarget } from '../../src/api/gtin-read-support.ts';
import { commercialGtinAssignments } from '../../src/database/schema.ts';
import type { commercialGtinAssignmentRevisions } from '../../src/database/schema.ts';
import { gtinReadsForScope, gtinTargetFromRow } from '../../src/persistence/gtin-reads.ts';
import { GtinPersistenceUnavailable } from '../../src/persistence/gtin-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const packageDefinitionId = '55555555-5555-4555-8555-555555555555';
const code = '4006381333931';
const now = new Date('2026-09-17T00:00:00.000Z');
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:gtin-reads-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'gtin-reads-test',
};
const assignment = {
  currentRevision: 2,
  gtin: code,
  packageDefinitionId,
  productId,
  state: 'UNRESOLVED',
  tenantId,
  variantId,
};
const revision = (number: number, packageId: string | null, state: string) => ({
  actingPrincipalId: principalId,
  actionInvocationId: number === 1 ? '77777777-7777-4777-8777-777777777777' : '88888888-8888-4888-8888-888888888888',
  attributionEvidenceRef: `provider-record:${number}`,
  effectiveAt: now,
  gtin: code,
  packageDefinitionId: packageId,
  productId,
  reason: 'Documented GTIN attribution',
  recordedAt: now,
  revision: number,
  state,
  tenantId,
  variantId,
});
type Row = Readonly<Record<string, string | number | Date | null>>;
const selected = (rows: readonly Row[], history: readonly Row[]) => ({
  limit: () => Effect.succeed(rows),
  orderBy: () => Effect.succeed(history),
});
const from = (
  table: typeof commercialGtinAssignments | typeof commercialGtinAssignmentRevisions,
  current: Row | undefined,
  history: readonly Row[],
) => {
  let rows = history.slice(-1);
  if (table === commercialGtinAssignments) {
    rows = current === undefined ? [] : [current];
  }
  return { where: () => selected(rows, history) };
};
const fixture = (current: Row | undefined, history: readonly Row[]) => ({
  select: () => ({
    from: (table: typeof commercialGtinAssignments | typeof commercialGtinAssignmentRevisions) =>
      from(table, current, history),
  }),
});

describe('governed GTIN Current and history reads', () => {
  it('publishes code-only governed reads and checks the exact result resource', () => {
    expect(Option.isSome(Schema.decodeUnknownOption(GtinCurrentRequestSchema)({ code }))).toBe(true);
    expect(Option.isSome(Schema.decodeUnknownOption(GtinHistoryRequestSchema)({ code }))).toBe(true);
    expect(gtinCurrentEntrypoint.access).toBe('read');
    expect(gtinHistoryEntrypoint.access).toBe('historical_read');
    expect(gtinResultPermissionTarget(gtinTargetFromRow({ packageDefinitionId, variantId }, tenantId))).toEqual({
      moduleId: 'commerce.catalog',
      resourceId: packageDefinitionId,
      resourceType: 'commerce.catalog.package-definition',
      tenantId,
    });
  });

  it.effect('retains unresolved Current without presenting it as confirmed and preserves earlier exact targets', () =>
    Effect.gen(function* readsHistory() {
      const rows = [revision(1, null, 'CONFIRMED'), revision(2, packageDefinitionId, 'UNRESOLVED')];
      // @ts-expect-error Mock covers only the exercised scoped read chain.
      const reads = gtinReadsForScope(fixture(assignment, rows), scope);
      const current = yield* reads.current(code);
      expect(Option.isSome(current)).toBe(true);
      if (Option.isSome(current)) {
        expect(current.value.assignment.state).toBe('UNRESOLVED');
        expect(gtinTargetFromRow(current.value.assignment, tenantId)).toEqual({
          kind: 'PACKAGE_LEVEL',
          packageDefinitionId,
          tenantId,
        });
        expect(
          Option.isSome(
            Schema.decodeUnknownOption(GtinCurrentResponseSchema)({
              attributionEvidenceRef: current.value.head.attributionEvidenceRef,
              code,
              revision: 2,
              state: current.value.assignment.state,
              target: gtinTargetFromRow(current.value.assignment, tenantId),
            }),
          ),
        ).toBe(true);
      }
      const history = yield* reads.history(code);
      expect(history.map((row) => gtinTargetFromRow(row, tenantId).kind)).toEqual(['VARIANT', 'PACKAGE_LEVEL']);
      expect(
        Option.isSome(
          Schema.decodeUnknownOption(GtinHistoryResponseSchema)({
            revisions: history.map((row) => ({
              attributionEvidenceRef: row.attributionEvidenceRef,
              effectiveAt: row.effectiveAt.toISOString(),
              reason: row.reason,
              recordedAt: row.recordedAt.toISOString(),
              revision: row.revision,
              state: row.state,
              target: gtinTargetFromRow(row, tenantId),
            })),
          }),
        ),
      ).toBe(true);
    }),
  );

  it.effect('fails closed on missing revision, incomplete history, or cross-tenant rows', () =>
    Effect.gen(function* rejectsCorruption() {
      const one = revision(1, null, 'CONFIRMED');
      // @ts-expect-error Mock covers only the exercised scoped read chain.
      const missingHead = gtinReadsForScope(fixture(assignment, [one]), scope);
      expect(Schema.is(GtinPersistenceUnavailable)(yield* Effect.flip(missingHead.current(code)))).toBe(true);
      expect(Schema.is(GtinPersistenceUnavailable)(yield* Effect.flip(missingHead.history(code)))).toBe(true);
      // @ts-expect-error Mock covers only the exercised scoped read chain.
      const foreign = gtinReadsForScope(fixture({ ...assignment, tenantId: principalId }, [one]), scope);
      expect(Schema.is(GtinPersistenceUnavailable)(yield* Effect.flip(foreign.current(code)))).toBe(true);
      // @ts-expect-error Mock covers only the exercised scoped read chain.
      const absent = gtinReadsForScope(fixture(undefined, []), scope);
      expect(Option.isNone(yield* absent.current(code))).toBe(true);
      expect(yield* absent.history(code)).toEqual([]);
    }),
  );
});
