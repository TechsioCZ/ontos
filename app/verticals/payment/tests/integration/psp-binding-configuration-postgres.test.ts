import type { PgClient } from '@effect/sql-pg';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Effect, Option, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  ProviderAccountBindingConflict,
  ProviderAccountBindingNotFound,
} from '../../shared/actions/configure-provider-account-binding.ts';
import type { ConfigureProviderAccountBindingPayload } from '../../shared/actions/configure-provider-account-binding.ts';
import type { RotateProviderCredentialPayload } from '../../shared/actions/rotate-provider-credential.ts';
import { PaymentUnavailable, paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import { GatewayProviderAccountRefSchema } from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
} from '../../shared/domain/psp-configuration.ts';
import type { GatewayEnvironment } from '../../shared/domain/psp-vocabulary.ts';
import { PaymentOwnerScopeSchema } from '../../src/ports/owner-evidence-unavailable.ts';
import { configureProviderAccountBindingAction } from '../../src/actions/configure-provider-account-binding.action.ts';
import { rotateProviderCredentialAction } from '../../src/actions/rotate-provider-credential.action.ts';
import { GatewayBindingResolver } from '../../src/integrations/psp/binding-resolver.ts';
import { GatewayBindingResolverLive } from '../../src/integrations/psp/binding-resolver-live.ts';
import { gatewayCaptureBindingResolverForTransaction } from '../../src/integrations/psp/capture-binding-resolver-live.ts';
import { pspBindingPersistenceForTransaction } from '../../src/persistence/psp-binding-persistence.ts';
import type {
  CreateProviderAccountBindingInput,
  PspBindingPersistence,
  PspBindingPersistenceFailure,
} from '../../src/persistence/psp-binding-persistence.ts';
import {
  pspPrepareDispatch,
  pspReadDispatch,
  pspRecordDispatchOutcome,
} from '../../src/persistence/psp-worker-routines.ts';
import type { PspPrepareDispatchInput, PspWorkerOrigin } from '../../src/persistence/psp-worker-routines.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  COMPOSITION_REVISION,
  collectInput,
  failureCodeOf,
  inScope,
  makeTestScope,
  newPaymentInput,
  operationalScopeOf,
  paymentTestRelations,
  provenanceFor,
  randomUuid,
  withPersistence,
} from './database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from './database-fixture.ts';

/**
 * #1155 native evidence for the Provider Account Binding Actions and both binding resolvers on the worktree
 * PostgreSQL, as the shared runtime role under forced RLS. Every test uses fresh Tenant and Legal Entity ids.
 */

type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];
type ScopedTransaction = Effect.Success<ReturnType<typeof installOperationalScope>>;

const inTransaction = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (transaction: ScopedTransaction) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PaymentTestTransaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope)).pipe(Effect.flatMap(operation)),
  );

const withBindings = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (persistence: PspBindingPersistence) => Effect.Effect<Value, Failure>,
) => inTransaction(database, scope, (transaction) => operation(pspBindingPersistenceForTransaction(transaction)));

const nativeDatabase = Effect.gen(function* nativeDatabase() {
  const { runtime: runtimeClient } = yield* testDatabaseClients;
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
  return { runtime, runtimeClient };
});

const GOPAY_IDENTITY = { _tag: 'GOPAY', goid: '8123456789' } as const;

const createInput = Effect.fn('PspBindingTest.createInput')(function* createInput(
  scope: PaymentTestScope,
  overrides: Partial<Omit<CreateProviderAccountBindingInput, 'provenance'>> = {},
) {
  return {
    environment: 'SANDBOX',
    merchantIdentity: GOPAY_IDENTITY,
    notificationUrl: 'https://hooks.example.test/psp',
    provenance: yield* provenanceFor(scope),
    reason: 'Configure the sandbox gateway account',
    replaces: Option.none(),
    secretRef: 'gopay-sandbox-1',
    ...overrides,
  } satisfies CreateProviderAccountBindingInput;
});

const workerScopeOf = (scope: PaymentTestScope, transaction: ScopedTransaction): OutboxWorkerLegalEntityScope => ({
  completionPublisher: { publish: () => Effect.die('unused completion publisher') },
  legalEntityId: scope.legalEntityId,
  routineInvoker: transaction,
  tenantId: scope.tenantId,
});

/** The worker resolver through its live layer, inside one Core-scoped runtime transaction. */
const resolveExecution = (
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  providerAccountRef: GatewayProviderAccountRef,
  environment: GatewayEnvironment = 'SANDBOX',
) =>
  inTransaction(database, scope, (transaction) =>
    Effect.gen(function* resolveThroughWorker() {
      const resolver = yield* GatewayBindingResolver;
      return yield* resolver.resolveExecutionTarget({
        customerConfigurationId: Option.none(),
        environment,
        providerAccountRef,
        providerFamily: 'GOPAY',
        scope: workerScopeOf(scope, transaction),
      });
    }).pipe(Effect.provide(GatewayBindingResolverLive)),
  );

const resolveCapture = (
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  providerAccountRef: GatewayProviderAccountRef,
  environment: GatewayEnvironment = 'SANDBOX',
) =>
  inTransaction(database, scope, (transaction) =>
    gatewayCaptureBindingResolverForTransaction(transaction).resolveForCapture({
      environment,
      providerAccountRef,
      providerFamily: 'GOPAY',
      scope: Schema.decodeUnknownSync(PaymentOwnerScopeSchema)(scope),
    }),
  );

const countRows = (client: PgClient.PgClient, scope: PaymentTestScope, table: string) =>
  inScope(
    client,
    scope,
    client.unsafe<{ readonly count: number }>(`select count(*)::integer as count from ${table}`),
  ).pipe(Effect.map((rows) => rows[0]?.count ?? -1));

const credentialHistory = (client: PgClient.PgClient, scope: PaymentTestScope) =>
  inScope(
    client,
    scope,
    client.unsafe<{ readonly revision: number; readonly secret_ref: string; readonly status: string }>(
      'select revision, secret_ref, status from payment.psp_credential_revisions order by revision',
    ),
  ).pipe(Effect.map((rows) => rows.map(({ revision, secret_ref, status }) => [revision, secret_ref, status])));

const workerOrigin = Effect.all([randomUuid, randomUuid], { concurrency: 1 }).pipe(
  Effect.map(([deliveryId, originActionInvocationId]): PspWorkerOrigin => ({
    compositionRevision: COMPOSITION_REVISION,
    deliveryId,
    originActionInvocationId,
    workerKey: 'payment.core.execute-gateway-operation',
  })),
);

/** A Payment with one COLLECT bound to the given binding, and its dispatch prepared under credential revision 1. */
const inFlightCollect = Effect.fn('PspBindingTest.inFlightCollect')(function* inFlightCollect(
  runtime: PaymentTestDatabase,
  scope: PaymentTestScope,
  binding: {
    readonly bindingId: GatewayProviderAccountBindingId;
    readonly providerAccountRef: GatewayProviderAccountRef;
  },
) {
  const executionBinding = {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: binding.providerAccountRef,
    providerFamily: 'GOPAY',
  } as const;
  const paymentInput = yield* newPaymentInput(scope);
  const created = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertPayment({ ...paymentInput, executionBinding }),
  );
  const collect = yield* collectInput(scope, { amountMinor: 100_000, paymentId: created.record.paymentId }, 'c-1');
  const collected = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertOperation({ ...collect, binding: executionBinding }),
  );
  const prepare: PspPrepareDispatchInput = {
    bindingId: binding.bindingId,
    credentialRevision: 1,
    endpointRef: 'gopay:POST:/api/payments/payment',
    idempotencyKeyHash: Option.none(),
    materialHash: collected.record.materialHash,
    operationId: collected.record.operationId,
    origin: yield* workerOrigin,
    providerPaymentRef: Option.none(),
    replayRequest: Option.none(),
    requestHash: 'a'.repeat(64),
    returnToken: Option.some('AbCdEfGhIjKlMnOpQrStUv'),
  };
  const prepared = yield* inTransaction(runtime, scope, (transaction) => pspPrepareDispatch(transaction, prepare));
  expect(Predicate.isTagged(prepared, 'PREPARED')).toBe(true);
  return prepare;
});

describe('#1155 Provider Account Binding persistence', () => {
  it.live('#1155 creates a pab_ binding with credential revision 1 and an append-only revision history', () =>
    Effect.scoped(
      Effect.gen(function* createsBinding() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const input = yield* createInput(scope);
        const created = yield* withBindings(runtime, scope, (p) => p.createBinding(input));
        expect(created.binding.view.providerAccountRef).toMatch(/^pab_[0-9a-f]{32}$/u);
        expect([
          created.binding.view.providerFamily,
          created.binding.view.status,
          created.binding.view.revision,
        ]).toEqual(['GOPAY', 'CURRENT', 1]);
        expect([created.credential.credentialRevision, created.credential.status]).toEqual([1, 'ACTIVE']);
        expect(Option.isNone(created.replaced)).toBe(true);

        // A second Current binding of the same family and environment must name the one it replaces.
        const second = yield* createInput(scope, { merchantIdentity: { _tag: 'GOPAY', goid: '8000000001' } });
        expect(yield* failureCodeOf(withBindings(runtime, scope, (p) => p.createBinding(second)))).toBe(
          'gateway_binding_current_exists',
        );
        // Another environment is a separate binding.
        const live = yield* createInput(scope, { environment: 'LIVE', secretRef: 'gopay-live-1' });
        const liveBinding = yield* withBindings(runtime, scope, (p) => p.createBinding(live));
        expect(liveBinding.binding.view.providerAccountRef).not.toBe(created.binding.view.providerAccountRef);
        expect(yield* countRows(runtimeClient, scope, 'payment.psp_provider_account_binding_revisions')).toBe(2);
      }),
    ),
  );

  it.live('#1155 replace and retire affect new intents only and are decided against the Current revision', () =>
    Effect.scoped(
      Effect.gen(function* replaceAndRetire() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const original = yield* withBindings(runtime, scope, (p) =>
          createInput(scope).pipe(Effect.flatMap((input) => p.createBinding(input))),
        );
        const ref = original.binding.view.providerAccountRef;

        const stale = yield* createInput(scope, {
          merchantIdentity: { _tag: 'GOPAY', goid: '8000000002' },
          replaces: Option.some({ expectedRevision: 5, providerAccountRef: ref }),
        });
        expect(yield* failureCodeOf(withBindings(runtime, scope, (p) => p.createBinding(stale)))).toBe(
          'gateway_binding_revision_conflict',
        );
        const replacement = yield* withBindings(runtime, scope, (p) =>
          createInput(scope, {
            merchantIdentity: { _tag: 'GOPAY', goid: '8000000002' },
            replaces: Option.some({ expectedRevision: 1, providerAccountRef: ref }),
            secretRef: 'gopay-sandbox-y',
          }).pipe(Effect.flatMap((input) => p.createBinding(input))),
        );
        expect(
          replacement.replaced.pipe(Option.map((replaced) => [replaced.view.providerAccountRef, replaced.view.status])),
        ).toEqual(Option.some([ref, 'RETIRED_FOR_NEW_INTENTS']));

        // Retiring an already retired binding, a stale revision and an unknown ref change nothing.
        const retire = (providerAccountRef: GatewayProviderAccountRef, expectedRevision: number) =>
          withBindings(runtime, scope, (p) =>
            provenanceFor(scope).pipe(
              Effect.flatMap((provenance) =>
                p.retireBinding({ expectedRevision, provenance, providerAccountRef, reason: 'Pause the account' }),
              ),
            ),
          );
        expect(yield* failureCodeOf(retire(ref, 2))).toBe('gateway_binding_not_current');
        const newRef = replacement.binding.view.providerAccountRef;
        expect(yield* failureCodeOf(retire(newRef, 2))).toBe('gateway_binding_revision_conflict');
        const unknownRef = Schema.decodeUnknownSync(GatewayProviderAccountRefSchema)(`pab_${'0'.repeat(32)}`);
        expect(yield* failureCodeOf(retire(unknownRef, 1))).toBe('gateway_binding_not_found');
        const retired = yield* retire(newRef, 1);
        expect([retired.binding.view.status, retired.binding.view.revision]).toEqual(['RETIRED_FOR_NEW_INTENTS', 2]);
        expect(yield* countRows(runtimeClient, scope, 'payment.psp_provider_account_binding_revisions')).toBe(4);
        // Historical bindings stay addressable.
        expect((yield* resolveCapture(runtime, scope, ref)).pipe(Option.map((target) => target.bindingId))).toEqual(
          Option.some(original.binding.view.bindingId),
        );
      }),
    ),
  );
});

describe('#1155 binding resolution of existing operations', () => {
  it.live('#1155 Binding is immutable for an existing payment', () =>
    Effect.scoped(
      Effect.gen(function* bindingImmutable() {
        const { runtime } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const x = yield* withBindings(runtime, scope, (p) =>
          createInput(scope).pipe(Effect.flatMap((input) => p.createBinding(input))),
        );
        const xRef = x.binding.view.providerAccountRef;
        const prepared = yield* inFlightCollect(runtime, scope, {
          bindingId: x.binding.view.bindingId,
          providerAccountRef: xRef,
        });

        // Rotate X, then replace it with Y for new intents.
        yield* withBindings(runtime, scope, (p) =>
          provenanceFor(scope).pipe(
            Effect.flatMap((provenance) =>
              p.rotateCredential({
                expectedRevision: 1,
                provenance,
                providerAccountRef: xRef,
                reason: 'Rotate after staff change',
                secretRef: 'gopay-sandbox-2',
              }),
            ),
          ),
        );
        const y = yield* withBindings(runtime, scope, (p) =>
          createInput(scope, {
            merchantIdentity: { _tag: 'GOPAY', goid: '8000000003' },
            replaces: Option.some({ expectedRevision: 2, providerAccountRef: xRef }),
            secretRef: 'gopay-sandbox-y',
          }).pipe(Effect.flatMap((input) => p.createBinding(input))),
        );

        // The operation's binding still resolves to X, never to the new Current Y.
        const target = yield* resolveExecution(runtime, scope, xRef);
        expect(target.bindingId).toBe(x.binding.view.bindingId);
        expect(target.bindingId).not.toBe(y.binding.view.bindingId);
        expect(target.binding.providerAccountRef).toBe(xRef);
        expect(target.credentialRevision).toBe(2);
        const dispatch = yield* inTransaction(runtime, scope, (transaction) =>
          pspReadDispatch(transaction, prepared.operationId),
        );
        expect(dispatch.pipe(Option.map((record) => record.bindingId))).toEqual(Option.some(x.binding.view.bindingId));
      }),
    ),
  );

  it.live('#1155 Credential rotation does not orphan in-flight operations', () =>
    Effect.scoped(
      Effect.gen(function* rotationKeepsInFlight() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const x = yield* withBindings(runtime, scope, (p) =>
          createInput(scope).pipe(Effect.flatMap((input) => p.createBinding(input))),
        );
        const xRef = x.binding.view.providerAccountRef;
        const prepared = yield* inFlightCollect(runtime, scope, {
          bindingId: x.binding.view.bindingId,
          providerAccountRef: xRef,
        });
        const rotated = yield* withBindings(runtime, scope, (p) =>
          provenanceFor(scope).pipe(
            Effect.flatMap((provenance) =>
              p.rotateCredential({
                expectedRevision: 1,
                provenance,
                providerAccountRef: xRef,
                reason: 'Rotate the API secret',
                secretRef: 'gopay-sandbox-2',
              }),
            ),
          ),
        );
        expect([rotated.retired.credentialRevision, rotated.retired.status]).toEqual([1, 'RETIRED']);
        expect([rotated.credential.credentialRevision, rotated.credential.status]).toEqual([2, 'ACTIVE']);
        expect(yield* credentialHistory(runtimeClient, scope)).toEqual([
          [1, 'gopay-sandbox-1', 'RETIRED'],
          [2, 'gopay-sandbox-2', 'ACTIVE'],
        ]);
        // Rotating to the same reference again is refused; nothing changes.
        const unchanged = withBindings(runtime, scope, (p) =>
          provenanceFor(scope).pipe(
            Effect.flatMap((provenance) =>
              p.rotateCredential({
                expectedRevision: 2,
                provenance,
                providerAccountRef: xRef,
                reason: 'Repeat',
                secretRef: 'gopay-sandbox-2',
              }),
            ),
          ),
        );
        expect(yield* failureCodeOf(unchanged)).toBe('gateway_credential_unchanged');

        // The PREPARED dispatch keeps its recorded revision; a redelivered prepare finds it (no orphan).
        const again = yield* inTransaction(runtime, scope, (transaction) =>
          workerOrigin.pipe(Effect.flatMap((origin) => pspPrepareDispatch(transaction, { ...prepared, origin }))),
        );
        expect(Predicate.isTagged(again, 'EXISTING')).toBe(true);
        // It may become OUTCOME_UNKNOWN and is still resolved through the same binding, with the ACTIVE revision.
        yield* inTransaction(runtime, scope, (transaction) =>
          pspRecordDispatchOutcome(transaction, {
            customerRedirectUrl: Option.none(),
            deliveryId: prepared.origin.deliveryId,
            operationId: prepared.operationId,
            providerPaymentRef: Option.none(),
            providerRefundRef: Option.none(),
            to: 'OUTCOME_UNKNOWN',
          }),
        );
        const dispatch = yield* inTransaction(runtime, scope, (transaction) =>
          pspReadDispatch(transaction, prepared.operationId),
        );
        expect(
          dispatch.pipe(Option.map((record) => [record.state, record.credentialRevision, record.bindingId])),
        ).toEqual(Option.some(['OUTCOME_UNKNOWN', 1, x.binding.view.bindingId]));
        const target = yield* resolveExecution(runtime, scope, xRef);
        expect([target.bindingId, target.credentialRevision, target.credentialSecretRef]).toEqual([
          x.binding.view.bindingId,
          2,
          'gopay-sandbox-2',
        ]);
      }),
    ),
  );

  it.live('#1155 PSP environment is not interchangeable', () =>
    Effect.scoped(
      Effect.gen(function* environmentIsolation() {
        const { runtime } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const sandbox = yield* withBindings(runtime, scope, (p) =>
          createInput(scope).pipe(Effect.flatMap((input) => p.createBinding(input))),
        );
        const ref = sandbox.binding.view.providerAccountRef;
        expect((yield* resolveExecution(runtime, scope, ref, 'SANDBOX')).bindingId).toBe(
          sandbox.binding.view.bindingId,
        );

        // The SANDBOX ref never resolves for LIVE, on the worker or at capture.
        const live = yield* resolveExecution(runtime, scope, ref, 'LIVE').pipe(
          Effect.flatMap(() => Effect.die('a SANDBOX ref resolved for LIVE')),
          Effect.catchTag('GatewayProviderUnavailable', (failure) => Effect.succeed(failure)),
        );
        expect([live.code, live.family, live.reason]).toEqual([
          'gateway_provider_unavailable',
          'GOPAY',
          'environment_mismatch',
        ]);
        expect(Option.isNone(yield* resolveCapture(runtime, scope, ref, 'LIVE'))).toBe(true);
        // A LIVE binding of the same family is a different account; it is not a substitute either.
        yield* withBindings(runtime, scope, (p) =>
          createInput(scope, { environment: 'LIVE', secretRef: 'gopay-live-1' }).pipe(
            Effect.flatMap((input) => p.createBinding(input)),
          ),
        );
        expect(Option.isNone(yield* resolveCapture(runtime, scope, ref, 'LIVE'))).toBe(true);
      }),
    ),
  );

  it.live('#1155 bindings are isolated per Selling Legal Entity under RLS', () =>
    Effect.scoped(
      Effect.gen(function* legalEntityIsolation() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const otherLegalEntity = { ...scope, legalEntityId: yield* randomUuid };
        const created = yield* withBindings(runtime, scope, (p) =>
          createInput(scope).pipe(Effect.flatMap((input) => p.createBinding(input))),
        );
        const ref = created.binding.view.providerAccountRef;

        // Raw SQL under the other scope sees nothing: RLS, not only the owner predicate.
        expect(yield* countRows(runtimeClient, otherLegalEntity, 'payment.psp_provider_account_bindings')).toBe(0);
        expect(yield* countRows(runtimeClient, otherLegalEntity, 'payment.psp_credential_revisions')).toBe(0);
        expect(Option.isNone(yield* resolveCapture(runtime, otherLegalEntity, ref))).toBe(true);
        const worker = yield* resolveExecution(runtime, otherLegalEntity, ref).pipe(
          Effect.flatMap(() => Effect.die('a binding of another Legal Entity resolved')),
          Effect.catchTag('GatewayProviderUnavailable', (failure) => Effect.succeed(failure)),
        );
        expect([worker.code, worker.family, worker.reason]).toEqual([
          'gateway_provider_unavailable',
          'GOPAY',
          'binding_unknown',
        ]);
        const foreignRetire = withBindings(runtime, otherLegalEntity, (p) =>
          provenanceFor(otherLegalEntity).pipe(
            Effect.flatMap((provenance) =>
              p.retireBinding({ expectedRevision: 1, provenance, providerAccountRef: ref, reason: 'Foreign attempt' }),
            ),
          ),
        );
        expect(yield* failureCodeOf(foreignRetire)).toBe('gateway_binding_not_found');
        // The other Legal Entity's own Current binding of the same family does not collide.
        const own = yield* withBindings(runtime, otherLegalEntity, (p) =>
          createInput(otherLegalEntity).pipe(Effect.flatMap((input) => p.createBinding(input))),
        );
        expect(own.binding.view.status).toBe('CURRENT');
      }),
    ),
  );
});

/** Each persistence call in its own Core-scoped native transaction, bound into the Core Action harness. */
const isBindingFailure = Schema.is(
  Schema.Union([ProviderAccountBindingConflict, ProviderAccountBindingNotFound, PaymentUnavailable]),
);
const isPaymentUnavailable = Schema.is(PaymentUnavailable);

const nativeBindingServices = (database: PaymentTestDatabase, scope: PaymentTestScope): PspBindingPersistence => {
  const native = <Value>(
    operation: (persistence: PspBindingPersistence) => Effect.Effect<Value, PspBindingPersistenceFailure>,
  ) =>
    withBindings(database, scope, operation).pipe(
      Effect.mapError((failure) =>
        isBindingFailure(failure) ? failure : paymentUnavailable('Native transaction failed', failure),
      ),
    );
  return {
    createBinding: (input) => native((p) => p.createBinding(input)),
    readBindingTarget: (query) =>
      withBindings(database, scope, (p) => p.readBindingTarget(query)).pipe(
        Effect.mapError((failure) =>
          isPaymentUnavailable(failure) ? failure : paymentUnavailable('Native transaction failed', failure),
        ),
      ),
    retireBinding: (input) => native((p) => p.retireBinding(input)),
    rotateCredential: (input) => native((p) => p.rotateCredential(input)),
  };
};

const principalOf = (scope: PaymentTestScope) => ({
  authBindingId: scope.principalId,
  authContextRef: 'better-auth-session:payment-binding-tests',
  authMethod: 'session' as const,
  legalEntityId: scope.legalEntityId,
  principalId: scope.principalId,
  tenantId: scope.tenantId,
});

describe('#1155 binding Actions through the Core Action runtime', () => {
  it.live('#1155 configure and rotate run through their descriptors; a non-admin principal is denied', () =>
    Effect.scoped(
      Effect.gen(function* actionsThroughCore() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const services = [
          bindActionTestServices(configureProviderAccountBindingAction, nativeBindingServices(runtime, scope)),
          bindActionTestServices(rotateProviderCredentialAction, nativeBindingServices(runtime, scope)),
        ];
        const payload: ConfigureProviderAccountBindingPayload = Schema.decodeUnknownSync(
          configureProviderAccountBindingAction.descriptor.payloadSchema,
        )({
          change: {
            _tag: 'CREATE',
            environment: 'SANDBOX',
            merchantIdentity: { _tag: 'STRIPE', accountId: 'acct_1TestAccount' },
            notificationUrl: 'https://hooks.example.test/psp',
            reason: 'Configure the sandbox Stripe account',
            secretRef: 'stripe-sandbox-1',
          },
        });
        const request = {
          payload,
          principal: principalOf(scope),
          registration: configureProviderAccountBindingAction,
          transport: { correlationId: 'payment-binding-a', idempotencyKey: 'binding-create' },
        };

        const denied = yield* makeActionTestHarness({
          access: 'denied',
          ownerRegistration: paymentRegistration,
          services,
        });
        const refusal = yield* denied.runtime.runAction(request).pipe(Effect.flip);
        expect(Predicate.isTagged(refusal, 'ActionPermissionDenied')).toBe(true);
        expect(denied.snapshot().stages).not.toContain('handler_executed');
        expect(yield* countRows(runtimeClient, scope, 'payment.psp_provider_account_bindings')).toBe(0);

        const allowed = yield* makeActionTestHarness({
          access: 'allowed',
          ownerRegistration: paymentRegistration,
          services,
        });
        const created = yield* allowed.runtime.runAction(request);
        expect([created.binding.providerFamily, created.binding.status, created.credential.credentialRevision]).toEqual(
          ['STRIPE', 'CURRENT', 1],
        );
        // The binding view and the whole result carry no secret reference.
        const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* Schema.encodeEffect(configureProviderAccountBindingAction.descriptor.resultSchema)(created),
        );
        expect(encoded).not.toMatch(/secret|stripe-sandbox-1/iu);
        const [invocation] = allowed.snapshot().invocations;
        const [row] = yield* inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe<{ readonly action_invocation_id: string; readonly actor_principal_id: string }>(
            'select action_invocation_id, actor_principal_id from payment.psp_provider_account_bindings',
          ),
        );
        expect(row?.action_invocation_id).toBe(invocation?.actionInvocationId);
        expect(row?.actor_principal_id).toBe(scope.principalId);

        const rotatePayload: RotateProviderCredentialPayload = Schema.decodeUnknownSync(
          rotateProviderCredentialAction.descriptor.payloadSchema,
        )({
          expectedRevision: 1,
          providerAccountRef: created.binding.providerAccountRef,
          reason: 'Rotate the Stripe key',
          secretRef: 'stripe-sandbox-2',
        });
        const rotateRequest = {
          payload: rotatePayload,
          principal: principalOf(scope),
          registration: rotateProviderCredentialAction,
          transport: { correlationId: 'payment-binding-a', idempotencyKey: 'binding-rotate' },
        };
        const deniedRotation = yield* denied.runtime.runAction(rotateRequest).pipe(Effect.flip);
        expect(Predicate.isTagged(deniedRotation, 'ActionPermissionDenied')).toBe(true);
        const rotated = yield* allowed.runtime.runAction(rotateRequest);
        expect([
          rotated.credential.credentialRevision,
          rotated.retired.credentialRevision,
          rotated.binding.revision,
        ]).toEqual([2, 1, 2]);
        const rotatedEncoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* Schema.encodeEffect(rotateProviderCredentialAction.descriptor.resultSchema)(rotated),
        );
        expect(rotatedEncoded).not.toMatch(/secret|stripe-sandbox/iu);

        // A stale rotation is the typed conflict of the descriptor.
        const stale = yield* allowed.runtime
          .runAction({ ...rotateRequest, transport: { ...rotateRequest.transport, idempotencyKey: 'binding-stale' } })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(stale, 'ProviderAccountBindingConflict')).toBe(true);
      }),
    ),
  );
});
