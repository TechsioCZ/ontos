import { NodeServices } from '@effect/platform-node';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import type { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Effect, Fiber, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTestPgSession } from '../../../../packages/core-runtime/tests/support/database.ts';
import type {
  AcceptPaymentTermSourceStatementPayload,
  ConfigurePaymentTermSourceAuthorityPayload,
  PaymentTermSourceKey,
} from '../../shared/domain/payment-term-source.ts';
import type { PaymentTermSourceRecordHistoryRequest } from '../../shared/apis/payment-term-source-record-history.ts';
import { PaymentTermDefinitionSchema } from '../../shared/domain/payment-term.ts';

interface MutationIdentity {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
}
type SourceRoutineInput =
  | PaymentTermSourceKey
  | PaymentTermSourceRecordHistoryRequest
  | (AcceptPaymentTermSourceStatementPayload & MutationIdentity)
  | (ConfigurePaymentTermSourceAuthorityPayload & MutationIdentity);
const migrationRoot = new URL('../../drizzle/', import.meta.url);
const drizzleKit = new URL('../../node_modules/.bin/drizzle-kit', import.meta.url).pathname;
const taskMigrations = new Set(['20261007193711_canonical-source-authority', '20261008033335_cheerful_oracle']);
const semantics = {
  calculationRuleVersion: 2,
  calendarRule: 'CALENDAR_DAYS',
  days: 14,
  dueDateAnchor: 'INVOICE_ISSUE_DATE',
  kind: 'NET_DAYS',
} as const;
const acceptedDefinition = Schema.Struct({ result: Schema.Struct({ definition: PaymentTermDefinitionSchema }) });
const decision = Schema.Struct({ canonicalCreated: Schema.Boolean, changed: Schema.Boolean, result: Schema.Unknown });
const call = (
  client: PgClient.PgClient,
  tenant: string,
  legalEntity: string,
  routine:
    | 'accept_source_statement'
    | 'configure_source_authority'
    | 'get_source_record_history'
    | 'get_source_statement',
  input: SourceRoutineInput,
) => {
  // Fixed owner routine SQL is infrastructure test evidence; business input remains parameterized.
  const queries = {
    accept_source_statement:
      'select payload from payment_term_catalog.accept_source_statement($1::uuid,$2::uuid,$3::jsonb)',
    configure_source_authority:
      'select payload from payment_term_catalog.configure_source_authority($1::uuid,$2::uuid,$3::jsonb)',
    get_source_record_history:
      'select payload from payment_term_catalog.get_source_record_history($1::uuid,$2::uuid,$3::jsonb)',
    get_source_statement: 'select payload from payment_term_catalog.get_source_statement($1::uuid,$2::uuid,$3::jsonb)',
  };
  return client
    .unsafe<{ readonly payload: unknown }>(queries[routine], [tenant, legalEntity, JSON.stringify(input)])
    .pipe(Effect.map((rows) => rows[0]?.payload));
};
const inScope = (client: PgClient.PgClient, tenant: string, legalEntity: string) =>
  Effect.gen(function* installScope() {
    yield* client.unsafe('BEGIN');
    yield* client.unsafe("select set_config('ontos.tenant_id',$1,true),set_config('ontos.legal_entity_id',$2,true)", [
      tenant,
      legalEntity,
    ]);
  });

const waitForCompetingRoutineLock = (admin: PgClient.PgClient, competingPid: number, firstPid: number) =>
  Effect.gen(function* proveConcurrentRoutineWait() {
    // Observe the competing statement inside PostgreSQL before releasing the first
    // transaction. A sequential replay cannot satisfy this barrier.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = yield* admin.unsafe<{ readonly blocked: boolean }>(
        `select exists(select 1 from pg_stat_activity
          where pid=$1 and wait_event_type='Lock'
            and query like '%payment_term_catalog.accept_source_statement%'
            and $2::int = any(pg_blocking_pids(pid))) as blocked`,
        [competingPid, firstPid],
      );
      if (rows[0]?.blocked) {
        return;
      }
      yield* Effect.sleep('10 millis');
    }
    expect.fail('Competing owner routine did not block on the first transaction');
  });

const migrateOwner = (temporaryDirectory: string, folder: string, adminUrl: string) =>
  Effect.gen(function* runRepositoryOwnerMigrator() {
    const configPath = path.join(temporaryDirectory, 'drizzle-proof.config.cjs');
    // The pinned repository migrator accepts immutable legacy multi-command migration SQL.
    // Credentials remain environment values and are never written to source or printed.
    yield* Effect.tryPromise(() =>
      writeFile(
        configPath,
        `module.exports = ${JSON.stringify({ dialect: 'postgresql', migrations: { schema: 'drizzle', table: '__drizzle_migrations_payment_term_catalog' }, out: folder })}; module.exports.dbCredentials = {url: process.env.C15_PROOF_ADMIN_URL};`,
      ),
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const status = yield* spawner.exitCode(
      ChildProcess.make('mise', ['exec', '--', drizzleKit, 'migrate', '--config', configPath], {
        env: { C15_PROOF_ADMIN_URL: adminUrl },
        extendEnv: true,
        stderr: 'inherit',
        stdout: 'ignore',
      }),
    );
    expect(status).toBe(0);
  }).pipe(Effect.provide(NodeServices.layer));

const proveDatabase = (populated: boolean) =>
  Effect.scoped(
    Effect.gen(function* proveOwnerMigrationAndDecisions() {
      const connections = yield* loadDatabaseConnectionPair();
      const control = yield* makeTestPgSession(connections.admin.connectionString);
      const databaseName = `c15_proof_${randomUUID().replaceAll('-', '')}`;
      // This identifier is generated by the test, never supplied by a request.
      yield* control.unsafe(`CREATE DATABASE "${databaseName}"`);
      yield* Effect.addFinalizer(() =>
        control.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`).pipe(Effect.orDie),
      );
      const adminUrl = new URL(connections.admin.connectionString);
      adminUrl.pathname = `/${databaseName}`;
      const runtimeUrl = new URL(connections.runtime.connectionString);
      runtimeUrl.pathname = `/${databaseName}`;
      const admin = yield* makeTestPgSession(adminUrl.toString(), { prepare: false });
      const runtime = yield* makeTestPgSession(runtimeUrl.toString());
      const competitor = yield* makeTestPgSession(runtimeUrl.toString());
      const runtimePid = yield* Schema.decodeUnknownEffect(Schema.Struct({ pid: Schema.Number }))(
        (yield* runtime.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid'))[0],
      );
      const competitorPid = yield* Schema.decodeUnknownEffect(Schema.Struct({ pid: Schema.Number }))(
        (yield* competitor.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid'))[0],
      );
      const oldMigrations = yield* Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), 'c15-history-')));
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise(() => rm(oldMigrations, { force: true, recursive: true })).pipe(Effect.orDie),
      );
      const folders = yield* Effect.tryPromise(() => readdir(migrationRoot));
      for (const folder of EffectArray.sort(folders, Order.String)) {
        if (!taskMigrations.has(folder)) {
          yield* Effect.tryPromise(() =>
            cp(new URL(`${folder}/`, migrationRoot), path.join(oldMigrations, folder), { recursive: true }),
          );
        }
      }
      yield* migrateOwner(oldMigrations, oldMigrations, adminUrl.toString());
      const tenant = randomUUID();
      const legalEntity = randomUUID();
      const principal = randomUUID();
      let retainedRows: readonly object[] = [];
      let retainedId: string | undefined;
      if (populated) {
        yield* inScope(admin, tenant, legalEntity);
        const rows = yield* admin.unsafe<{ readonly payload: unknown }>(
          'select payload from payment_term_catalog.create_term($1,$2,$3)',
          [
            tenant,
            legalEntity,
            JSON.stringify({
              actingPrincipalId: principal,
              actionInvocationId: randomUUID(),
              activeFrom: '2026-09-01T00:00:00.000Z',
              businessCode: 'LEGACY14',
              compatibilityKey: 'net_days.invoice_issued_at.calendar_days_utc.v1',
              displayName: 'Retained 14-day instant',
              explanation: 'Retained original meaning',
              reason: 'Historical fixture',
              semantics: {
                calculationRuleVersion: 1,
                calendarRule: 'CALENDAR_DAYS_UTC',
                days: 14,
                dueDateAnchor: 'INVOICE_ISSUED_AT',
                kind: 'NET_DAYS',
              },
            }),
          ],
        );
        const created = yield* Schema.decodeUnknownEffect(Schema.Struct({ definition: PaymentTermDefinitionSchema }))(
          rows[0]?.payload,
        );
        retainedId = created.definition.paymentTermRef.resourceId;
        retainedRows = yield* admin.unsafe(
          'select row_to_json(r) as retained from payment_term_catalog.payment_term_revisions r',
        );
        yield* admin.unsafe('COMMIT');
      }
      yield* migrateOwner(oldMigrations, migrationRoot.pathname, adminUrl.toString());
      const journal = yield* admin.unsafe(
        'select id,hash,name from drizzle.__drizzle_migrations_payment_term_catalog order by id',
      );
      yield* migrateOwner(oldMigrations, migrationRoot.pathname, adminUrl.toString());
      expect(
        yield* admin.unsafe('select id,hash,name from drizzle.__drizzle_migrations_payment_term_catalog order by id'),
      ).toEqual(journal);
      if (populated) {
        expect(
          yield* admin.unsafe('select row_to_json(r) as retained from payment_term_catalog.payment_term_revisions r'),
        ).toEqual(retainedRows);
        yield* inScope(runtime, tenant, legalEntity);
        const rows = yield* runtime.unsafe<{ readonly payload: unknown }>(
          'select payload from payment_term_catalog.get_current($1,$2,$3)',
          [tenant, legalEntity, retainedId ?? null],
        );
        expect(rows[0]?.payload).toMatchObject({
          semantics: {
            calculationRuleVersion: 1,
            calendarRule: 'CALENDAR_DAYS_UTC',
            days: 14,
            dueDateAnchor: 'INVOICE_ISSUED_AT',
            kind: 'NET_DAYS',
          },
        });
        expect(rows[0]?.payload).not.toHaveProperty('compatibleWith');
        yield* runtime.unsafe('COMMIT');
      }
      const source: AcceptPaymentTermSourceStatementPayload & { readonly actingPrincipalId: string } = {
        actingPrincipalId: principal,
        businessObservedAt: '2026-10-01T00:00:00.000Z',
        externalBusinessSystemId: 'actual-erp',
        integrationRoute: 'symmy-payment-terms',
        mapping: {
          activeFrom: '2026-10-01T00:00:00.000Z',
          code: 'ERP_NET14',
          description: 'Fourteen calendar days',
          kind: 'CREATE',
          name: 'Net 14',
        },
        namespace: 'accounting-company-a',
        reason: 'Accept qualified source definition',
        semantics,
        sourceCode: 'F14',
        sourceRecordId: 'record-14',
        sourceRevision: 1,
        sourceStatementId: 'statement-1',
      };
      const acceptance = (changes: Partial<AcceptPaymentTermSourceStatementPayload> = {}) => ({
        ...source,
        ...changes,
        actionInvocationId: randomUUID(),
      });
      const invoke = (routine: Parameters<typeof call>[3], input: SourceRoutineInput) =>
        call(runtime, tenant, legalEntity, routine, input);
      const configure = (expectedRevision: number) => ({
        actingPrincipalId: principal,
        actionInvocationId: randomUUID(),
        expectedRevision,
        externalBusinessSystemId: source.externalBusinessSystemId,
        ingestPrincipalId: principal,
        integrationRoute: source.integrationRoute,
        namespace: source.namespace,
        reason: 'Govern source authority',
      });
      yield* inScope(runtime, tenant, legalEntity);
      expect(yield* invoke('accept_source_statement', acceptance())).toMatchObject({
        changed: false,
        result: { reason: 'UNAUTHORIZED_SOURCE' },
      });
      yield* runtime.unsafe('COMMIT');
      expect(
        yield* admin.unsafe('select count(*)::int as count from payment_term_catalog.payment_term_source_statements'),
      ).toEqual([{ count: 0 }]);
      yield* inScope(runtime, tenant, legalEntity);
      expect(
        Schema.is(Schema.TaggedStruct('configured', { authorityRevision: Schema.Literal(1) }))(
          yield* invoke('configure_source_authority', configure(0)),
        ),
      ).toBe(true);
      expect(
        Schema.is(Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Literal(1) }))(
          yield* invoke('configure_source_authority', configure(2_147_483_648)),
        ),
      ).toBe(true);
      yield* runtime.unsafe('COMMIT');
      yield* inScope(runtime, tenant, legalEntity);
      const mismatchedQualifications = yield* Effect.forEach(
        [
          { changes: { externalBusinessSystemId: 'unconfigured-erp' }, suffix: 'ebs' },
          { changes: { integrationRoute: 'unconfigured-route' }, suffix: 'route' },
          { changes: { namespace: 'unconfigured-namespace' }, suffix: 'namespace' },
        ],
        ({ changes, suffix }) =>
          invoke(
            'accept_source_statement',
            acceptance({
              ...changes,
              sourceRecordId: `mismatch-${suffix}`,
              sourceStatementId: `mismatch-${suffix}`,
            }),
          ),
      );
      expect(mismatchedQualifications).toMatchObject([
        { changed: false, result: { reason: 'UNAUTHORIZED_SOURCE' } },
        { changed: false, result: { reason: 'UNAUTHORIZED_SOURCE' } },
        { changed: false, result: { reason: 'UNAUTHORIZED_SOURCE' } },
      ]);
      yield* runtime.unsafe('COMMIT');
      expect(
        yield* admin.unsafe(
          "select count(*)::int as count from payment_term_catalog.payment_term_source_statements where source_statement_id like 'mismatch-%'",
        ),
      ).toEqual([{ count: 0 }]);
      yield* inScope(runtime, tenant, legalEntity);
      const originalRaw = yield* invoke('accept_source_statement', acceptance());
      const original = yield* Schema.decodeUnknownEffect(decision)(originalRaw);
      const accepted = yield* Schema.decodeUnknownEffect(acceptedDefinition)(originalRaw);
      expect(original.canonicalCreated).toBe(true);
      expect(accepted.result.definition.semantics).toEqual(semantics);
      const oldRef = accepted.result.definition.paymentTermRef;
      yield* runtime.unsafe('COMMIT');
      yield* inScope(runtime, tenant, legalEntity);
      expect(yield* invoke('accept_source_statement', acceptance())).toEqual({
        canonicalCreated: false,
        changed: false,
        result: original.result,
      });
      expect(yield* invoke('accept_source_statement', acceptance({ sourceCode: 'CHANGED' }))).toMatchObject({
        result: { reason: 'STATEMENT_CONFLICT' },
      });
      const replacement = yield* invoke(
        'accept_source_statement',
        acceptance({
          mapping: {
            activeFrom: '2026-10-01T00:00:00.000Z',
            code: 'ERP_NET30',
            description: 'Thirty calendar days',
            kind: 'CREATE',
            name: 'Net 30',
          },
          semantics: { ...semantics, days: 30 },
          sourceRevision: 2,
          sourceStatementId: 'statement-2',
        }),
      );
      const replacementDefinition = yield* Schema.decodeUnknownEffect(acceptedDefinition)(replacement);
      expect(replacementDefinition.result.definition.paymentTermRef).not.toEqual(oldRef);

      // The source-record ordering barrier advances for every authorized persisted
      // decision, including a rejected observation. The accepted mapping remains
      // unchanged until a later accepted revision supersedes it explicitly.
      const orderedRecord = {
        mapping: { kind: 'EXISTING' as const, paymentTermId: oldRef.resourceId },
        sourceRecordId: 'record-ordering',
        sourceStatementId: 'ordering-1',
      };
      const orderingOne = yield* invoke('accept_source_statement', acceptance(orderedRecord));
      expect(orderingOne).toMatchObject({ changed: true, result: { _tag: 'ACCEPTED', sourceRevision: 1 } });
      const orderingRejected = acceptance({
        ...orderedRecord,
        semantics: { evidence: 'Upstream revision cannot be interpreted', kind: 'UNSUPPORTED' },
        sourceRevision: 3,
        sourceStatementId: 'ordering-3-rejected',
      });
      const rejectedThree = yield* Schema.decodeUnknownEffect(decision)(
        yield* invoke('accept_source_statement', orderingRejected),
      );
      expect(rejectedThree).toMatchObject({
        changed: true,
        result: { reason: 'UNSUPPORTED_SEMANTICS', sourceRevision: 3 },
      });
      expect(
        yield* invoke(
          'accept_source_statement',
          acceptance({ ...orderedRecord, sourceRevision: 2, sourceStatementId: 'ordering-2-delayed' }),
        ),
      ).toMatchObject({ changed: true, result: { reason: 'STALE_REVISION', sourceRevision: 2 } });
      expect(
        yield* invoke(
          'accept_source_statement',
          acceptance({ ...orderedRecord, sourceRevision: 3, sourceStatementId: 'ordering-3-competing' }),
        ),
      ).toMatchObject({ changed: true, result: { reason: 'AMBIGUOUS_MAPPING', sourceRevision: 3 } });
      const orderingFour = yield* invoke(
        'accept_source_statement',
        acceptance({
          ...orderedRecord,
          mapping: {
            kind: 'EXISTING',
            paymentTermId: replacementDefinition.result.definition.paymentTermRef.resourceId,
          },
          semantics: { ...semantics, days: 30 },
          sourceRevision: 4,
          sourceStatementId: 'ordering-4',
        }),
      );
      expect(orderingFour).toMatchObject({ changed: true, result: { _tag: 'ACCEPTED', sourceRevision: 4 } });
      expect(yield* invoke('accept_source_statement', orderingRejected)).toEqual({
        canonicalCreated: false,
        changed: false,
        result: rejectedThree.result,
      });

      yield* runtime.unsafe('COMMIT');
      const orderedState = yield* admin.unsafe<{
        readonly acceptedStatement: string;
        readonly highestObservedRevision: string;
        readonly highestStatement: string;
      }>(
        `select accepted.source_statement_id as "acceptedStatement",
          state.highest_observed_revision::text as "highestObservedRevision",
          highest.source_statement_id as "highestStatement"
        from payment_term_catalog.payment_term_source_record_states state
        join payment_term_catalog.payment_term_source_statements highest
          on highest.source_statement_ledger_id=state.highest_observed_statement_ledger_id
        join payment_term_catalog.payment_term_source_statements accepted
          on accepted.source_statement_ledger_id=state.current_accepted_statement_ledger_id
        where state.tenant_id=$1 and state.legal_entity_id=$2
          and state.external_business_system_id=$3 and state.namespace=$4
          and state.integration_route=$5 and state.source_record_id=$6`,
        [
          tenant,
          legalEntity,
          source.externalBusinessSystemId,
          source.namespace,
          source.integrationRoute,
          orderedRecord.sourceRecordId,
        ],
      );
      expect(orderedState).toEqual([
        { acceptedStatement: 'ordering-4', highestObservedRevision: '4', highestStatement: 'ordering-4' },
      ]);
      expect(
        yield* admin.unsafe(
          `select previous.source_statement_id as predecessor
          from payment_term_catalog.payment_term_source_acceptance_lineage lineage
          join payment_term_catalog.payment_term_source_statements current
            on current.source_statement_ledger_id=lineage.accepted_statement_ledger_id
          join payment_term_catalog.payment_term_source_statements previous
            on previous.source_statement_ledger_id=lineage.predecessor_statement_ledger_id
          where current.source_statement_id=$1`,
          ['ordering-4'],
        ),
      ).toEqual([{ predecessor: 'ordering-1' }]);
      yield* inScope(runtime, tenant, legalEntity);
      expect(
        yield* invoke('get_source_record_history', {
          externalBusinessSystemId: source.externalBusinessSystemId,
          integrationRoute: source.integrationRoute,
          limit: 2,
          namespace: source.namespace,
          sourceRecordId: orderedRecord.sourceRecordId,
        }),
      ).toMatchObject({
        currentAccepted: {
          paymentTermRef: replacementDefinition.result.definition.paymentTermRef,
          sourceRevision: 4,
          sourceStatementId: 'ordering-4',
        },
        decisions: [
          { sourceRevision: 4, sourceStatementId: 'ordering-4', supersedesSourceStatementId: 'ordering-1' },
          { sourceRevision: 3 },
        ],
        highestObserved: { sourceRevision: 4, sourceStatementId: 'ordering-4' },
        sourceRecord: { sourceRecordId: orderedRecord.sourceRecordId },
        truncated: true,
      });
      yield* runtime.unsafe('COMMIT');

      // Persisted statement identity is immutable evidence. Exact replay and
      // conflict detection precede mutable authority checks, while a novel
      // statement must satisfy the current route/principal binding and writes nothing otherwise.
      const rotationRoute = 'symmy-payment-terms-rotation';
      const principalB = randomUUID();
      const rotationAuthority = { ...configure(0), integrationRoute: rotationRoute };
      yield* inScope(runtime, tenant, legalEntity);
      expect(
        Schema.is(Schema.TaggedStruct('configured', { authorityRevision: Schema.Literal(1) }))(
          yield* invoke('configure_source_authority', rotationAuthority),
        ),
      ).toBe(true);
      const rotatedStatement = acceptance({
        integrationRoute: rotationRoute,
        mapping: { kind: 'EXISTING', paymentTermId: oldRef.resourceId },
        sourceRecordId: 'record-rotation',
        sourceStatementId: 'rotation-1',
      });
      const rotationAccepted = yield* Schema.decodeUnknownEffect(decision)(
        yield* invoke('accept_source_statement', rotatedStatement),
      );
      expect(rotationAccepted).toMatchObject({ changed: true, result: { _tag: 'ACCEPTED' } });
      expect(
        Schema.is(Schema.TaggedStruct('configured', { authorityRevision: Schema.Literal(2) }))(
          yield* invoke('configure_source_authority', {
            ...rotationAuthority,
            actionInvocationId: randomUUID(),
            expectedRevision: 1,
            ingestPrincipalId: principalB,
          }),
        ),
      ).toBe(true);
      expect(yield* invoke('accept_source_statement', rotatedStatement)).toEqual({
        canonicalCreated: false,
        changed: false,
        result: rotationAccepted.result,
      });
      expect(
        yield* invoke('accept_source_statement', { ...rotatedStatement, sourceCode: 'CHANGED-AFTER-ROTATION' }),
      ).toMatchObject({ changed: false, result: { reason: 'STATEMENT_CONFLICT' } });
      expect(
        yield* invoke('accept_source_statement', {
          ...rotatedStatement,
          actionInvocationId: randomUUID(),
          sourceRevision: 2,
          sourceStatementId: 'rotation-2-unauthorized',
        }),
      ).toMatchObject({ changed: false, result: { reason: 'UNAUTHORIZED_SOURCE' } });
      expect(
        yield* admin.unsafe(
          `select count(*)::int as count
          from payment_term_catalog.payment_term_source_statements
          where integration_route=$1 and source_statement_id=$2`,
          [rotationRoute, 'rotation-2-unauthorized'],
        ),
      ).toEqual([{ count: 0 }]);
      expect(
        yield* invoke('accept_source_statement', acceptance({ sourceRevision: 0, sourceStatementId: 'delayed' })),
      ).toMatchObject({ result: { reason: 'STALE_REVISION' } });
      expect(yield* invoke('accept_source_statement', acceptance())).toEqual({
        canonicalCreated: false,
        changed: false,
        result: original.result,
      });
      expect(yield* invoke('get_source_statement', source)).toEqual(original.result);
      expect(
        yield* invoke('accept_source_statement', acceptance({ sourceRevision: 2, sourceStatementId: 'ambiguous' })),
      ).toMatchObject({ result: { reason: 'AMBIGUOUS_MAPPING' } });
      expect(
        yield* invoke(
          'accept_source_statement',
          acceptance({
            semantics: { evidence: 'Unknown source anchor', kind: 'UNSUPPORTED' },
            sourceRevision: 3,
            sourceStatementId: 'unsupported',
          }),
        ),
      ).toMatchObject({ result: { reason: 'UNSUPPORTED_SEMANTICS' } });
      expect(
        yield* invoke(
          'accept_source_statement',
          acceptance({ semantics: { ...semantics, days: 45 }, sourceRevision: 4, sourceStatementId: 'code-conflict' }),
        ),
      ).toMatchObject({ result: { reason: 'BUSINESS_CODE_CONFLICT' } });
      expect(
        yield* invoke(
          'accept_source_statement',
          acceptance({
            mapping: { kind: 'EXISTING', paymentTermId: oldRef.resourceId },
            semantics: { ...semantics, days: 45 },
            sourceRevision: 5,
            sourceStatementId: 'wrong-map',
          }),
        ),
      ).toMatchObject({ result: { reason: 'INCOMPATIBLE_REFERENCE' } });
      yield* runtime.unsafe('COMMIT');
      // Qualified source identities remain distinct even when external codes agree.
      // EBS B supplies proven equivalence explicitly; its code is never a mapping key.
      yield* inScope(runtime, tenant, legalEntity);
      const otherSystem = 'other-actual-erp';
      expect(
        Schema.is(Schema.TaggedStruct('configured', { authorityRevision: Schema.Literal(1) }))(
          yield* invoke('configure_source_authority', { ...configure(0), externalBusinessSystemId: otherSystem }),
        ),
      ).toBe(true);
      const equivalent = acceptance({
        externalBusinessSystemId: otherSystem,
        mapping: { kind: 'EXISTING', paymentTermId: oldRef.resourceId },
      });
      const equivalentRaw = yield* invoke('accept_source_statement', equivalent);
      const equivalentDefinition = yield* Schema.decodeUnknownEffect(acceptedDefinition)(equivalentRaw);
      expect(equivalentDefinition.result.definition.paymentTermRef).toEqual(oldRef);
      expect(yield* invoke('get_source_statement', equivalent)).not.toEqual(original.result);
      expect(yield* invoke('get_source_statement', source)).toEqual(original.result);
      const otherMeaning = yield* invoke(
        'accept_source_statement',
        acceptance({
          externalBusinessSystemId: otherSystem,
          mapping: {
            ...source.mapping,
            activeFrom: source.businessObservedAt,
            code: 'OTHER_NET45',
            description: 'Forty-five calendar days',
            kind: 'CREATE',
            name: 'Net 45',
          },
          semantics: { ...semantics, days: 45 },
          sourceRevision: 2,
          sourceStatementId: 'statement-2',
        }),
      );
      const differentDefinition = yield* Schema.decodeUnknownEffect(acceptedDefinition)(otherMeaning);
      expect(differentDefinition.result.definition.paymentTermRef).not.toEqual(oldRef);
      expect(differentDefinition.result.definition.paymentTermRef).not.toEqual(
        replacementDefinition.result.definition.paymentTermRef,
      );
      yield* runtime.unsafe('COMMIT');
      expect(
        yield* admin.unsafe<{ readonly code: string; readonly system: string; readonly term: string }>(
          "select external_business_system_id as system,source_code as code,result->'definition'->'paymentTermRef'->>'resourceId' as term from payment_term_catalog.payment_term_source_statements where source_statement_id=$1 and outcome=$2 order by external_business_system_id",
          ['statement-1', 'ACCEPTED'],
        ),
      ).toEqual([
        { code: 'F14', system: source.externalBusinessSystemId, term: oldRef.resourceId },
        { code: 'F14', system: otherSystem, term: oldRef.resourceId },
      ]);

      // A concurrent exact CREATE retry must wait, then recover the first result.
      const createRetry = acceptance({
        mapping: {
          activeFrom: source.businessObservedAt,
          code: 'ERP_NET60',
          description: 'Sixty days',
          kind: 'CREATE',
          name: 'Net 60',
        },
        semantics: { ...semantics, days: 60 },
        sourceRecordId: 'record-60',
        sourceStatementId: 'create-retry',
      });
      yield* inScope(runtime, tenant, legalEntity);
      yield* inScope(competitor, tenant, legalEntity);
      const createdOnceRaw = yield* invoke('accept_source_statement', createRetry);
      const createdOnce = yield* Schema.decodeUnknownEffect(decision)(createdOnceRaw);
      const createdOnceDefinition = yield* Schema.decodeUnknownEffect(acceptedDefinition)(createdOnceRaw);
      expect(createdOnce.canonicalCreated).toBe(true);
      const waitingCreate = yield* Effect.forkChild(
        call(competitor, tenant, legalEntity, 'accept_source_statement', {
          ...createRetry,
          actionInvocationId: randomUUID(),
        }),
      );
      yield* waitForCompetingRoutineLock(admin, competitorPid.pid, runtimePid.pid);
      yield* runtime.unsafe('COMMIT');
      expect(yield* Fiber.join(waitingCreate)).toEqual({
        canonicalCreated: false,
        changed: false,
        result: createdOnce.result,
      });
      yield* competitor.unsafe('COMMIT');
      expect(
        yield* admin.unsafe(
          'select count(*)::int as count from payment_term_catalog.payment_terms where payment_term_id=$1',
          [createdOnceDefinition.result.definition.paymentTermRef.resourceId],
        ),
      ).toEqual([{ count: 1 }]);
      expect(
        yield* admin.unsafe(
          'select count(*)::int as count from payment_term_catalog.payment_term_revisions where payment_term_id=$1',
          [createdOnceDefinition.result.definition.paymentTermRef.resourceId],
        ),
      ).toEqual([{ count: 1 }]);
      expect(
        yield* admin.unsafe(
          'select count(*)::int as count from payment_term_catalog.payment_term_source_statements where source_statement_id=$1',
          ['create-retry'],
        ),
      ).toEqual([{ count: 1 }]);

      yield* inScope(runtime, tenant, legalEntity);
      const rolledBack = acceptance({
        mapping: { kind: 'EXISTING', paymentTermId: oldRef.resourceId },
        sourceRevision: 3,
        sourceStatementId: 'rollback',
      });
      expect(yield* invoke('accept_source_statement', rolledBack)).toMatchObject({ changed: true });
      yield* runtime.unsafe('ROLLBACK');
      yield* inScope(runtime, tenant, legalEntity);
      expect(yield* invoke('get_source_statement', rolledBack)).toBeNull();
      yield* runtime.unsafe('COMMIT');
      const concurrent = acceptance({
        mapping: { kind: 'EXISTING', paymentTermId: oldRef.resourceId },
        sourceRevision: 3,
        sourceStatementId: 'concurrent',
      });
      yield* inScope(runtime, tenant, legalEntity);
      yield* inScope(competitor, tenant, legalEntity);
      const first = yield* Schema.decodeUnknownEffect(decision)(yield* invoke('accept_source_statement', concurrent));
      const pending = yield* Effect.forkChild(
        call(competitor, tenant, legalEntity, 'accept_source_statement', {
          ...concurrent,
          actionInvocationId: randomUUID(),
        }),
      );
      yield* waitForCompetingRoutineLock(admin, competitorPid.pid, runtimePid.pid);
      yield* runtime.unsafe('COMMIT');
      expect(yield* Fiber.join(pending)).toEqual({ canonicalCreated: false, changed: false, result: first.result });
      yield* competitor.unsafe('COMMIT');
      // Governed persisted lifecycle/history evidence uses a legitimate owner-local
      // equivalent duplicate fixture, representing retained catalog history.
      const aliasId = randomUUID();
      yield* inScope(admin, tenant, legalEntity);
      yield* admin.unsafe(
        `insert into payment_term_catalog.payment_terms
        select (jsonb_populate_record(null::payment_term_catalog.payment_terms,
          to_jsonb(t) || jsonb_build_object('payment_term_id',$1::text,'business_code','RETAINED_ALIAS14',
            'created_by_action_invocation_id',$2::text))).*
        from payment_term_catalog.payment_terms t where payment_term_id=$3`,
        [aliasId, randomUUID(), oldRef.resourceId],
      );
      yield* admin.unsafe(
        `insert into payment_term_catalog.payment_term_revisions
        select (jsonb_populate_record(null::payment_term_catalog.payment_term_revisions,
          to_jsonb(r) || jsonb_build_object('payment_term_id',$1::text,
            'payment_term_revision_id',$2::text,'semantic_revision_id',$3::text,'action_invocation_id',$4::text))).*
        from payment_term_catalog.payment_term_revisions r where payment_term_id=$5 and revision_number=1`,
        [aliasId, randomUUID(), randomUUID(), randomUUID(), oldRef.resourceId],
      );
      yield* admin.unsafe('COMMIT');
      const mutation = {
        actingPrincipalId: principal,
        actionInvocationId: randomUUID(),
        expectedMetadataRevision: 1,
        paymentTermId: oldRef.resourceId,
        reason: 'Owner acceptance history',
      };
      yield* inScope(runtime, tenant, legalEntity);
      const correctedRows = yield* runtime.unsafe<{ readonly payload: unknown }>(
        'select payload from payment_term_catalog.correct_term($1,$2,$3)',
        [
          tenant,
          legalEntity,
          JSON.stringify({ ...mutation, displayName: 'Clarified fourteen days', explanation: 'Cosmetic wording only' }),
        ],
      );
      const corrected = yield* Schema.decodeUnknownEffect(Schema.Struct({ definition: PaymentTermDefinitionSchema }))(
        correctedRows[0]?.payload,
      );
      expect(corrected.definition.paymentTermRef).toEqual(oldRef);
      expect(corrected.definition.semanticRevisionId).toBe(accepted.result.definition.semanticRevisionId);
      expect(corrected.definition.semanticFingerprint).toBe(accepted.result.definition.semanticFingerprint);
      expect(corrected.definition.metadataRevision).toBe(2);
      const staleCorrection = yield* runtime.unsafe<{ readonly payload: unknown }>(
        'select payload from payment_term_catalog.correct_term($1,$2,$3)',
        [
          tenant,
          legalEntity,
          JSON.stringify({
            ...mutation,
            actionInvocationId: randomUUID(),
            displayName: 'Stale correction',
            explanation: 'Must not persist',
          }),
        ],
      );
      expect(
        Schema.is(Schema.TaggedStruct('revision_conflict', { actualMetadataRevision: Schema.Literal(2) }))(
          staleCorrection[0]?.payload,
        ),
      ).toBe(true);
      yield* inScope(admin, tenant, legalEntity);
      expect(
        yield* Effect.isFailure(
          admin.unsafe(
            `insert into payment_term_catalog.payment_term_revisions
            select (jsonb_populate_record(null::payment_term_catalog.payment_term_revisions,
              to_jsonb(revision) || jsonb_build_object(
                'payment_term_revision_id',$1::text,
                'revision_number',99,
                'net_days',15,
                'action_invocation_id',$2::text
              ))).* from payment_term_catalog.payment_term_revisions revision
            where revision.payment_term_id=$3 and revision.revision_number=1`,
            [randomUUID(), randomUUID(), oldRef.resourceId],
          ),
        ),
      ).toBe(true);
      yield* admin.unsafe('ROLLBACK');
      const staleRetirement = yield* runtime.unsafe<{ readonly payload: unknown }>(
        'select payload from payment_term_catalog.retire_term($1,$2,$3)',
        [
          tenant,
          legalEntity,
          JSON.stringify({ ...mutation, actionInvocationId: randomUUID(), effectiveAt: '2026-11-01T00:00:00.000Z' }),
        ],
      );
      expect(
        Schema.is(Schema.TaggedStruct('revision_conflict', { actualMetadataRevision: Schema.Literal(2) }))(
          staleRetirement[0]?.payload,
        ),
      ).toBe(true);
      const reconciled = yield* runtime.unsafe<{ readonly payload: unknown }>(
        'select payload from payment_term_catalog.reconcile_term($1,$2,$3)',
        [
          tenant,
          legalEntity,
          JSON.stringify({
            ...mutation,
            actionInvocationId: randomUUID(),
            aliasPaymentTermId: aliasId,
            canonicalPaymentTermId: oldRef.resourceId,
            expectedAliasMetadataRevision: 1,
            expectedCanonicalMetadataRevision: 2,
          }),
        ],
      );
      expect(Schema.is(Schema.TaggedStruct('reconciled', {}))(reconciled[0]?.payload)).toBe(true);
      const scheduled = yield* runtime.unsafe<{ readonly payload: unknown }>(
        'select payload from payment_term_catalog.retire_term($1,$2,$3)',
        [
          tenant,
          legalEntity,
          JSON.stringify({
            ...mutation,
            actionInvocationId: randomUUID(),
            effectiveAt: '2026-11-01T00:00:00.000Z',
            expectedMetadataRevision: 2,
          }),
        ],
      );
      expect(
        Schema.is(Schema.TaggedStruct('retired', { definition: PaymentTermDefinitionSchema }))(scheduled[0]?.payload),
      ).toBe(true);
      for (const [at, expectedTag] of [
        ['2026-09-30T23:59:59.999Z', 'not_yet_active'],
        ['2026-10-01T00:00:00.000Z', 'resolved'],
        ['2026-10-31T23:59:59.999Z', 'resolved'],
        ['2026-11-01T00:00:00.000Z', 'retired'],
      ]) {
        const resolution = yield* runtime.unsafe<{ readonly payload: unknown }>(
          'select payload from payment_term_catalog.resolve_reference($1,$2,$3,$4,null)',
          [tenant, legalEntity, aliasId, at],
        );
        expect(Schema.is(Schema.Struct({ _tag: Schema.Literal(expectedTag) }))(resolution[0]?.payload)).toBe(true);
      }
      const history = yield* runtime.unsafe<{ readonly payload: unknown }>(
        'select payload from payment_term_catalog.get_history($1,$2,$3)',
        [tenant, legalEntity, oldRef.resourceId],
      );
      expect(history[0]?.payload).toMatchObject({
        lifecycle: [
          { effectiveAt: '2026-10-01T00:00:00.000Z', eventKind: 'ACTIVATED' },
          { effectiveAt: '2026-11-01T00:00:00.000Z', eventKind: 'RETIRED' },
        ],
        revisions: [
          {
            definitionRevisionId: accepted.result.definition.definitionRevisionId,
            lifecycle: { effectiveTo: null, state: 'ACTIVE' },
            retired: null,
            semantics,
          },
          {
            definitionRevisionId: corrected.definition.definitionRevisionId,
            lifecycle: { effectiveTo: null, state: 'ACTIVE' },
            retired: null,
            semantics,
          },
        ],
      });
      expect(yield* invoke('get_source_statement', source)).toEqual(original.result);
      yield* runtime.unsafe('COMMIT');
      expect(
        yield* admin.unsafe(
          'select count(*)::int as count from payment_term_catalog.payment_term_revisions where payment_term_id=$1',
          [oldRef.resourceId],
        ),
      ).toEqual([{ count: 2 }]);

      // Valid independent tenant and LE catalogs can reuse all source/business keys.
      // Governed reads cannot observe the sibling scope or use its reference.
      for (const [siblingTenant, siblingEntity] of [
        [randomUUID(), legalEntity],
        [tenant, randomUUID()],
      ]) {
        yield* inScope(runtime, siblingTenant, siblingEntity);
        expect(yield* call(runtime, siblingTenant, siblingEntity, 'get_source_statement', source)).toBeNull();
        expect(
          yield* call(runtime, siblingTenant, siblingEntity, 'accept_source_statement', acceptance()),
        ).toMatchObject({ changed: false, result: { reason: 'UNAUTHORIZED_SOURCE' } });
        expect(
          Schema.is(Schema.TaggedStruct('configured', { authorityRevision: Schema.Literal(1) }))(
            yield* call(runtime, siblingTenant, siblingEntity, 'configure_source_authority', configure(0)),
          ),
        ).toBe(true);
        const siblingRaw = yield* call(runtime, siblingTenant, siblingEntity, 'accept_source_statement', acceptance());
        const sibling = yield* Schema.decodeUnknownEffect(acceptedDefinition)(siblingRaw);
        expect(sibling.result.definition.paymentTermRef.resourceId).not.toBe(oldRef.resourceId);
        expect(sibling.result.definition.paymentTermRef.tenantId).toBe(siblingTenant);
        yield* runtime.unsafe('COMMIT');
        yield* inScope(runtime, tenant, legalEntity);
        expect(yield* invoke('get_source_statement', source)).toEqual(original.result);
        const crossScope = yield* runtime.unsafe<{ readonly payload: unknown }>(
          'select payload from payment_term_catalog.get_current($1,$2,$3)',
          [tenant, legalEntity, sibling.result.definition.paymentTermRef.resourceId],
        );
        expect(crossScope[0]?.payload).toBeNull();
        yield* runtime.unsafe('COMMIT');
      }

      expect(yield* Effect.isFailure(invoke('get_source_statement', source))).toBe(true);
      expect(
        yield* Effect.isFailure(runtime.unsafe('select * from payment_term_catalog.payment_term_source_statements')),
      ).toBe(true);
      expect(
        yield* Effect.isFailure(
          admin.unsafe("update payment_term_catalog.payment_term_source_statements set source_code='rewritten'"),
        ),
      ).toBe(true);
      yield* inScope(runtime, tenant, legalEntity);
      yield* runtime.unsafe("select set_config('ontos.legal_entity_id',$1,true)", [randomUUID()]);
      expect(yield* Effect.isFailure(invoke('get_source_statement', source))).toBe(true);
      yield* runtime.unsafe('ROLLBACK');
    }),
  );

it.live(
  'migrates fresh source decisions twice with scope, replay, concurrency and rollback safeguards',
  () => proveDatabase(false),
  90_000,
);
it.live(
  'migrates populated exact v1 history twice without remapping retained meaning',
  () => proveDatabase(true),
  90_000,
);
