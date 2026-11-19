import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Cause, Context, Crypto, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { OwnerAuthorizationDecision } from '../../src/access/enforcement/owner-overlay.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair, loadDatabaseIdentityConnections } from '../../src/db/config.ts';
import { PARTY_REGISTRY_REQUEST_IDENTITY } from '../../src/db/database-identities.ts';
import { coreRelations, dataAccessEvents } from '../../src/db/schema.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import { ExecutionRuleViolation } from '../../src/execution/contract.ts';
import type { CallRecord, OwnerBinding, TransactionRequest } from '../../src/execution/contract.ts';
import { KernelTransactions } from '../../src/execution/kernel-transactions.ts';
import { KernelTransactionsLive } from '../../src/execution/transaction.ts';
import { findPostgresFailure } from '../../src/index.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { ReadEvidencePersistenceError } from '../../src/reads/read-evidence-persistence-error.ts';
import type { PersistReadEvidenceInput } from '../../src/reads/repository.ts';
import { ReadRunEvidence } from '../../src/reads/run-evidence.ts';
import { ReadRunEvidenceLive, callEvidenceRows } from '../../src/reads/run-evidence-live.ts';
import { TransactionAborted } from '../../src/sdk/index.ts';
import {
  addTestGatewayScopeGrantCleanup,
  registerTestGatewayScopeGrant,
} from '../../src/testing/gateway-scope-grant.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { installSearchTestAuthority } from '../support/search-authority.ts';

/** The revision `installSearchTestAuthority` makes active. */
const activeRevision = 'a'.repeat(64);
const staleRevision = 'b'.repeat(64);
const gatewayAudience = 'party-registry';

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

const kernelClients = Effect.gen(function* acquireKernelClients() {
  const shared = yield* loadDatabaseConnectionPair();
  const party = yield* loadDatabaseConnectionPair({ identity: PARTY_REGISTRY_REQUEST_IDENTITY });
  const identities = yield* loadDatabaseIdentityConnections();
  return {
    admin: yield* makeTestPgClient(shared.admin.connectionString),
    issuer: yield* makeTestPgClient(identities.runtime.shell_gateway_issuer.connectionString),
    party: yield* makeTestPgClient(party.runtime.connectionString),
    runtime: yield* makeTestPgClient(shared.runtime.connectionString),
  };
});

const databaseLayer = Effect.fn('ExecutionTransactionTest.databaseLayer')(function* databaseLayer(
  client: PgClient.PgClient,
) {
  return Layer.succeed(CoreDatabase, { executor: yield* makeTestDatabaseFromClient(client, coreRelations) });
});

/** `KernelTransactionsLive` over the given login. */
const kernelTransactionsFor = Effect.fn('ExecutionTransactionTest.kernelTransactions')(function* kernelTransactionsFor(
  client: PgClient.PgClient,
) {
  const layer = KernelTransactionsLive.pipe(Layer.provide(yield* databaseLayer(client)));
  return Context.get(yield* Layer.build(layer), KernelTransactions);
});

/** One tenant with a human principal and its session binding; removed with its evidence afterwards. */
const insertFixture = Effect.fn('ExecutionTransactionTest.insertFixture')(function* insertFixture(
  admin: PgClient.PgClient,
) {
  const tenantId = yield* nextUuid;
  const principalId = yield* nextUuid;
  const authBindingId = yield* nextUuid;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* cleanFixture() {
      yield* admin.unsafe('delete from core.data_access_events where tenant_id = $1', [tenantId]);
      yield* admin.unsafe('delete from core.principal_auth_bindings where tenant_id = $1', [tenantId]);
      yield* admin.unsafe('delete from core.principals where tenant_id = $1', [tenantId]);
      yield* admin.unsafe('delete from core.tenants where tenant_id = $1', [tenantId]);
    }).pipe(Effect.orDie),
  );
  yield* addTestGatewayScopeGrantCleanup(admin, [tenantId]);
  yield* admin.unsafe(
    `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Kernel tenant', 'active', 'en')`,
    [tenantId, `kernel-${tenantId}`],
  );
  yield* admin.unsafe(
    `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'human', 'Kernel principal', 'active')`,
    [principalId, tenantId],
  );
  yield* admin.unsafe(
    `insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, provider_subject_id, subject_type, status) values ($1, $2, $3, 'kernel.fixture', 'better_auth', $4, 'user', 'active')`,
    [authBindingId, tenantId, principalId, authBindingId],
  );
  const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId,
    authContextRef: `better-auth-session:${authBindingId}`,
    authMethod: 'session',
    principalId,
    tenantId,
  });
  const scope: OperationalScope = { ...principal, correlationId: `kernel-${tenantId}` };
  return { principalId, scope, tenantId };
});

/** A transaction opened as the read adapter opens every `{ run }` read transaction. */
const request = (
  scope: OperationalScope,
  options: { readonly admittedRevision?: string } = {},
): TransactionRequest => ({
  execution: {
    facts: { compositionRevision: options.admittedRevision },
    scope,
    transactionMode: 'session_default',
  },
  sequence: 1,
});

const markerRow = (scope: OperationalScope, marker: string) => ({
  accessKind: 'read',
  authBindingId: scope.authBindingId,
  authContextRef: scope.authContextRef,
  authMethod: scope.authMethod,
  evidenceCaptureMode: 'metadata_only',
  evidencePolicyKey: 'test.kernel.evidence.v1',
  outcome: 'allowed',
  outcomeCode: 'kernel_marker',
  outcomeStage: 'execution',
  principalId: scope.principalId,
  queryHash: marker,
  resultCount: 0,
  servingModuleKey: 'test.kernel',
  tenantId: scope.tenantId,
});

interface Services {
  readonly executor: ScopedTransactionExecutor;
}

const allow: OwnerBinding<Services, never>['decide'] = () => Effect.succeed('allowed');

/** An owner binding that counts how often its factory ran. */
const owner = (decide: OwnerBinding<Services, never>['decide'] = allow) => {
  const counts = { built: 0, closed: 0 };
  const binding: OwnerBinding<Services, never> = {
    build: (transaction) =>
      Effect.sync(() => {
        counts.built += 1;
        return { executor: transaction };
      }),
    decide,
    seal: (transaction) => ({
      close: () => {
        counts.closed += 1;
      },
      transaction,
    }),
  };
  return { binding, counts };
};

const postgresCode = (failure: EffectDrizzleQueryError | TransactionAborted) =>
  Option.getOrNull(Option.map(findPostgresFailure(failure), ({ code }) => code));

/** An owner rule that writes a marker row: it decides allowed, and the owner check rolls the row back. */
const writingDecide =
  (
    scope: OperationalScope,
    marker: string,
    observed: { code: string | null },
  ): OwnerBinding<Services, never>['decide'] =>
  (transaction) =>
    transaction
      .insert(dataAccessEvents)
      .values(markerRow(scope, marker))
      .pipe(
        Effect.as<OwnerAuthorizationDecision>('allowed'),
        Effect.tapError((failure) =>
          Effect.sync(() => {
            observed.code = postgresCode(failure);
          }),
        ),
        Effect.orElseSucceed((): OwnerAuthorizationDecision => 'unavailable'),
      );

const insertMarker = (scope: OperationalScope, marker: string) => (services: Services) =>
  services.executor.insert(dataAccessEvents).values(markerRow(scope, marker));

const abortedReason = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return null;
  }
  for (const reason of exit.cause.reasons) {
    if (Cause.isFailReason(reason) && Schema.is(TransactionAborted)(reason.error)) {
      return reason.error.reason;
    }
  }
  return null;
};

const violationRules = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons
        .filter(Cause.isDieReason)
        .map(({ defect }) => (Schema.is(ExecutionRuleViolation)(defect) ? defect.rule : null))
    : [];

const countEvidence = (admin: PgClient.PgClient, tenantId: string, marker?: string) =>
  admin
    .unsafe<{ readonly count: string }>(
      'select count(*)::text as count from core.data_access_events where tenant_id = $1 and ($2::text is null or query_hash = $2)',
      [tenantId, marker ?? null],
    )
    .pipe(Effect.map(([row]) => Number(row?.count ?? '-1')));

/** Holds the composition authority lock exclusively for 400 ms and answers when it let go. */
const holdCompositionAuthority = (admin: PgClient.PgClient, locked: Deferred.Deferred<null>) =>
  admin.withTransaction(
    Effect.gen(function* holdCompositionAuthorityLock() {
      yield* admin.unsafe(
        "select pg_advisory_xact_lock(hashtextextended('ontos.application-composition-authority', 0))",
      );
      yield* Deferred.succeed(locked, null);
      const [row] = yield* admin.unsafe<{ readonly released_at: Date }>(
        'select clock_timestamp() as released_at from pg_sleep(0.4)',
      );
      return row?.released_at ?? null;
    }),
  );

it.layer(NodeCrypto.layer, { excludeTestServices: true })('kernel transaction', (suite) => {
  suite.effect('opens as main opens a read: READ COMMITTED and not READ ONLY, so an owner rule may write or lock', () =>
    Effect.gen(function* readTransactionMode() {
      const { admin, runtime } = yield* kernelClients;
      const { scope, tenantId } = yield* insertFixture(admin);
      const transactions = yield* kernelTransactionsFor(runtime);

      const settings = yield* transactions.open(request(scope), owner().binding, () =>
        runtime.unsafe<{ readonly isolation: string; readonly read_only: string }>(
          "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only",
        ),
      );
      expect(settings).toEqual([{ isolation: 'read committed', read_only: 'off' }]);

      // An owner rule that writes (as one that locks rows with FOR UPDATE) is not refused: it decides,
      // and its row commits with the body's.
      const observed = { code: null };
      const writingOwner = owner(writingDecide(scope, 'owner-write', observed));
      yield* transactions.open(request(scope), writingOwner.binding, insertMarker(scope, 'body-write'));
      expect(observed.code).toBeNull();
      expect(writingOwner.counts.built).toBe(1);
      expect(yield* countEvidence(admin, tenantId, 'owner-write')).toBe(1);
      expect(yield* countEvidence(admin, tenantId, 'body-write')).toBe(1);
    }),
  );

  suite.effect('installs a gateway-grant scope in the read transaction', () =>
    Effect.gen(function* gatewayGrantScope() {
      const { admin, issuer, party } = yield* kernelClients;
      const { principalId, scope: sessionScope, tenantId } = yield* insertFixture(admin);
      const grant = yield* registerTestGatewayScopeGrant(issuer, { audience: gatewayAudience, principalId, tenantId });
      const scope = trustVerifiedGatewayPrincipalContext(sessionScope, activeRevision, {
        assertion: grant.assertion,
        audience: gatewayAudience,
      });
      const transactions = yield* kernelTransactionsFor(party);

      const installed = yield* transactions.open(request(scope), owner().binding, (services) =>
        Effect.succeed(services.executor.scope),
      );
      expect(installed).toEqual({ tenantId });
    }),
  );

  suite.effect('fences the admitted revision: a stale one is composition_changed before the factory', () =>
    Effect.gen(function* fence() {
      yield* installSearchTestAuthority();
      const { admin, runtime } = yield* kernelClients;
      const { scope } = yield* insertFixture(admin);
      const transactions = yield* kernelTransactionsFor(runtime);
      const stale = owner();
      const staleRequest = request(scope, { admittedRevision: staleRevision });
      const exit = yield* Effect.exit(transactions.open(staleRequest, stale.binding, () => Effect.void));
      expect(abortedReason(exit)).toBe('composition_changed');
      expect(stale.counts.built).toBe(0);
      expect(abortedReason(yield* Effect.exit(transactions.checkOwner(staleRequest, stale.binding)))).toBe(
        'composition_changed',
      );
      const fenced = yield* transactions.open(
        request(scope, { admittedRevision: activeRevision }),
        owner().binding,
        () => Effect.succeed('fenced'),
      );
      expect(fenced).toBe('fenced');
    }),
  );

  suite.effect('takes operationAt after a fence that waited', () =>
    Effect.gen(function* fenceWait() {
      yield* installSearchTestAuthority();
      const { admin, runtime } = yield* kernelClients;
      const { scope } = yield* insertFixture(admin);
      const transactions = yield* kernelTransactionsFor(runtime);
      const locked = yield* Deferred.make<null>();
      const holder = yield* Effect.forkChild(holdCompositionAuthority(admin, locked));
      yield* Deferred.await(locked);
      const facts = yield* transactions.open(
        request(scope, { admittedRevision: activeRevision }),
        owner().binding,
        (_services, transactionFacts) => Effect.succeed(transactionFacts),
      );
      const releasedAt = yield* Fiber.join(holder);
      expect(releasedAt).toBeInstanceOf(Date);
      expect(facts.operationAt.epochMilliseconds).toBeGreaterThanOrEqual(
        releasedAt?.getTime() ?? Number.POSITIVE_INFINITY,
      );
    }),
  );

  suite.effect('answers owner_denied and owner_unavailable before the factory runs', () =>
    Effect.gen(function* ownerRule() {
      const { admin, runtime } = yield* kernelClients;
      const { scope } = yield* insertFixture(admin);
      const transactions = yield* kernelTransactionsFor(runtime);
      const cases = [
        ['denied', 'owner_denied'],
        ['unavailable', 'owner_unavailable'],
      ] as const;
      for (const [decision, reason] of cases) {
        const decided = owner(() => Effect.succeed(decision));
        const exit = yield* Effect.exit(
          transactions.open(request(scope), decided.binding, () => Effect.succeed('ran')),
        );
        expect(abortedReason(exit)).toBe(reason);
        expect(decided.counts.built).toBe(0);
        expect(abortedReason(yield* Effect.exit(transactions.checkOwner(request(scope), decided.binding)))).toBe(
          reason,
        );
        // The seal is closed in every outcome.
        expect(decided.counts.closed).toBe(2);
      }
    }),
  );

  suite.effect('joins a statement in flight on a forked fiber before COMMIT', () =>
    Effect.gen(function* forkedStatement() {
      const { admin, runtime } = yield* kernelClients;
      const { scope } = yield* insertFixture(admin);
      const transactions = yield* kernelTransactionsFor(runtime);
      const xidStatement = 'select txid_current()::text as xid';
      const { forked, own } = yield* transactions.open(request(scope), owner().binding, () =>
        Effect.gen(function* forkAfterOwnStatement() {
          const [ownRow] = yield* runtime.unsafe<{ readonly xid: string }>(xidStatement);
          const fiber = yield* Effect.forkChild(
            runtime.unsafe<{ readonly xid: string }>(`${xidStatement} from pg_sleep(0.3)`),
          );
          return { forked: fiber, own: ownRow?.xid };
        }),
      );
      // The body returned while the statement ran; the transaction settled only after it answered, and
      // it ran inside the owner transaction (the same transaction id), not on a pooled connection after it.
      expect(own).toBeDefined();
      expect(yield* Fiber.await(forked)).toEqual(Exit.succeed([{ xid: own }]));
    }),
  );

  suite.effect('a handle used after the body dies transaction_ended', () =>
    Effect.gen(function* afterBody() {
      const { admin, runtime } = yield* kernelClients;
      const { scope } = yield* insertFixture(admin);
      const transactions = yield* kernelTransactionsFor(runtime);
      const leaked = yield* transactions.open(request(scope), owner().binding, (services) =>
        Effect.succeed(services.executor),
      );
      const exit = yield* Effect.exit(Effect.suspend(() => leaked.select().from(dataAccessEvents)));
      expect(violationRules(exit)).toEqual(['transaction_ended']);
    }),
  );

  suite.effect('a query prepared inside the body and evaluated after it dies transaction_ended', () =>
    Effect.gen(function* preparedAfterBody() {
      const { admin, runtime } = yield* kernelClients;
      const { scope } = yield* insertFixture(admin);
      const transactions = yield* kernelTransactionsFor(runtime);
      const { prepared } = yield* transactions.open(request(scope), owner().binding, (services) =>
        Effect.succeed({ prepared: services.executor.select().from(dataAccessEvents) }),
      );
      const exit = yield* Effect.exit(Effect.suspend(() => prepared));
      expect(violationRules(exit)).toEqual(['transaction_ended']);
    }),
  );

  suite.effect('the owner check rolls back while a transaction commits', () =>
    Effect.gen(function* checkOwnerRollsBack() {
      const { admin, runtime } = yield* kernelClients;
      const { scope, tenantId } = yield* insertFixture(admin);
      const transactions = yield* kernelTransactionsFor(runtime);
      const observed = { code: null };
      const writingOwner = owner(writingDecide(scope, 'check-owner', observed));
      yield* transactions.checkOwner(request(scope), writingOwner.binding);
      expect(observed.code).toBeNull();
      expect(yield* countEvidence(admin, tenantId, 'check-owner')).toBe(0);

      yield* transactions.open(request(scope), owner().binding, insertMarker(scope, 'committed'));
      expect(yield* countEvidence(admin, tenantId, 'committed')).toBe(1);
    }),
  );

  suite.effect('settles run evidence all rows or none, fenced to the admitted revision', () =>
    Effect.gen(function* settleEvidence() {
      yield* installSearchTestAuthority();
      const { admin, runtime } = yield* kernelClients;
      const { scope, tenantId } = yield* insertFixture(admin);
      const other = yield* insertFixture(admin);
      const evidenceLayer = ReadRunEvidenceLive.pipe(Layer.provide(yield* databaseLayer(runtime)));
      const evidence = Context.get(yield* Layer.build(evidenceLayer), ReadRunEvidence);
      const base = {
        accessKind: 'detail',
        captureMode: 'metadata_only',
        policyKey: 'test.kernel.evidence.v1',
        readKey: 'test.kernel.api.verify',
        scope,
        servingModuleKey: 'test.kernel',
      } as const;
      const call: CallRecord = {
        callerKind: 'person',
        durationMillis: 2,
        name: 'restrictions',
        outcome: 'Ok',
        placement: 'before',
        provider: { entrypointKey: 'test.provider.api.restrictions', moduleId: 'test.provider', schemaVersion: '1' },
        requirementKey: 'test.kernel.requirement.restrictions',
        route: 'Module',
        sequence: 1,
      };
      const readRow: PersistReadEvidenceInput = {
        ...base,
        outcome: 'allowed',
        outcomeCode: 'read_allowed',
        outcomeStage: 'evidence',
        resultCount: 1,
      };
      const rows = [readRow, ...callEvidenceRows([call], base)];

      // A row PostgreSQL refuses, written after two it accepted, fails the whole settle: its principal
      // belongs to another tenant, which the (tenant_id, principal_id) foreign key rejects. (A row of
      // another tenant is not refused: the runtime role's policy on core.data_access_events is open.)
      const mixed = yield* Effect.exit(
        evidence.settle({
          admittedRevision: activeRevision,
          rows: [...rows, { ...readRow, scope: { ...scope, principalId: other.scope.principalId } }],
          scope,
        }),
      );
      // The refusal is PostgreSQL's foreign-key violation on the third row, not an earlier fence or
      // scope failure that would have written nothing anyway.
      const mixedFailure = Exit.isFailure(mixed)
        ? Option.getOrUndefined(Cause.findErrorOption(mixed.cause))
        : undefined;
      expect(Schema.is(ReadEvidencePersistenceError)(mixedFailure)).toBe(true);
      expect(Option.map(findPostgresFailure(mixedFailure), ({ code }) => code)).toEqual(Option.some('23503'));
      expect(yield* countEvidence(admin, tenantId)).toBe(0);

      const stale = yield* Effect.exit(evidence.settle({ admittedRevision: staleRevision, rows, scope }));
      expect(abortedReason(stale)).toBe('composition_changed');
      expect(yield* countEvidence(admin, tenantId)).toBe(0);

      yield* evidence.settle({ admittedRevision: activeRevision, rows, scope });
      expect(yield* countEvidence(admin, tenantId)).toBe(2);
    }),
  );
});
