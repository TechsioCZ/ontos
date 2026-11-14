import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessPrincipalKind } from '@app/core-runtime/access/enforcement';
import { AccessScopeIdSchema, LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { inertAccessEnforcementPorts } from '@app/core-runtime/testing/access-gate';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { Cause, DateTime, Effect, Exit, Layer, Match, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { bindAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import {
  CapturedProviderNotificationIdSchema,
  CaptureProviderNotificationResultSchema,
} from '../../shared/actions/capture-provider-notification.ts';
import { PaymentLegalEntityIdSchema, PaymentTenantIdSchema } from '../../shared/domain/payment-identifiers.ts';
import { captureProviderNotificationAction } from '../../src/actions/capture-provider-notification.action.ts';
import type { CaptureProviderNotificationServices } from '../../src/actions/capture-provider-notification.action.ts';
import { GATEWAY_LAUNCH_CAPABILITIES } from '../../src/integrations/psp/capability-matrix.ts';
import type { GatewayCaptureTargetQuery } from '../../src/integrations/psp/capture-binding-resolver.ts';
import { VerifiedNotificationCaptureSchema } from '../../src/integrations/psp/notification-envelope.ts';
import type { RawProviderNotification } from '../../src/integrations/psp/notification-envelope.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import type { GatewayProviderAdapter } from '../../src/integrations/psp/psp-adapter.ts';
import { GatewayNotificationRejected, GatewayProviderUnavailable } from '../../src/integrations/psp/psp-errors.ts';
import { GatewayExecutionTargetSchema } from '../../src/integrations/psp/psp-request.ts';
import type { BoundProviderBindingRoute } from '../../src/persistence/psp-binding-route-persistence.ts';
import type {
  CaptureProviderNotificationInput,
  CaptureProviderNotificationOutcome,
} from '../../src/persistence/psp-notification-capture-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  apiKeyPrincipalOf,
  CAPTURE_ROUTE_OPERATION,
  routeScopedPrincipalOf,
  RouteScopeNamespaceRegistryLive,
} from '../support/route-scope.fixture.ts';
import type { RouteScopeInput } from '../support/route-scope.fixture.ts';

/**
 * #1157 / #1153 / #1159 boundary of `capture-provider-notification` through the real Core Action runtime with
 * typed owner fakes: the workload-only admission and the Module State gate are decided by Core before the
 * handler runs, and the handler stores and enqueues exactly what its authenticity verdict allows.
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const LEGAL_ENTITY_ID = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_ID = '33333333-3333-4333-8333-333333333333';
const BINDING_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_BINDING_ID = '88888888-8888-4888-8888-888888888888';
const NOTIFICATION_ID = Schema.decodeUnknownSync(CapturedProviderNotificationIdSchema)(
  '55555555-5555-4555-8555-555555555555',
);
const ACCOUNT_REF = `pab_${'a'.repeat(32)}`;
const INGRESS_WORKLOAD = 'payment.provider-notification-ingress';
const RECEIVED_AT = DateTime.makeUnsafe('2026-11-12T09:00:00Z');

const RELAY = { legalEntityId: LEGAL_ENTITY_ID, principalId: PRINCIPAL_ID, tenantId: TENANT_ID } as const;

/**
 * The relay integration principal, authenticated by its API key in the Selling Legal Entity scope, carrying the
 * Shell-signed route scope of the binding (or of `route` when given).
 */
const routedPrincipal = (route: Partial<RouteScopeInput> = {}) =>
  routeScopedPrincipalOf(RELAY, { bindingId: BINDING_ID, operation: CAPTURE_ROUTE_OPERATION, ...route });

/** The binding's own route, as Payment stored it with the binding. */
const bindingRoute: BoundProviderBindingRoute = {
  bindingId: Schema.decodeUnknownSync(GatewayExecutionTargetSchema.fields.bindingId)(BINDING_ID),
  environment: 'SANDBOX',
  providerAccountRef: ACCOUNT_REF,
  providerFamily: 'STRIPE',
  routeRevision: 1,
};

const target = Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
  binding: {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: ACCOUNT_REF,
    providerFamily: 'STRIPE',
  },
  bindingId: BINDING_ID,
  credentialRevision: 1,
  credentialSecretRef: 'stripe-sandbox-1',
  legalEntityId: LEGAL_ENTITY_ID,
  merchantIdentity: { _tag: 'STRIPE', accountId: 'acct_1C17UnitFixture' },
  notificationUrl: 'https://hooks.example.test/psp/stripe',
  returnUrl: Option.none(),
  tenantId: TENANT_ID,
});

const triggerOf = (actionable: boolean) =>
  Schema.decodeUnknownSync(VerifiedNotificationCaptureSchema)({
    actionable,
    authenticity: 'SIGNATURE_VERIFIED',
    claimedStatus: Option.some('succeeded'),
    deliveryIdentity: 'stripe:evt:evt_c17_unit',
    family: 'STRIPE',
    providerEventAt: Option.none(),
    providerOccurrenceId: Option.none(),
    providerRefs: [{ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_c17_unit' }],
    retainedBody: new Uint8Array(0),
    signedObject: Option.none(),
    verifiedAt: RECEIVED_AT,
  });

const AuthenticVerdict = Schema.TaggedStruct('AUTHENTIC', { actionable: Schema.Boolean });
const RejectedVerdict = Schema.TaggedStruct('REJECTED', {});
const UnavailableVerdict = Schema.TaggedStruct('UNAVAILABLE', {});
const VerdictSchema = Schema.Union([AuthenticVerdict, RejectedVerdict, UnavailableVerdict]);
type Verdict = typeof VerdictSchema.Type;
const authentic = (actionable: boolean): Verdict => AuthenticVerdict.make({ actionable });

interface Recorder {
  readonly captured: CaptureProviderNotificationInput[];
  readonly queries: GatewayCaptureTargetQuery[];
  readonly routeReads: string[];
  readonly verified: RawProviderNotification[];
}

interface FakeOptions {
  readonly bindingKnown?: boolean;
  /** The routes Payment stored, by binding id; the binding's own route unless given. */
  readonly routes?: Readonly<Record<string, BoundProviderBindingRoute>>;
  readonly stored?: CaptureProviderNotificationOutcome['_tag'];
  /** The binding the resolver answers with; the routed binding unless given. */
  readonly target?: typeof target;
}

const unused = () => Effect.die('Only notification verification is exercised here');

const verdictEffect = (verdict: Verdict) =>
  Match.valueTags(verdict, {
    AUTHENTIC: ({ actionable }) => Effect.succeed(triggerOf(actionable)),
    REJECTED: () =>
      Effect.fail(
        new GatewayNotificationRejected({
          code: 'gateway_notification_rejected',
          family: 'STRIPE',
          reason: 'SIGNATURE_INVALID',
        }),
      ),
    UNAVAILABLE: () =>
      Effect.fail(
        new GatewayProviderUnavailable({
          code: 'gateway_provider_unavailable',
          family: 'STRIPE',
          reason: 'credential_unavailable',
        }),
      ),
  });

/** Owner fakes: a resolver knowing one binding, a scripted verifier and a store answering with `stored`. */
const fakeServices = (
  verdict: Verdict,
  recorder: Recorder,
  options: FakeOptions = {},
): CaptureProviderNotificationServices => {
  const adapter: GatewayProviderAdapter = {
    capabilities: GATEWAY_LAUNCH_CAPABILITIES.STRIPE,
    family: 'STRIPE',
    lookup: unused,
    prepareCancel: unused,
    prepareCollect: unused,
    prepareRefund: unused,
    readOrderReference: unused,
    replay: unused,
    send: unused,
    verifyNotification: (_target, notification) => {
      recorder.verified.push(notification);
      return verdictEffect(verdict);
    },
  };
  return {
    adapters: { forFamily: () => Effect.succeed(adapter) },
    bindings: {
      resolveForCapture: (query) => {
        recorder.queries.push(query);
        return Effect.succeed(options.bindingKnown === false ? Option.none() : Option.some(options.target ?? target));
      },
    },
    notifications: {
      captureNotification: (input) => {
        recorder.captured.push(input);
        return Effect.succeed({ _tag: options.stored ?? 'INSERTED', notificationId: NOTIFICATION_ID });
      },
    },
    routes: {
      readRouteOfBinding: (bindingId) => {
        recorder.routeReads.push(bindingId);
        return Effect.succeed(Option.fromUndefinedOr((options.routes ?? { [BINDING_ID]: bindingRoute })[bindingId]));
      },
    },
  };
};

const newRecorder = (): Recorder => ({ captured: [], queries: [], routeReads: [], verified: [] });

/** The adapter registry is replaced by the bound fakes; the layer only satisfies the declared requirement. */
const AdaptersRequirement = Layer.succeed(GatewayProviderAdapters, {
  forFamily: () => Effect.die('The bound test services carry the adapters'),
});

/** Scope or time fields a malicious relay body might try to carry; none is part of the contract. */
const SmuggledFieldsSchema = Schema.Struct({
  legalEntityId: Schema.optionalKey(PaymentLegalEntityIdSchema),
  receivedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  tenantId: Schema.optionalKey(PaymentTenantIdSchema),
});
type SmuggledFields = typeof SmuggledFieldsSchema.Encoded;

/** The relay's JSON body: a Stripe event's raw bytes in base64 and allow-listed headers. */
const relayPayload = (smuggled: SmuggledFields = {}) => ({
  ...smuggled,
  environment: 'SANDBOX',
  family: 'STRIPE',
  headers: { contentType: 'application/json', stripeSignature: 't=1,v1=00' },
  providerAccountRef: ACCOUNT_REF,
  query: {},
  rawBody: 'eyJpZCI6ImV2dF9jMTdfdW5pdCJ9',
  transportDeliveryRef: 'relay-delivery-1',
});

type CaptureHarnessOptions = Omit<ActionTestHarnessOptions, 'services'> & {
  readonly owner: CaptureProviderNotificationServices;
  /**
   * The invoking context for the composition revision the harness installs; the relay principal with the binding's
   * route scope unless given.
   */
  readonly principal?: (compositionRevision: string) => ReturnType<typeof routedPrincipal>;
};

const capture = Effect.fn('PspCaptureTest.capture')(function* capture(
  {
    owner,
    principal = (compositionRevision) => routedPrincipal({ compositionRevision }),
    ...options
  }: CaptureHarnessOptions,
  payload: ReturnType<typeof relayPayload> = relayPayload(),
) {
  // The route scope is signed for the revision of the composition that installs this Payment release.
  const composition = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: paymentRegistration });
  const harness = yield* makeActionTestHarness({
    access: 'allowed',
    applicationComposition: composition.applicationComposition,
    expectedDeployment: composition.expectedDeployment,
    ownerRegistration: paymentRegistration,
    ...options,
    services: [bindActionTestServices(captureProviderNotificationAction, owner)],
  });
  const exit = yield* harness.runtime
    .runAction({
      payload,
      principal: principal(composition.snapshot.composition.revision),
      registration: captureProviderNotificationAction,
      transport: { correlationId: 'payment-psp-capture-unit', idempotencyKey: 'capture-unit-1' },
    })
    .pipe(Effect.provide(Layer.merge(AdaptersRequirement, RouteScopeNamespaceRegistryLive)), Effect.exit);
  return { exit, snapshot: harness.snapshot() };
});
type CaptureOutcome = Effect.Success<ReturnType<typeof capture>>;

/** The successful result as `[tag, notificationId | rejection reason]`. */
const summaryOf = (outcome: CaptureOutcome) =>
  Exit.match(outcome.exit, {
    onFailure: (cause) => ['FAILED', Cause.pretty(cause)],
    onSuccess: (value) =>
      Match.valueTags(Schema.decodeUnknownSync(CaptureProviderNotificationResultSchema)(value), {
        CAPTURED: ({ notificationId }) => ['CAPTURED', notificationId],
        DUPLICATE: ({ notificationId }) => ['DUPLICATE', notificationId],
        IGNORED: ({ notificationId }) => ['IGNORED', notificationId],
        REJECTED: ({ reason }) => ['REJECTED', reason],
      }),
  });

/** The tags of the typed failures a refused capture raised. */
const failureTagsOf = (outcome: CaptureOutcome) =>
  Exit.match(outcome.exit, {
    onFailure: (cause) => cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error._tag),
    onSuccess: () => [],
  });

/** An intent source that resolves every request to its Tenant scope and holds no grant cells. */
const authorityFor: AccessEnforcementPorts['intent']['authorityFor'] = () => ({
  readCells: () => Effect.succeed([]),
  readConnection: () => Effect.succeed(Option.none()),
  readScope: (query) =>
    Effect.succeed(
      Option.some({
        deadlines: [],
        holderDeadlines: [],
        scope: { _tag: 'TenantContext', tenantId: query.tenantId },
        scopeId: AccessScopeIdSchema.make('77777777-7777-4777-8777-777777777777'),
        tenantId: query.tenantId,
      }),
    ),
  readTeamIds: () => Effect.succeed([]),
});
/** A real access decision over the registered workload bindings of the acting principal (O73). */
const workloadGate = (kind: AccessPrincipalKind, boundKeys: readonly string[]) => {
  const ports: AccessEnforcementPorts = {
    ...inertAccessEnforcementPorts(),
    intent: { authorityFor },
    principalKinds: { readKind: () => Effect.succeed(Option.some(kind)) },
    workloadBindings: {
      // The workload is registered for the company the call runs in (D6).
      readWorkloadAuthority: (query) =>
        Effect.succeed({
          activeCompanyIds: new Set(
            query.scope.legalEntityId === undefined ? [] : [LegalEntityIdSchema.make(query.scope.legalEntityId)],
          ),
          workloadKeys: new Set(boundKeys),
        }),
    },
  };
  const gate = makeAccessDecisionService({
    authorityFor,
    check: ports.check,
    decisionLog: ports.decisionLog,
    legalEntities: ports.candidates,
    principalKinds: ports.principalKinds,
    workloadBindings: ports.workloadBindings,
  });
  return bindAccessGate(gate, ports);
};

describe('#1157 capture-provider-notification handler', () => {
  it.effect('#1157 an authentic actionable notification is stored with one completion-bound processing message', () =>
    Effect.gen(function* authenticCaptured() {
      yield* TestClock.setTime(DateTime.toEpochMillis(RECEIVED_AT));
      const recorder = newRecorder();
      const outcome = yield* capture({ owner: fakeServices(authentic(true), recorder) });
      expect(summaryOf(outcome)).toEqual(['CAPTURED', NOTIFICATION_ID]);
      // Scope comes from the admitted invocation; family and environment from the route.
      expect(recorder.queries).toEqual([
        {
          environment: 'SANDBOX',
          providerAccountRef: ACCOUNT_REF,
          providerFamily: 'STRIPE',
          scope: { legalEntityId: LEGAL_ENTITY_ID, tenantId: TENANT_ID },
        },
      ]);
      // receivedAt is OntOS's own clock; the exact bytes and allow-listed headers reach the verifier.
      const [raw] = recorder.verified;
      expect(raw?.receivedAt).toEqual(RECEIVED_AT);
      expect(new TextDecoder().decode(raw?.rawBody)).toBe('{"id":"evt_c17_unit"}');
      expect(raw?.headers.stripeSignature).toEqual(Option.some('t=1,v1=00'));
      expect(raw?.query).toEqual({ parentPaymentRef: Option.none(), paymentRef: Option.none() });
      expect(
        recorder.captured.map((input) => [input.bindingId, input.state, input.provenance.actorPrincipalId]),
      ).toEqual([[BINDING_ID, 'CAPTURED', PRINCIPAL_ID]]);
      const [committed] = outcome.snapshot.committed;
      expect(
        committed?.evidence.outboxMessages.map(({ completion, message }) => [
          message.topic,
          message.payloadJson,
          completion?.consumerModuleKey,
        ]),
      ).toEqual([
        [
          'payment.core.provider-notification-captured.v1',
          { data: { notificationId: NOTIFICATION_ID } },
          'payment.core',
        ],
      ]);
      expect(committed?.evidence.domainEvents.map((event) => [event.eventType, event.subjectResourceId])).toEqual([
        ['payment.core.provider-notification-captured.v1', NOTIFICATION_ID],
      ]);
    }),
  );

  it.effect('#1157 an authentic non-actionable notification is stored IGNORED with no processing message', () =>
    Effect.gen(function* authenticIgnored() {
      const recorder = newRecorder();
      const outcome = yield* capture({ owner: fakeServices(authentic(false), recorder) });
      expect(summaryOf(outcome)).toEqual(['IGNORED', NOTIFICATION_ID]);
      expect(recorder.captured.map((input) => input.state)).toEqual(['IGNORED']);
      expect(outcome.snapshot.committed[0]?.evidence.outboxMessages).toEqual([]);
    }),
  );

  it.effect('#1157 an already stored delivery is DUPLICATE and enqueues nothing again', () =>
    Effect.gen(function* duplicate() {
      const outcome = yield* capture({
        owner: fakeServices(authentic(true), newRecorder(), { stored: 'EXISTING' }),
      });
      expect(summaryOf(outcome)).toEqual(['DUPLICATE', NOTIFICATION_ID]);
      expect(outcome.snapshot.committed[0]?.evidence.outboxMessages).toEqual([]);
    }),
  );

  it.effect('#1157 a rejected or unbound notification stores nothing; an unavailable gateway fails the capture', () =>
    Effect.gen(function* refusals() {
      const rejectedRecorder = newRecorder();
      const rejected = yield* capture({ owner: fakeServices(RejectedVerdict.make({}), rejectedRecorder) });
      expect(summaryOf(rejected)).toEqual(['REJECTED', 'SIGNATURE_INVALID']);
      expect(rejectedRecorder.captured).toEqual([]);

      const unknownRecorder = newRecorder();
      const unknown = yield* capture({
        owner: fakeServices(authentic(true), unknownRecorder, { bindingKnown: false }),
      });
      expect(summaryOf(unknown)).toEqual(['REJECTED', 'BINDING_UNKNOWN']);
      expect([unknownRecorder.verified, unknownRecorder.captured]).toEqual([[], []]);

      // No ACK for what was not durably recorded: the relay receives a retryable failure.
      const unavailableRecorder = newRecorder();
      const unavailable = yield* capture({
        owner: fakeServices(UnavailableVerdict.make({}), unavailableRecorder),
      });
      expect(failureTagsOf(unavailable)).toEqual(['PaymentUnavailable']);
      expect(unavailable.snapshot.committed).toEqual([]);
      expect(unavailableRecorder.captured).toEqual([]);
    }),
  );

  it.effect('#1157 Tenant cannot be selected from webhook fields', () =>
    Effect.gen(function* noScopeFields() {
      for (const smuggled of [
        { tenantId: '99999999-9999-4999-8999-999999999999' },
        { legalEntityId: '99999999-9999-4999-8999-999999999999' },
        { receivedAt: '2020-01-01T00:00:00Z' },
      ]) {
        const recorder = newRecorder();
        const outcome = yield* capture({ owner: fakeServices(authentic(true), recorder) }, relayPayload(smuggled));
        expect(failureTagsOf(outcome)).toEqual(['ActionPayloadValidationError']);
        expect(outcome.snapshot.stages).not.toContain('handler_executed');
        expect([recorder.queries, recorder.captured]).toEqual([[], []]);
      }
    }),
  );
});

describe('#1157 / #1153 owner recheck of the provider binding route', () => {
  it.effect('#1157 a capture without a verified route scope is refused before anything is read or written', () =>
    Effect.gen(function* withoutRouteScope() {
      const recorder = newRecorder();
      const outcome = yield* capture({
        owner: fakeServices(authentic(true), recorder),
        principal: () => apiKeyPrincipalOf(RELAY),
      });
      expect(failureTagsOf(outcome)).toEqual(['PaymentUnavailable']);
      expect(outcome.snapshot.committed).toEqual([]);
      expect([recorder.routeReads, recorder.queries, recorder.verified, recorder.captured]).toEqual([[], [], [], []]);
    }),
  );

  it.effect('#1157 the binding is resolved by the signed source route, never by the payload alone', () =>
    Effect.gen(function* signedRouteDecides() {
      const recorder = newRecorder();
      const outcome = yield* capture({ owner: fakeServices(authentic(true), recorder) });
      expect(summaryOf(outcome)).toEqual(['CAPTURED', NOTIFICATION_ID]);
      expect(recorder.routeReads).toEqual([BINDING_ID]);
    }),
  );

  it.effect('#1157 Mismatched binding cannot affect another merchant', () =>
    Effect.gen(function* mismatchedBinding() {
      const otherRoute: BoundProviderBindingRoute = {
        ...bindingRoute,
        bindingId: Schema.decodeUnknownSync(GatewayExecutionTargetSchema.fields.bindingId)(OTHER_BINDING_ID),
        providerAccountRef: `pab_${'b'.repeat(32)}`,
      };
      const cases = [
        // The route of another merchant's binding, with this binding's account ref in the payload.
        {
          owner: { routes: { [OTHER_BINDING_ID]: otherRoute } },
          principal: (compositionRevision: string) =>
            routedPrincipal({ bindingId: OTHER_BINDING_ID, compositionRevision }),
        },
        // A signed binding that has no route in this scope.
        { owner: { routes: {} }, principal: (compositionRevision: string) => routedPrincipal({ compositionRevision }) },
        // A stale or foreign route revision, and a route scope of another route key.
        {
          owner: {},
          principal: (compositionRevision: string) => routedPrincipal({ compositionRevision, routeRevision: 2 }),
        },
        {
          owner: {},
          principal: (compositionRevision: string) =>
            routedPrincipal({ compositionRevision, overrides: { routeKey: 'symmy-route' } }),
        },
        // The routed binding is found, but the resolver answers a different binding.
        {
          owner: {
            target: Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
              ...Schema.encodeSync(GatewayExecutionTargetSchema)(target),
              bindingId: OTHER_BINDING_ID,
            }),
          },
          principal: (compositionRevision: string) => routedPrincipal({ compositionRevision }),
        },
      ] as const;
      for (const row of cases) {
        const recorder = newRecorder();
        const outcome = yield* capture({
          owner: fakeServices(authentic(true), recorder, row.owner),
          principal: row.principal,
        });
        expect(summaryOf(outcome)).toEqual(['REJECTED', 'BINDING_UNKNOWN']);
        expect([recorder.verified, recorder.captured]).toEqual([[], []]);
        expect(outcome.snapshot.committed[0]?.evidence.outboxMessages).toEqual([]);
      }
    }),
  );

  it.effect('#1155 Callback cannot cross provider environments', () =>
    Effect.gen(function* environmentFixedByRoute() {
      // The SANDBOX binding's route never admits a LIVE payload, nor another family's.
      for (const payload of [
        { ...relayPayload(), environment: 'LIVE' },
        { ...relayPayload(), family: 'GOPAY' },
        { ...relayPayload(), providerAccountRef: `pab_${'c'.repeat(32)}` },
      ]) {
        const recorder = newRecorder();
        const outcome = yield* capture({ owner: fakeServices(authentic(true), recorder) }, payload);
        expect(summaryOf(outcome)).toEqual(['REJECTED', 'BINDING_UNKNOWN']);
        expect([recorder.queries, recorder.verified, recorder.captured]).toEqual([[], [], []]);
      }
    }),
  );
});

describe('#1153 / #1159 Core admission of the capture', () => {
  it.effect('#1153 Capture is refused while the module is suspended/read_only/quarantined', () =>
    Effect.gen(function* moduleStateRefusal() {
      for (const moduleState of ['suspended', 'read_only', 'quarantined'] as const) {
        const recorder = newRecorder();
        const outcome = yield* capture({ moduleState, owner: fakeServices(authentic(true), recorder) });
        expect(failureTagsOf(outcome)).toEqual(['ModuleStateDeniedError']);
        expect(outcome.snapshot.stages).not.toContain('handler_executed');
        expect([recorder.queries, recorder.captured]).toEqual([[], []]);
      }
      const active = yield* capture({ moduleState: 'active', owner: fakeServices(authentic(true), newRecorder()) });
      expect(summaryOf(active)).toEqual(['CAPTURED', NOTIFICATION_ID]);
    }),
  );

  it.effect('#1159 Capture with an unbound workload principal is denied', () =>
    Effect.gen(function* unboundWorkload() {
      const cases = [
        { admitted: true, keys: [INGRESS_WORKLOAD], kind: 'integration' },
        { admitted: false, keys: [], kind: 'integration' },
        { admitted: false, keys: ['payment.provider-reconciliation'], kind: 'integration' },
        { admitted: false, keys: [INGRESS_WORKLOAD], kind: 'human' },
      ] as const;
      for (const row of cases) {
        const recorder = newRecorder();
        const outcome = yield* capture({
          accessDecision: workloadGate(row.kind, row.keys),
          owner: fakeServices(authentic(true), recorder),
        });
        expect([row.kind, row.keys, Exit.isSuccess(outcome.exit)]).toEqual([row.kind, row.keys, row.admitted]);
        expect(outcome.snapshot.stages.includes('handler_executed')).toBe(row.admitted);
        expect(recorder.captured).toHaveLength(row.admitted ? 1 : 0);
      }
    }),
  );
});
