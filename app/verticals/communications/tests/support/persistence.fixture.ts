import { TrustedPrincipalContextSchema, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { makeCoreDatabase } from '@app/core-runtime/db/client';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { Crypto, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import type { LanguagePolicyPortContract } from '../../src/services/language-policy-port.service.ts';
import { postgresLanguagePolicyPort } from '../../src/services/language-policy.service.ts';
import type { TemplateRevisionPortContract } from '../../src/services/template-revision-port.service.ts';
import { postgresTemplateRevisionPort } from '../../src/services/template-revision.service.ts';
import type { TemplateActor } from '../../src/services/template-revision-domain.service.ts';

export const nativeServices = Layer.mergeAll(NodeCrypto.layer, NodeServices.layer, Reactivity.layer);
export const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

export const actorWith = (actionInvocationId: string, legalEntityId: string | null = null): TemplateActor => ({
  actionInvocationId,
  legalEntityId,
  principalId: '00000000-0000-4000-8000-0000000000b1',
});

export interface TableSelection {
  readonly schemas: readonly string[];
  readonly tables: readonly string[];
}

type RawTransaction = Parameters<
  Parameters<Effect.Success<ReturnType<typeof makeCoreDatabase>>['executor']['transaction']>[0]
>[0];

const quotedList = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

const rowsOfTable = (transaction: RawTransaction, schemaname: string, tablename: string) =>
  transaction
    .execute<{ readonly row: unknown }>(
      sql`select to_jsonb(t) as row from ${sql.identifier(schemaname)}.${sql.identifier(tablename)} t`,
      'objects',
    )
    .pipe(Effect.map((rows) => ({ rows: rows.map(({ row }) => row), table: `${schemaname}.${tablename}` })));

/** The tables come from `pg_catalog.pg_tables`, never from a list of this test. */
const scanSelectedTables = Effect.fn('CommunicationsTest.scanSelectedTables')(function* scanTables(
  transaction: RawTransaction,
  selection: TableSelection,
) {
  const catalog = yield* transaction.execute<{ readonly schemaname: string; readonly tablename: string }>(
    sql`select schemaname::text as schemaname, tablename::text as tablename from pg_catalog.pg_tables where schemaname in (${quotedList(selection.schemas)}) or schemaname || '.' || tablename in (${quotedList(selection.tables)}) order by schemaname, tablename`,
    'objects',
  );
  return yield* Effect.forEach(
    catalog,
    ({ schemaname, tablename }) => rowsOfTable(transaction, schemaname, tablename),
    {
      concurrency: 1,
    },
  );
});

const scopeFor = (tenantId: string) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: 'job:communications-template-tests:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-0000000000b1',
    tenantId,
  }).pipe(
    Effect.map((principal) => ({ ...principal, correlationId: 'communications-template-tests' })),
    Effect.orDie,
  );

/**
 * The Communications tables as the runtime role sees them: one connection pool as `ontos_runtime`, and every program
 * runs in one Core transaction with the Tenant installed by Core's own scoped-transaction installer, so row-level
 * security and the executor the port receives are the production ones. No Core identity row is needed because the
 * template tables reference none.
 */
export const makeRuntimeDatabase = Effect.fn('CommunicationsTest.runtimeDatabase')(function* runtimeDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const { executor } = yield* makeCoreDatabase(connections.runtime);
  const inTenant = <Value, Failure, Requirements>(
    tenantId: string,
    program: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
  ) =>
    executor.transaction(
      Effect.fn('CommunicationsTest.inTenant')(function* inTenantTransaction(transaction) {
        const scoped = yield* installOperationalScope(transaction, yield* scopeFor(tenantId));
        return yield* program(scoped);
      }),
    );
  const withPort = <Value, Failure, Requirements>(
    tenantId: string,
    program: (port: TemplateRevisionPortContract) => Effect.Effect<Value, Failure, Requirements>,
  ) => inTenant(tenantId, (transaction) => program(postgresTemplateRevisionPort(transaction, { tenantId })));
  /** The template and the language mode ports of one Tenant, in one Core transaction. */
  const withPorts = <Value, Failure, Requirements>(
    tenantId: string,
    program: (
      templates: TemplateRevisionPortContract,
      policies: LanguagePolicyPortContract,
    ) => Effect.Effect<Value, Failure, Requirements>,
  ) =>
    inTenant(tenantId, (transaction) =>
      program(
        postgresTemplateRevisionPort(transaction, { tenantId }),
        postgresLanguagePolicyPort(transaction, { tenantId }),
      ),
    );
  /**
   * EVERY row of EVERY table of the given schemas, plus every row of the named tables of other schemas, that the runtime
   * role sees for one Tenant, as JSON. The tables of the schemas are enumerated from the database catalog inside the same
   * Tenant transaction, so a table added later is scanned without anyone listing it.
   */
  const everyRowOf = (tenantId: string, selection: TableSelection) =>
    executor.transaction(
      Effect.fn('CommunicationsTest.everyRowOf')(function* scanTables(transaction) {
        yield* installOperationalScope(transaction, yield* scopeFor(tenantId));
        return yield* scanSelectedTables(transaction, selection);
      }),
    );
  return { everyRowOf, inTenant, withPort, withPorts };
});
