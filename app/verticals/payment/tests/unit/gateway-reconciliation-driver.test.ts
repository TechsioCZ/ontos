import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionUnavailableError,
  OntosModuleDeploymentContractSchema,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import {
  compositionFixtureContentDigest,
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
  sealApplicationCompositionFixture,
} from '@app/core-runtime/testing/module-contract';
import {
  Array as EffectArray,
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Match,
  Option,
  Order,
  Redacted,
  Ref,
  Schema,
} from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  PaymentReconciliationApiKeySchema,
  PaymentReconciliationConflictProblemSchema,
  PaymentReconciliationForbiddenProblemSchema,
  PaymentReconciliationIneligibleProblemSchema,
  PaymentReconciliationUnavailableProblemSchema,
} from '../../shared/payment-gateway-relay.ts';
import {
  GATEWAY_RECONCILIATION_REQUESTED,
  GATEWAY_RECONCILIATION_UNAVAILABLE,
  GatewayReconciliationInvoker,
  GatewayReconciliationInvokerLive,
  gatewayReconciliationIdempotencyKey,
  gatewayReconciliationPayload,
  gatewayReconciliationSkipped,
} from '../../src/integrations/psp/gateway-reconciliation-invoker.ts';
import type {
  GatewayReconciliationOutcome,
  GatewayReconciliationSkipReason,
} from '../../src/integrations/psp/gateway-reconciliation-invoker.ts';
import {
  PAYMENT_RECONCILIATION_CREDENTIALS_VARIABLE,
  ReconciliationCredentials,
  ReconciliationCredentialsLive,
} from '../../src/integrations/psp/reconciliation-credentials.ts';
import type { ReconciliationApiKey } from '../../src/integrations/psp/reconciliation-credentials.ts';
import {
  GatewayReconciliationDueRowSchema,
  GatewayReconciliationDueSource,
  GatewayReconciliationDueUnavailable,
} from '../../src/persistence/gateway-reconciliation-due.ts';
import type {
  GatewayReconciliationDueCursor,
  GatewayReconciliationDueRow,
  ListDueGatewayReconciliationInput,
} from '../../src/persistence/gateway-reconciliation-due.ts';
import {
  GATEWAY_RECONCILIATION_INTERVAL,
  makeGatewayReconciliationSweep,
  runGatewayReconciliationLoop,
} from '../../src/workers/gateway-reconciliation-driver.ts';
import type { GatewayReconciliationSweepResult } from '../../src/workers/gateway-reconciliation-driver.ts';

/*
 * #1158 / #1153 reconciliation driver (phase 2 D-P5) with in-memory ports under the TestClock: the cross-Tenant
 * due listing, the Tenant keys and the A10 invoker are fakes; the composition gate is the real one. Keys and
 * every identifier are obviously fake values.
 */

const DEPLOYMENT = { appId: 'payment', buildMarker: 'payment-driver-test-build' } as const;
const FAMILIES = ['GOPAY', 'STRIPE', 'COMGATE'] as const;

const uuid = (prefix: number, n: number) =>
  `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const decodeRow = Schema.decodeUnknownSync(GatewayReconciliationDueRowSchema);
const fakeKey = (tenant: number): ReconciliationApiKey =>
  Redacted.make(Schema.decodeUnknownSync(PaymentReconciliationApiKeySchema)(`fake-driver-key-${tenant}`));

interface RowSpec {
  readonly family?: (typeof FAMILIES)[number];
  readonly le: number;
  readonly op: number;
  readonly round?: number;
  readonly tenant: number;
}

const rowOf = ({ family = 'STRIPE', le, op, round = 0, tenant }: RowSpec): GatewayReconciliationDueRow =>
  decodeRow({
    legalEntityId: uuid(0x20 + le, tenant),
    operationId: uuid(0x30, op),
    paymentId: uuid(0x40, op),
    providerFamily: family,
    recommendedTrigger: 'EXECUTION_OUTCOME_UNKNOWN',
    round,
    routeKey: `route${String(op).padStart(38, '0')}`,
    tenantId: uuid(0x10, tenant),
  });

/** An approved composition whose `payment.core` module was built as `buildMarker`, sealed like a published one. */
const snapshotFor = Effect.fn('DriverTest.snapshot')(function* snapshotFor(buildMarker: string) {
  const fixture = yield* makeApplicationCompositionSnapshotFixture(['payment'], buildMarker);
  const contract = yield* Schema.decodeEffect(OntosModuleDeploymentContractSchema)(
    makeModuleContractFixture({ appId: 'payment', buildMarker, moduleId: 'payment.core' }),
  );
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    contract,
  );
  const sha256 = compositionFixtureContentDigest(contractDocument);
  const composition = sealApplicationCompositionFixture({
    ...fixture.composition,
    modules: fixture.composition.modules.map((module) => ({
      ...module,
      contract: { ...module.contract, sha256 },
      contractDocument,
      moduleId: 'payment.core',
      publicContract: { ...module.publicContract, id: 'payment.core', sha256 },
    })),
  });
  return { ...fixture, composition } satisfies ActiveApplicationCompositionSnapshot;
});

interface Harness {
  readonly calls: Ref.Ref<readonly (readonly [GatewayReconciliationDueRow, string, string])[]>;
  readonly listed: Ref.Ref<readonly ListDueGatewayReconciliationInput[]>;
  readonly purges: Ref.Ref<readonly number[]>;
}

interface HarnessOptions {
  readonly keys?: ReadonlySet<number>;
  readonly outcome?: (row: GatewayReconciliationDueRow) => Effect.Effect<GatewayReconciliationOutcome>;
  readonly rows: readonly GatewayReconciliationDueRow[];
  readonly snapshot?: Effect.Effect<ActiveApplicationCompositionSnapshot, unknown>;
}

const tenantNumber = (row: GatewayReconciliationDueRow) => Number.parseInt(row.tenantId.slice(-12), 16);
const keysetOf = (row: GatewayReconciliationDueCursor) => `${row.tenantId}/${row.legalEntityId}/${row.operationId}`;
const sortedStrings = (values: readonly string[]) => EffectArray.sort(values, Order.String);
const op = (n: number) => uuid(0x30, n);
const skip = (reason: GatewayReconciliationSkipReason) => gatewayReconciliationSkipped(reason);

/** One driver over fake ports; the listing pages `rows` exactly as the routine does. */
const makeHarness = Effect.fn('DriverTest.harness')(function* makeHarness(options: HarnessOptions) {
  const harness: Harness = {
    calls: yield* Ref.make<readonly (readonly [GatewayReconciliationDueRow, string, string])[]>([]),
    listed: yield* Ref.make<readonly ListDueGatewayReconciliationInput[]>([]),
    purges: yield* Ref.make<readonly number[]>([]),
  };
  const keys = options.keys ?? new Set(options.rows.map(tenantNumber));
  const sorted = EffectArray.sort(options.rows, Order.mapInput(Order.String, keysetOf));
  // Built on every load, so the snapshot is always valid at the TestClock's current time.
  const snapshot: Effect.Effect<ActiveApplicationCompositionSnapshot, unknown> =
    options.snapshot ?? snapshotFor(DEPLOYMENT.buildMarker);
  const layer = Layer.mergeAll(
    Layer.succeed(ActiveApplicationCompositionService, {
      load: snapshot.pipe(
        Effect.mapError(
          (cause) => new ActiveApplicationCompositionUnavailableError({ cause, reason: 'Fake authority' }),
        ),
      ),
    }),
    Layer.succeed(
      GatewayReconciliationDueSource,
      GatewayReconciliationDueSource.of({
        listDue: (input) =>
          Ref.update(harness.listed, (all) => [...all, input]).pipe(
            Effect.as(
              sorted
                .filter((row) =>
                  Option.match(input.after, { onNone: () => true, onSome: (after) => keysetOf(row) > keysetOf(after) }),
                )
                .slice(0, input.pageLimit),
            ),
          ),
        purgeExpiredPayerContacts: (hours) => Ref.update(harness.purges, (all) => [...all, hours]).pipe(Effect.as(2)),
      }),
    ),
    Layer.succeed(
      ReconciliationCredentials,
      ReconciliationCredentials.of({
        load: Effect.succeed({
          forTenant: (tenantId: string) => {
            const tenant = Number.parseInt(tenantId.slice(-12), 16);
            return Effect.succeed(keys.has(tenant) ? Option.some(fakeKey(tenant)) : Option.none());
          },
        }),
      }),
    ),
    Layer.succeed(
      GatewayReconciliationInvoker,
      GatewayReconciliationInvoker.of({
        request: (row, key) =>
          Ref.update(harness.calls, (all) => [
            ...all,
            [row, gatewayReconciliationIdempotencyKey(row), Redacted.value(key)] as const,
          ]).pipe(Effect.andThen(options.outcome?.(row) ?? Effect.succeed(GATEWAY_RECONCILIATION_REQUESTED))),
      }),
    ),
  );
  const { sweep } = yield* makeGatewayReconciliationSweep(DEPLOYMENT).pipe(Effect.provide(layer));
  return { harness, sweep };
});

const calledOperations = (harness: Harness) =>
  Ref.get(harness.calls).pipe(Effect.map((calls) => calls.map(([row]) => row.operationId)));

const countBy = <Key extends string>(values: readonly Key[]) => {
  const counts = new Map<Key, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

it.effect('#1158 one tick reads at most 4 pages of 50 and requests within the tick, LE and family budgets', () =>
  Effect.gen(function* budgets() {
    // 300 due rows of one Tenant: 10 Legal Entities with 30 rows each, families interleaved.
    const rows = Array.from({ length: 300 }, (_, index) =>
      rowOf({ family: FAMILIES[index % 3], le: Math.floor(index / 30), op: index, tenant: 1 }),
    );
    const { harness, sweep } = yield* makeHarness({ rows });
    const result = yield* sweep;

    const listed = yield* Ref.get(harness.listed);
    expect(listed).toHaveLength(4);
    expect(listed.map(({ maxRounds, pageLimit }) => [pageLimit, maxRounds])).toEqual(
      Array.from({ length: 4 }, () => [50, 24]),
    );
    expect(Option.isNone(listed[0]?.after ?? Option.some(rows[0]))).toBe(true);
    // Every next page starts after the last row of the previous one; no time is passed.
    expect(listed.map((input) => sortedStrings(Object.keys(input)))).toEqual(
      Array.from({ length: 4 }, () => ['after', 'maxRounds', 'pageLimit']),
    );
    const keysets = rows.map(keysetOf);
    expect(listed.slice(1).map(({ after }) => after.pipe(Option.map(keysetOf), Option.getOrUndefined))).toEqual([
      keysets[49],
      keysets[99],
      keysets[149],
    ]);

    const calls = yield* Ref.get(harness.calls);
    expect(calls.length).toBeLessThanOrEqual(50);
    const perFamily = countBy(calls.map(([row]) => row.providerFamily));
    expect([...perFamily.values()].every((count) => count <= 15)).toBe(true);
    expect(Object.fromEntries(perFamily)).toEqual({ COMGATE: 15, GOPAY: 15, STRIPE: 15 });
    const perScope = countBy(calls.map(([row]) => `${row.tenantId}/${row.legalEntityId}`));
    expect([...perScope.values()].every((count) => count <= 20)).toBe(true);
    expect(result).toMatchObject({ listed: 200, purged: 2, requested: 45, skipped: 0, unavailable: 0 });
    expect(result.deferred).toBe(155);
    expect(yield* Ref.get(harness.purges)).toEqual([48]);
  }),
);

it.effect('#1158 the total budget caps a tick at 50 requests across Tenants and Legal Entities', () =>
  Effect.gen(function* totalBudget() {
    // Six Tenants, one Legal Entity each, 12 rows each spread over three families: 72 rows, 24 per family.
    const rows = Array.from({ length: 72 }, (_, index) =>
      rowOf({ family: FAMILIES[index % 3], le: 0, op: index, tenant: 1 + Math.floor(index / 12) }),
    );
    const { harness, sweep } = yield* makeHarness({ rows });
    const result = yield* sweep;
    const calls = yield* Ref.get(harness.calls);
    expect(calls).toHaveLength(45);
    expect(result.requested).toBe(45);
  }),
);

it.effect('#1158 the same listed row gets the identical idempotency key and payload, from one or two drivers', () =>
  Effect.gen(function* identicalRequests() {
    const row = rowOf({ le: 0, op: 7, round: 3, tenant: 1 });
    const first = yield* makeHarness({ rows: [row] });
    const second = yield* makeHarness({ rows: [row] });
    yield* Effect.all([first.sweep, second.sweep, first.sweep], { concurrency: 'unbounded' });
    const calls = [...(yield* Ref.get(first.harness.calls)), ...(yield* Ref.get(second.harness.calls))];
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(([, key]) => key))).toEqual(
      new Set([`payment.gateway-reconciliation:${row.operationId}:r3`]),
    );
    expect(gatewayReconciliationPayload(row)).toEqual({
      operationId: row.operationId,
      paymentId: row.paymentId,
      reason: 'Gateway reconciliation round 3',
      trigger: 'EXECUTION_OUTCOME_UNKNOWN',
    });
    expect(gatewayReconciliationPayload(calls[0]?.[0] ?? row)).toEqual(gatewayReconciliationPayload(row));
    // The next round is a new key only because A10 committed one more recovery request.
    expect(gatewayReconciliationIdempotencyKey({ ...row, round: 4 })).toBe(
      `payment.gateway-reconciliation:${row.operationId}:r4`,
    );
  }),
);

const outcomeFor =
  (script: ReadonlyMap<string, GatewayReconciliationOutcome>) =>
  (row: GatewayReconciliationDueRow): Effect.Effect<GatewayReconciliationOutcome> =>
    Effect.succeed(script.get(row.operationId) ?? GATEWAY_RECONCILIATION_REQUESTED);

it.effect('#1158 refusals skip without a retry in the tick; Tenant refusals cool the Tenant down for an hour', () =>
  Effect.gen(function* outcomeTable() {
    // Tenant 1: forbidden first, then two more rows. Tenant 2: module state. Tenant 3: drain. Tenant 4: one
    // GoPay row unavailable, then GoPay and Stripe rows. Tenant 5: resolved, held and hash conflict.
    const rows = [
      rowOf({ le: 0, op: 101, tenant: 1 }),
      rowOf({ le: 0, op: 201, tenant: 2 }),
      rowOf({ le: 0, op: 102, tenant: 1 }),
      rowOf({ le: 0, op: 103, tenant: 1 }),
      rowOf({ le: 0, op: 202, tenant: 2 }),
      rowOf({ le: 0, op: 301, tenant: 3 }),
      rowOf({ le: 0, op: 302, tenant: 3 }),
      rowOf({ family: 'GOPAY', le: 0, op: 401, tenant: 4 }),
      rowOf({ family: 'STRIPE', le: 0, op: 402, tenant: 4 }),
      rowOf({ family: 'GOPAY', le: 0, op: 403, tenant: 4 }),
      rowOf({ family: 'STRIPE', le: 0, op: 404, tenant: 4 }),
      rowOf({ le: 0, op: 501, tenant: 5 }),
      rowOf({ le: 0, op: 502, tenant: 5 }),
      rowOf({ le: 0, op: 503, tenant: 5 }),
    ];
    const script = new Map<string, GatewayReconciliationOutcome>([
      [op(101), skip('forbidden')],
      [op(201), skip('module_state')],
      [op(301), skip('drain')],
      [op(401), GATEWAY_RECONCILIATION_UNAVAILABLE],
      [op(501), skip('already_resolved')],
      [op(502), skip('held')],
      [op(503), skip('hash_conflict')],
    ]);
    const { harness, sweep } = yield* makeHarness({ outcome: outcomeFor(script), rows });

    const first = yield* sweep;
    const firstCalls = yield* calledOperations(harness);
    // Every called row is called once; a refusing or drained Tenant gets nothing more in this tick.
    expect(new Set(firstCalls).size).toBe(firstCalls.length);
    expect(firstCalls).not.toContain(op(103));
    expect(firstCalls).not.toContain(op(202));
    expect(firstCalls).not.toContain(op(302));
    // GoPay unavailable stops GoPay of that Tenant for this tick, never its Stripe rows (H1094-01=A).
    expect(firstCalls).not.toContain(op(403));
    expect(firstCalls).toEqual(expect.arrayContaining([op(401), op(402), op(404), op(501), op(502), op(503)]));
    expect(first.unavailable).toBe(1);

    // Next tick, 59 minutes later: the cooled Tenants and rows stay out; the drained and unavailable come back.
    yield* TestClock.adjust('59 minutes');
    yield* Ref.set(harness.calls, []);
    yield* sweep;
    const second = yield* calledOperations(harness);
    for (const cooled of [101, 102, 103, 201, 202, 501, 502, 503]) {
      expect(second).not.toContain(op(cooled));
    }
    // The scripted drain and outage answer again: each still stops only its own Tenant or Tenant family.
    expect(sortedStrings(second)).toEqual(sortedStrings([op(301), op(401), op(402), op(404)]));

    // After the hour every row is requested again (the listing decides whether it is still due).
    yield* TestClock.adjust('2 minutes');
    yield* Ref.set(harness.calls, []);
    yield* sweep;
    expect(yield* calledOperations(harness)).toEqual(
      expect.arrayContaining([op(101), op(201), op(501), op(502), op(503)]),
    );
  }),
);

it.effect('#1158 a Tenant without a key is skipped while the others are requested', () =>
  Effect.gen(function* missingKey() {
    const rows = [rowOf({ le: 0, op: 1, tenant: 1 }), rowOf({ le: 0, op: 2, tenant: 2 })];
    const { harness, sweep } = yield* makeHarness({ keys: new Set([2]), rows });
    const result = yield* sweep;
    expect(yield* calledOperations(harness)).toEqual([rows[1]?.operationId]);
    expect(result).toMatchObject({ deferred: 1, requested: 1 });
    const calls = yield* Ref.get(harness.calls);
    expect(calls.map((call) => call[2])).toEqual(['fake-driver-key-2']);
  }),
);

it.effect('#1158 an unapproved or unreadable release lists nothing, purges nothing and requests nothing', () =>
  Effect.gen(function* unapproved() {
    const rows = [rowOf({ le: 0, op: 1, tenant: 1 })];
    for (const snapshot of [snapshotFor('another-payment-build'), Effect.fail('composition unavailable')] as const) {
      const { harness, sweep } = yield* makeHarness({ rows, snapshot });
      const result = yield* sweep;
      expect(result).toMatchObject({ listed: 0, purged: 0, requested: 0 });
      expect(yield* Ref.get(harness.listed)).toEqual([]);
      expect(yield* Ref.get(harness.purges)).toEqual([]);
      expect(yield* Ref.get(harness.calls)).toEqual([]);
    }
  }),
);

it.effect('#1234 a slow request does not change the decisions made for later rows', () =>
  Effect.gen(function* slowCall() {
    const rows = Array.from({ length: 30 }, (_, index) =>
      rowOf({ family: FAMILIES[index % 3], le: index % 2, op: index, tenant: 1 }),
    );
    const fast = yield* makeHarness({ rows });
    yield* fast.sweep;
    const expected = yield* calledOperations(fast.harness);

    const [firstOperation] = expected;
    const slowStarted = yield* Deferred.make<boolean>();
    const slow = yield* makeHarness({
      outcome: (row) =>
        row.operationId === firstOperation
          ? Deferred.succeed(slowStarted, true).pipe(
              Effect.andThen(Effect.sleep('10 minutes')),
              Effect.as(GATEWAY_RECONCILIATION_REQUESTED),
            )
          : Effect.succeed(GATEWAY_RECONCILIATION_REQUESTED),
      rows,
    });
    const fiber = yield* Effect.forkChild(slow.sweep);
    // The clock moves only once the tick is past its admission and listing and inside the first request.
    yield* Deferred.await(slowStarted);
    yield* TestClock.adjust('10 minutes');
    const result = yield* Fiber.join(fiber);
    expect(sortedStrings(yield* calledOperations(slow.harness))).toEqual(sortedStrings(expected));
    // The listing was read once per page before the first request; nothing was re-listed after the delay.
    expect(yield* Ref.get(slow.harness.listed)).toHaveLength(1);
    expect(result.requested).toBe(expected.length);
  }),
);

it.effect('#1158 the loop ticks first after one interval and then once per interval', () =>
  Effect.gen(function* loopTiming() {
    const ticks = yield* Ref.make(0);
    const sweep = Ref.updateAndGet(ticks, (count) => count + 1).pipe(
      Effect.as<GatewayReconciliationSweepResult>({
        deferred: 0,
        failures: [],
        listed: 0,
        purged: 0,
        requested: 0,
        skipped: 0,
        unavailable: 0,
      }),
    );
    const fiber = yield* Effect.forkChild(runGatewayReconciliationLoop(sweep));
    yield* TestClock.adjust('59 seconds');
    expect(yield* Ref.get(ticks)).toBe(0);
    yield* TestClock.adjust('1 second');
    expect(yield* Ref.get(ticks)).toBe(1);
    yield* TestClock.adjust(GATEWAY_RECONCILIATION_INTERVAL);
    expect(yield* Ref.get(ticks)).toBe(2);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect('#1158 a failing listing or purge is reported and never fails the tick', () =>
  Effect.gen(function* failingPorts() {
    const calls = yield* Ref.make(0);
    const snapshot = yield* snapshotFor(DEPLOYMENT.buildMarker);
    const layer = Layer.mergeAll(
      Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Layer.succeed(GatewayReconciliationDueSource, {
        listDue: () => Effect.fail(new GatewayReconciliationDueUnavailable({ reason: 'listing down' })),
        purgeExpiredPayerContacts: () => Effect.fail(new GatewayReconciliationDueUnavailable({ reason: 'purge down' })),
      }),
      Layer.succeed(ReconciliationCredentials, {
        load: Effect.succeed({ forTenant: () => Effect.succeedNone }),
      }),
      Layer.succeed(GatewayReconciliationInvoker, {
        request: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(GATEWAY_RECONCILIATION_REQUESTED)),
      }),
    );
    const { sweep } = yield* makeGatewayReconciliationSweep(DEPLOYMENT).pipe(Effect.provide(layer));
    const result = yield* sweep;
    expect(result.failures).toEqual(['purge down', 'listing down']);
    expect(yield* Ref.get(calls)).toBe(0);
  }),
);

// -------------------------------------------------------------------------------------------------
// Credentials
// -------------------------------------------------------------------------------------------------

const TENANT_A = uuid(0x10, 1);
const TENANT_B = uuid(0x10, 2);
const TENANT_C = uuid(0x10, 3);

const keysFor = (document: string | undefined, tenantIds: readonly string[]) =>
  Effect.gen(function* resolveKeys() {
    const credentials = yield* ReconciliationCredentials;
    const tick = yield* credentials.load;
    return yield* Effect.forEach(
      tenantIds,
      (tenantId) => tick.forTenant(tenantId).pipe(Effect.map(Option.map((key) => String(Redacted.value(key))))),
      { concurrency: 1 },
    );
  }).pipe(
    Effect.provide(ReconciliationCredentialsLive),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown(
          document === undefined ? {} : { [PAYMENT_RECONCILIATION_CREDENTIALS_VARIABLE]: document },
        ),
      ),
    ),
  );

it.effect('#1158 driver keys are decoded per entry: a broken or duplicated entry fails only its own Tenant', () =>
  Effect.gen(function* credentialEntries() {
    const document = JSON.stringify([
      { apiKey: 'fake-key-a', tenantId: TENANT_A },
      { apiKey: '', tenantId: TENANT_B },
      { apiKey: 'fake-key-c1', tenantId: TENANT_C },
      { apiKey: 'fake-key-c2', tenantId: TENANT_C },
      { apiKey: 'fake-key-x', extra: true, tenantId: TENANT_B },
    ]);
    expect(yield* keysFor(document, [TENANT_A, TENANT_B, TENANT_C])).toEqual([
      Option.some('fake-key-a'),
      Option.none(),
      Option.none(),
    ]);
    expect(yield* keysFor(undefined, [TENANT_A])).toEqual([Option.none()]);
    expect(yield* keysFor('not json', [TENANT_A])).toEqual([Option.none()]);
  }),
);

// -------------------------------------------------------------------------------------------------
// Live invoker over a recorded Shell relay
// -------------------------------------------------------------------------------------------------

/** Problem values are plain tagged JSON objects; the relay sends them as `application/problem+json`. */
const problemBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const conflict = (code: (typeof PaymentReconciliationConflictProblemSchema.Type)['code']) => ({
  body: problemBody(
    PaymentReconciliationConflictProblemSchema.make({
      code,
      detail: 'Fake conflict',
      status: 409,
      title: 'Recovery request conflict',
      type: 'https://ontos.dev/problems/payment-reconciliation-conflict',
    }),
  ),
  status: 409,
});

interface Reply {
  readonly body: string;
  readonly status: number;
}

type RelayProblem =
  | typeof PaymentReconciliationForbiddenProblemSchema.Type
  | typeof PaymentReconciliationIneligibleProblemSchema.Type
  | typeof PaymentReconciliationUnavailableProblemSchema.Type;
const problem = (status: number, value: RelayProblem): Reply => ({ body: problemBody(value), status });

const shellBaseUrl = (baseUrl: string) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ ONTOS_SHELL_GATEWAY_BASE_URL: baseUrl }));
const SHELL_BASE_URL = shellBaseUrl('http://shell.internal.test:3020/shell-super-app-api');

/** The live invoker over one recorded Shell reply; the base URL is read per request from the ambient config. */
const invokerOver = (reply: Reply) =>
  Effect.gen(function* recordedRelay() {
    const sent: HttpClientRequest.HttpClientRequest[] = [];
    const client = HttpClient.make((request) => {
      sent.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(reply.body, {
            headers: { 'content-type': reply.status >= 400 ? 'application/problem+json' : 'application/json' },
            status: reply.status,
          }),
        ),
      );
    });
    const context = yield* Layer.build(
      GatewayReconciliationInvokerLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    );
    return { invoker: Context.get(context, GatewayReconciliationInvoker), sent };
  });

it.effect('#1158 the live invoker sends one route-scoped request to the Shell relay origin with key and payload', () =>
  Effect.scoped(
    Effect.gen(function* liveRequest() {
      const row = rowOf({ le: 0, op: 9, round: 2, tenant: 1 });
      const { invoker, sent } = yield* invokerOver({ body: '{}', status: 503 });
      const outcome = yield* invoker.request(row, fakeKey(1));
      expect(outcome).toEqual(GATEWAY_RECONCILIATION_UNAVAILABLE);
      expect(sent).toHaveLength(1);
      const [request] = sent;
      expect(request?.method).toBe('POST');
      // Only the origin of ONTOS_SHELL_GATEWAY_BASE_URL is used: the relay serves absolute host paths.
      expect(request?.url).toBe(
        `http://shell.internal.test:3020/api/payment/v1/reconciliation/${row.routeKey}/recoveries`,
      );
      expect(request?.headers['idempotency-key']).toBe(`payment.gateway-reconciliation:${row.operationId}:r2`);
      expect(request?.headers['x-api-key']).toBe('fake-driver-key-1');
      const body = Match.value(request?.body).pipe(
        Match.when({ _tag: 'Uint8Array' }, (sentBody) => new TextDecoder().decode(sentBody.body)),
        Match.orElse(() => ''),
      );
      expect(JSON.parse(body)).toEqual({
        operationId: row.operationId,
        paymentId: row.paymentId,
        reason: 'Gateway reconciliation round 2',
        trigger: 'EXECUTION_OUTCOME_UNKNOWN',
      });
    }),
  ).pipe(Effect.provide(SHELL_BASE_URL)),
);

it.effect('#1158 relay answers map to the driver outcome table', () =>
  Effect.scoped(
    Effect.gen(function* answerTable() {
      const row = rowOf({ le: 0, op: 9, tenant: 1 });
      const cases: readonly (readonly [Reply, GatewayReconciliationOutcome])[] = [
        [conflict('payment_recovery_operation_already_resolved'), gatewayReconciliationSkipped('already_resolved')],
        [conflict('payment_held_for_reconciliation'), gatewayReconciliationSkipped('held')],
        [conflict('action_request_hash_conflict'), gatewayReconciliationSkipped('hash_conflict')],
        [conflict('action_already_committed'), gatewayReconciliationSkipped('hash_conflict')],
        [conflict('payment_aggregate_version_conflict'), gatewayReconciliationSkipped('held')],
        [
          problem(
            422,
            PaymentReconciliationIneligibleProblemSchema.make({
              code: 'request_invalid',
              detail: 'Fake contract mismatch',
              status: 422,
              title: 'Recovery request not eligible',
              type: 'https://ontos.dev/problems/payment-reconciliation-ineligible',
            }),
          ),
          gatewayReconciliationSkipped('held'),
        ],
        [
          problem(
            403,
            PaymentReconciliationForbiddenProblemSchema.make({
              detail: 'Fake forbidden',
              status: 403,
              title: 'Reconciliation forbidden',
              type: 'https://ontos.dev/problems/payment-reconciliation-forbidden',
            }),
          ),
          gatewayReconciliationSkipped('forbidden'),
        ],
        [
          problem(
            503,
            PaymentReconciliationUnavailableProblemSchema.make({
              detail: 'Fake unavailable',
              retryable: true,
              status: 503,
              title: 'Reconciliation unavailable',
              type: 'https://ontos.dev/problems/payment-reconciliation-unavailable',
            }),
          ),
          GATEWAY_RECONCILIATION_UNAVAILABLE,
        ],
        // A 2xx whose body is not the A10 result is not proof of a recorded recovery.
        [{ body: '{"ok":true}', status: 200 }, GATEWAY_RECONCILIATION_UNAVAILABLE],
      ];
      for (const [reply, expected] of cases) {
        const { invoker, sent } = yield* invokerOver(reply);
        expect(yield* invoker.request(row, fakeKey(1)).pipe(Effect.provide(SHELL_BASE_URL))).toEqual(expected);
        expect(sent).toHaveLength(1);
      }
      // Without a usable Shell base URL the invoker sends nothing and the row waits for a later tick.
      const { invoker, sent } = yield* invokerOver({ body: '{}', status: 200 });
      expect(yield* invoker.request(row, fakeKey(1)).pipe(Effect.provide(shellBaseUrl('not a url')))).toEqual(
        GATEWAY_RECONCILIATION_UNAVAILABLE,
      );
      expect(yield* invoker.request(row, fakeKey(1))).toEqual(GATEWAY_RECONCILIATION_UNAVAILABLE);
      expect(sent).toEqual([]);
    }),
  ),
);
