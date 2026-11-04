import { CoreSearchWorkerSnapshot, ReadHandlerUnavailable } from '@app/core-runtime';
import type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotView,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Schema, Struct } from 'effect';
import { EmployeeSchema } from '../../shared/apis/records.ts';
import { workforceStates } from '../database/schema.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Workforce search snapshot is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

/** Search approval is limited to employment name, role and department, never contact or authentication data. */
const SearchEmployeeSchema = Schema.Struct(
  Struct.pick(EmployeeSchema.fields, ['active', 'department', 'fullName', 'id', 'role']),
);

export interface WorkforceSearchSnapshot {
  readonly employees: readonly (typeof SearchEmployeeSchema.Type & {
    readonly legalEntityId: string;
    readonly tenantId: string;
  })[];
  readonly projectionVersion: string;
  readonly tenantId: string;
}

const readCompany = Effect.fn('WorkforceSearch.readCompany')(function* readCompany(
  database: CoreSearchSnapshotReadExecutor,
  tenantId: string,
  legalEntityId: string,
) {
  // Drizzle cannot express an allowlisted projection of records inside the owner JSON array.
  // Do not select the whole state: credentials, e-mail, phone and principalRef never leave SQL.
  const rows = yield* database
    .select({
      employees: sql<unknown>`case when jsonb_typeof(${workforceStates.state}->'employees') = 'array' then coalesce((
        select jsonb_agg(jsonb_build_object(
          'active', employee->'active',
          'department', employee->'department',
          'fullName', employee->'fullName',
          'id', employee->'id',
          'role', employee->'role'
        )) from jsonb_array_elements(${workforceStates.state}->'employees') as employee
      ), '[]'::jsonb) else null end`,
      legalEntityId: workforceStates.legalEntityId,
      tenantId: workforceStates.tenantId,
    })
    .from(workforceStates)
    .where(and(eq(workforceStates.tenantId, tenantId), eq(workforceStates.legalEntityId, legalEntityId)))
    .limit(1);
  const [row] = rows;
  if (row === undefined) {
    return [];
  }
  if (row.tenantId !== tenantId || row.legalEntityId !== legalEntityId) {
    return yield* unavailable();
  }
  const employees = yield* Schema.decodeUnknownEffect(Schema.Array(SearchEmployeeSchema))(row.employees);
  return employees.map((employee) => ({ ...employee, legalEntityId, tenantId }));
});

const readSnapshot = Effect.fn('WorkforceSearch.readSnapshot')(function* readSnapshot(
  view: CoreSearchWorkerSnapshotView,
  context: OutboxWorkerHandlerContext,
) {
  if (
    view.tenantId !== context.tenantId ||
    view.legalEntityIds.length === 0 ||
    new Set(view.legalEntityIds).size !== view.legalEntityIds.length
  ) {
    return yield* unavailable();
  }
  const employees = yield* Effect.forEach(
    view.legalEntityIds,
    (legalEntityId) =>
      view.forLegalEntity(legalEntityId, (database) => readCompany(database, view.tenantId, legalEntityId)),
    { concurrency: 1 },
  );
  return {
    employees: employees.flat(),
    projectionVersion: view.projectionVersion,
    tenantId: view.tenantId,
  } satisfies WorkforceSearchSnapshot;
});

/**
 * Core verifies the registered post-commit claim, owns the coherent read transaction and generation,
 * and installs each exact company scope. No owner pool, ambient credentials or admin fallback exists.
 * A failed company read fails the entire snapshot; missing owner rows are authoritative empty scopes.
 */
export const loadWorkforceSearchSnapshot = Effect.fn('WorkforceSearch.snapshot')(function* loadSnapshot(
  context: OutboxWorkerHandlerContext,
) {
  const reader = yield* CoreSearchWorkerSnapshot;
  return yield* reader.read(context, (view) => readSnapshot(view, context)).pipe(Effect.mapError(unavailable));
});
