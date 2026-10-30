import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, Option, Redacted, Result, Schema, Stream } from 'effect';
import type { Scope } from 'effect';
import { ChildProcess } from 'effect/process';
import type { ChildProcessSpawner } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

const tenant = '11111111-1111-4111-8111-111111111111';
const legalEntity = '22222222-2222-4222-8222-222222222222';
const buyer = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const hash = 'a'.repeat(64);
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.order',
  resourceId,
  resourceType,
  tenantId: tenant,
});
const binding = {
  attemptRef: ref('commerce.order.commitment-attempt', 'attempt'),
  bundleHash: hash,
  bundleRef: ref('commerce.order.acceptance-bundle', 'bundle'),
  bundleVersion: 'order-acceptance-bundle.v1',
};
const requestRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'request',
  resourceType: 'commerce.customer-context.purchase-approval-request',
  tenantId: tenant,
};
const candidateRef = {
  moduleId: 'commerce.cart',
  resourceId: 'candidate',
  resourceType: 'commerce.cart.final-cart-candidate',
  tenantId: tenant,
};
const revalidationRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'proof',
  resourceType: 'commerce.customer-context.approval-revalidation',
  tenantId: tenant,
};
const approvalEvidence = { proof: { evidence: { finalBindingEvidence: { binding } }, revalidationRef } };
// The Bundle's retained Quotation interval; the owner's expiry must repeat it exactly.
const retainedValidity = {
  policyEvidence: { maximumValidityDurationMilliseconds: 3_600_000, policyRef: 'policy', policyVersion: '1' },
  validFrom: '2026-10-21T16:00:30.000Z',
  validUntil: '2026-10-21T17:00:30.000Z',
};

class OrderNativeSetupFailed extends Schema.TaggedError<OrderNativeSetupFailed>()('OrderNativeSetupFailed', {
  reason: Schema.String,
}) {}

const inScope = <A, E, R>(
  client: PgClient.PgClient,
  operation: Effect.Effect<A, E, R>,
  selectedTenant = tenant,
  selectedLegalEntity = legalEntity,
) =>
  Effect.gen(function* scopedOrderOperation() {
    yield* client.unsafe("select set_config('ontos.tenant_id',$1,true),set_config('ontos.legal_entity_id',$2,true)", [
      selectedTenant,
      selectedLegalEntity,
    ]);
    return yield* operation;
  }).pipe(client.withTransaction);

const expectSqlFailure = <A, E, R>(operation: Effect.Effect<A, E, R>, code: string) =>
  Effect.gen(function* assertNativeRejection() {
    const result = yield* operation.pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      const metadata = findPostgresFailure(result.failure);
      expect(Option.isSome(metadata)).toBe(true);
      if (Option.isSome(metadata)) {
        expect(metadata.value.code).toBe(code);
      }
    }
  });

const fixture = Effect.fn('OrderFinalizationNativeTests.fixture')(function* fixture() {
  const sourceConnections = yield* loadDatabaseConnectionPair();
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1257-approval-fresh-proof',
    sourceConnections,
  });
  const migrate = Effect.gen(function* migrateActualOrderHistory() {
    const child = yield* ChildProcess.make(
      'mise',
      ['exec', '--', 'pnpm', '--filter', '@app/commerce-order', 'db:migrate'],
      {
        cwd: new URL('../../../../', import.meta.url).pathname,
        env: {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          DATABASE_URL: isolated.connections.runtime.connectionString,
        },
        extendEnv: true,
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [code, , stderr] = yield* Effect.all(
      [child.exitCode, Stream.runDrain(child.stdout), child.stderr.pipe(Stream.decodeText(), Stream.mkString)],
      { concurrency: 3 },
    );
    if (code !== 0) {
      return yield* new OrderNativeSetupFailed({ reason: `Order migration failed: ${stderr.slice(0, 1500)}` });
    }
    return yield* Effect.void;
  });
  yield* migrate;
  const admin = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.admin.connectionString) });
  const runtime = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.runtime.connectionString) });
  // Minimal owner-local JSON projections isolate native guards. They do not claim
  // foreign proof issuance; the separate public journey must obtain genuine facts.
  const snapshot = {
    approvalRequestRef: requestRef,
    finalization: {
      cart: { candidateHash: hash, candidateRef },
      pricing: { quotation: { quotationRef: 'quotation', validity: retainedValidity } },
    },
  };
  yield* admin.unsafe(
    'insert into commerce_order.acceptance_bundles(tenant_id,legal_entity_id,bundle_id,buyer_principal_id,approval_request_id,bundle_hash,snapshot) values($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [tenant, legalEntity, 'bundle', buyer, 'request', hash, JSON.stringify(snapshot)],
  );
  yield* admin.unsafe(
    "insert into commerce_order.commitment_attempts(tenant_id,legal_entity_id,attempt_id,bundle_id,bundle_hash,buyer_principal_id,commitment_correlation_id,created_at,updated_at,revision,status) values($1,$2,'attempt','bundle',$3,$4,'correlation',now(),now(),1,'READY')",
    [tenant, legalEntity, hash, buyer],
  );
  const insert = (
    stage: 'PREPARE' | 'PROOF',
    id = 'intent',
    selectedLegalEntity = legalEntity,
    businessKey = 'original-key',
    commitmentCorrelationId = 'fresh-correlation',
  ) => {
    const original = {
      binding,
      expectedRevision: 1,
      idempotencyKey: 'original-key',
      work: { buyerPrincipalId: buyer, correlationId: 'correlation', legalEntityId: legalEntity, tenantId: tenant },
    };
    // Preparation retains its original input; only the guarded selectors are projected.
    const data =
      stage === 'PREPARE' ? { ...original, input: { commitmentCorrelationId, quotationRef: 'quotation' } } : original;
    return admin.unsafe(
      "insert into commerce_order.finalization_intents(tenant_id,legal_entity_id,intent_id,buyer_principal_id,stage,business_key,input_hash,attempt_id,data,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'PENDING')",
      [
        tenant,
        selectedLegalEntity,
        id,
        buyer,
        stage,
        businessKey,
        hash,
        stage === 'PROOF' ? 'attempt' : null,
        JSON.stringify(data),
      ],
    );
  };
  const complete = (
    result: Schema.Json,
    status: 'COMPLETE' | 'FAILED' = 'COMPLETE',
    proofRef: string | null = null,
    id = 'intent',
  ) =>
    inScope(
      runtime,
      runtime.unsafe(
        'update commerce_order.finalization_intents set status=$1,result=$2::jsonb,proof_ref=$3 where intent_id=$4',
        [status, JSON.stringify(result), proofRef, id],
      ),
    );
  const read = (id = 'intent') =>
    admin.unsafe<{ readonly proof_ref: string | null; readonly result: unknown; readonly status: string }>(
      'select status,result,proof_ref from commerce_order.finalization_intents where intent_id=$1',
      [id],
    );
  const noOrder = Effect.gen(function* assertNoImplicitOrder() {
    const [row] = yield* admin.unsafe<{ readonly count: number }>(
      'select count(*)::integer as count from commerce_order.committed_orders',
    );
    expect(row?.count).toBe(0);
  });
  return { admin, complete, insert, migrate, noOrder, read, runtime };
});

type NativeFixture = Effect.Success<ReturnType<typeof fixture>>;
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
);
const nativeTest = (
  name: string,
  body: (test: NativeFixture) => Effect.Effect<void, unknown, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
) => it.live(name, () => fixture().pipe(Effect.flatMap(body), Effect.scoped, Effect.provide(services)));

nativeTest(
  'migrates the actual nine-file history twice without replaying migrations and installs scoped column authority',
  (test) =>
    Effect.gen(function* migrationAuthority() {
      yield* test.migrate;
      const [journal] = yield* test.admin.unsafe<{ readonly count: number }>(
        'select count(*)::integer as count from drizzle.__drizzle_migrations_commerce_order',
      );
      expect(journal?.count).toBe(9);
      const [grants] = yield* test.admin.unsafe<{
        readonly can_delete: boolean;
        readonly can_truncate: boolean;
        readonly data_update: boolean;
        readonly forced: boolean;
        readonly status_update: boolean;
        readonly table_update: boolean;
      }>(
        "select relrowsecurity and relforcerowsecurity as forced,has_table_privilege('ontos_runtime',oid,'UPDATE') as table_update,has_column_privilege('ontos_runtime',oid,'status','UPDATE') as status_update,has_column_privilege('ontos_runtime',oid,'data','UPDATE') as data_update,has_table_privilege('ontos_runtime',oid,'DELETE') as can_delete,has_table_privilege('ontos_runtime',oid,'TRUNCATE') as can_truncate from pg_class where oid='commerce_order.finalization_intents'::regclass",
      );
      expect(grants).toEqual({
        can_delete: false,
        can_truncate: false,
        data_update: false,
        forced: true,
        status_update: true,
        table_update: false,
      });
    }),
);

nativeTest('denies absent and wrong tenant/legal-entity context and retains composite owner links', (test) =>
  Effect.gen(function* scopeIsolation() {
    yield* test.insert('PREPARE');
    for (const operation of [
      test.runtime.unsafe('select intent_id from commerce_order.finalization_intents'),
      inScope(test.runtime, test.runtime.unsafe('select intent_id from commerce_order.finalization_intents'), other),
      inScope(
        test.runtime,
        test.runtime.unsafe('select intent_id from commerce_order.finalization_intents'),
        tenant,
        other,
      ),
    ]) {
      expect(yield* operation).toEqual([]);
    }
    expect(
      yield* inScope(test.runtime, test.runtime.unsafe('select intent_id from commerce_order.finalization_intents')),
    ).toHaveLength(1);
    yield* expectSqlFailure(test.insert('PROOF', 'other-intent', other), '23503');
  }),
);

nativeTest(
  'preserves original input identity and rejects delete, truncate, and duplicate original business intent',
  (test) =>
    Effect.gen(function* immutablePendingIntent() {
      yield* test.insert('PREPARE');
      yield* expectSqlFailure(
        inScope(
          test.runtime,
          test.runtime.unsafe("update commerce_order.finalization_intents set business_key='changed'"),
        ),
        '42501',
      );
      yield* expectSqlFailure(
        test.admin.unsafe("update commerce_order.finalization_intents set data='{}'::jsonb"),
        '23514',
      );
      yield* expectSqlFailure(test.admin.unsafe('delete from commerce_order.finalization_intents'), '23514');
      yield* expectSqlFailure(test.admin.unsafe('truncate commerce_order.finalization_intents'), '23514');
      yield* expectSqlFailure(test.insert('PREPARE', 'replacement-intent'), '23505');
      expect((yield* test.read())[0]?.status).toBe('PENDING');
      yield* test.noOrder;
    }),
);

nativeTest('single-assigns preparation to its exact buyer/Bundle/Attempt and never creates an Order', (test) =>
  Effect.gen(function* immutablePreparationCompletion() {
    yield* test.insert('PREPARE');
    const result = { binding, intentRef: ref('commerce.order.finalization-intent', 'intent'), status: 'PREPARED' };
    yield* expectSqlFailure(test.complete({ ...result, binding: { ...binding, bundleHash: 'b'.repeat(64) } }), '23514');
    yield* test.complete(result);
    expect((yield* test.read())[0]).toEqual({ proof_ref: null, result, status: 'COMPLETE' });
    yield* expectSqlFailure(test.complete(result), '23514');
    yield* test.noOrder;
  }),
);

nativeTest('retains only the exact original proof selector and refuses stale Attempt revisions', (test) =>
  Effect.gen(function* exactProofCompletion() {
    yield* test.insert('PROOF');
    yield* expectSqlFailure(test.complete({ approvalEvidence, pricingProof: {} }, 'COMPLETE', 'wrong-proof'), '23514');
    yield* test.complete({ approvalEvidence, pricingProof: {} }, 'COMPLETE', 'proof');
    expect((yield* test.read())[0]?.proof_ref).toBe('proof');
    yield* test.noOrder;
  }),
);

nativeTest('requires an exact CCC terminal witness before closing unknown proof work as failed', (test) =>
  Effect.gen(function* terminalApprovalEvidence() {
    yield* test.insert('PROOF');
    const witness = {
      candidateHash: hash,
      candidateRef,
      commitmentCorrelationId: 'correlation',
      finalBinding: binding,
      idempotencyKey: 'original-key',
      requestRef,
      terminalStatus: 'CANCELLED',
    };
    yield* expectSqlFailure(test.complete({ kind: 'TIMEOUT' }, 'FAILED'), '23514');
    yield* expectSqlFailure(
      test.complete(
        { kind: 'APPROVAL_REQUEST_TERMINAL', witness: { ...witness, idempotencyKey: 'new-key' } },
        'FAILED',
      ),
      '23514',
    );
    yield* expectSqlFailure(
      test.complete(
        { kind: 'APPROVAL_REQUEST_TERMINAL', witness: { ...witness, candidateHash: 'b'.repeat(64) } },
        'FAILED',
      ),
      '23514',
    );
    yield* test.complete({ kind: 'APPROVAL_REQUEST_TERMINAL', witness }, 'FAILED');
    expect((yield* test.read())[0]?.status).toBe('FAILED');
    yield* expectSqlFailure(test.complete({ approvalEvidence }, 'COMPLETE', 'proof'), '23514');
    yield* test.noOrder;
  }),
);

nativeTest('binds authenticated Pricing expiry projection to the original proof, Quotation and Bundle', (test) =>
  Effect.gen(function* terminalPricingEvidence() {
    yield* test.insert('PROOF');
    const result = {
      approvalEvidence,
      confirmationRef: 'confirmation',
      kind: 'PRICING_PROOF_EXPIRED',
      pricing: {
        _tag: 'EXPIRED',
        confirmationRef: 'confirmation',
        evaluatedAt: '2026-10-21T17:00:31Z',
        expiresAt: '2026-10-21T17:00:30Z',
      },
      quotationRef: 'quotation',
      requestedBinding: {
        attemptRef: 'attempt',
        decisionBundleHash: hash,
        decisionBundleRef: 'bundle',
        decisionBundleVersion: binding.bundleVersion,
      },
      revalidationRef,
    };
    yield* expectSqlFailure(test.complete({ ...result, quotationRef: 'other-quotation' }, 'FAILED'), '23514');
    yield* expectSqlFailure(test.complete({ ...result, confirmationRef: 'other-confirmation' }, 'FAILED'), '23514');
    yield* test.complete(result, 'FAILED');
    expect((yield* test.read())[0]?.status).toBe('FAILED');
    yield* test.noOrder;
  }),
);

// Pricing's authenticated expiry of the retained Quotation, already in the past.
const preparationExpiry = (quotationRef = 'quotation', validUntil = '2026-10-21T17:00:30.000Z') => ({
  authenticityEvidence: { quotationRef, verifiedAt: '2026-10-21T17:00:31.000Z' },
  kind: 'PREPARATION_QUOTATION_EXPIRED',
  pricing: {
    _tag: 'EXPIRED',
    evaluatedAt: '2026-10-21T17:00:31.000Z',
    quotationRef,
    validity: { validFrom: '2026-10-21T16:00:30.000Z', validUntil },
  },
  quotationRef,
});

nativeTest('settles expired preparation as failed only with its exact retained Quotation and no Order', (test) =>
  Effect.gen(function* terminalPreparationExpiry() {
    yield* test.insert('PREPARE');
    const expiry = preparationExpiry();
    yield* expectSqlFailure(test.complete(preparationExpiry('other-quotation'), 'FAILED'), '23514');
    yield* expectSqlFailure(
      test.complete({ ...expiry, pricing: { ...expiry.pricing, quotationRef: 'other-quotation' } }, 'FAILED'),
      '23514',
    );
    yield* expectSqlFailure(
      test.complete(
        {
          ...expiry,
          pricing: {
            ...expiry.pricing,
            validity: { ...expiry.pricing.validity, validUntil: '2999-01-01T00:00:00.000Z' },
          },
        },
        'FAILED',
      ),
      '23514',
    );
    yield* expectSqlFailure(test.complete({ ...expiry, kind: 'PRICING_PROOF_EXPIRED' }, 'FAILED'), '23514');
    yield* expectSqlFailure(test.complete({ kind: 'TIMEOUT' }, 'FAILED'), '23514');
    expect((yield* test.read())[0]?.status).toBe('PENDING');
    yield* test.complete(expiry, 'FAILED');
    expect((yield* test.read())[0]).toEqual({ proof_ref: null, result: expiry, status: 'FAILED' });
    yield* expectSqlFailure(
      test.complete({ binding, intentRef: ref('commerce.order.finalization-intent', 'intent'), status: 'PREPARED' }),
      '23514',
    );
    yield* test.noOrder;
  }),
);

nativeTest('refuses the preparation expiry witness for proof work and once preparation has an Attempt', (test) =>
  Effect.gen(function* misplacedPreparationExpiry() {
    yield* test.insert('PROOF');
    yield* expectSqlFailure(test.complete(preparationExpiry(), 'FAILED'), '23514');
    expect((yield* test.read())[0]?.status).toBe('PENDING');
    // The fixture Attempt already carries this buyer correlation, so its preparation cannot expire.
    yield* test.insert('PREPARE', 'prepared-intent', legalEntity, 'correlation', 'correlation');
    yield* expectSqlFailure(test.complete(preparationExpiry(), 'FAILED', null, 'prepared-intent'), '23514');
    expect((yield* test.read('prepared-intent'))[0]?.status).toBe('PENDING');
    yield* test.noOrder;
  }),
);

const proofQuotationExpiry = (quotationRef = 'quotation', validity: Schema.Json = retainedValidity) => ({
  authenticityEvidence: { quotationRef, verifiedAt: '2026-10-21T17:00:31.000Z' },
  kind: 'PRICING_QUOTATION_EXPIRED',
  pricing: { _tag: 'EXPIRED', evaluatedAt: '2026-10-21T17:00:31.000Z', quotationRef, validity },
  quotationRef,
});

nativeTest("settles proof work failed only with the expiry of its Bundle's exact retained Quotation", (test) =>
  Effect.gen(function* terminalProofQuotationExpiry() {
    yield* test.insert('PROOF');
    yield* expectSqlFailure(test.complete(proofQuotationExpiry('other-quotation'), 'FAILED'), '23514');
    yield* expectSqlFailure(
      test.complete(
        proofQuotationExpiry('quotation', { ...retainedValidity, validUntil: '2026-10-21T17:00:29.000Z' }),
        'FAILED',
      ),
      '23514',
    );
    yield* expectSqlFailure(
      test.complete(
        proofQuotationExpiry('quotation', { ...retainedValidity, validUntil: '2999-01-01T00:00:00.000Z' }),
        'FAILED',
      ),
      '23514',
    );
    yield* expectSqlFailure(
      test.complete({ ...proofQuotationExpiry(), kind: 'PREPARATION_QUOTATION_EXPIRED' }, 'FAILED'),
      '23514',
    );
    yield* expectSqlFailure(test.complete(proofQuotationExpiry(), 'FAILED', 'proof'), '23514');
    expect((yield* test.read())[0]?.status).toBe('PENDING');
    yield* test.complete(proofQuotationExpiry(), 'FAILED');
    expect((yield* test.read())[0]).toEqual({ proof_ref: null, result: proofQuotationExpiry(), status: 'FAILED' });
    yield* test.noOrder;
  }),
);

nativeTest('refuses the proof Quotation expiry witness for preparation work', (test) =>
  Effect.gen(function* misplacedProofExpiry() {
    yield* test.insert('PREPARE');
    yield* expectSqlFailure(test.complete(proofQuotationExpiry(), 'FAILED'), '23514');
    expect((yield* test.read())[0]?.status).toBe('PENDING');
    yield* test.noOrder;
  }),
);

nativeTest('rejects delayed completion after Attempt cancellation without reopening the Attempt', (test) =>
  Effect.gen(function* cancelledAttempt() {
    yield* test.insert('PROOF');
    yield* test.admin.unsafe(
      "update commerce_order.commitment_attempts set status='CANCELLED',revision=revision+1,updated_at=clock_timestamp() where attempt_id='attempt'",
    );
    yield* expectSqlFailure(test.complete({ approvalEvidence, pricingProof: {} }, 'COMPLETE', 'proof'), '23514');
    expect((yield* test.read())[0]?.status).toBe('PENDING');
    yield* test.noOrder;
  }),
);
