import { randomUUID } from 'node:crypto';

import { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { ConfigProvider, Context, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makePaymentApiRuntime } from '../../api/index.ts';
import { paymentUnavailableOwnerPortsLive } from '../../api/payment-production-layers.ts';
import type { ConfigurePaymentMethodEnablementPayloadSchema } from '../../shared/actions/configure-payment-method-enablement.ts';
import type { PaymentMethodApplicabilityRequestSchema } from '../../shared/apis/payment-method-applicability.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { CommitmentOutcomePort, unavailableCommitmentOutcome } from '../../src/ports/commitment-outcome-port.ts';
import { DeliveryCapabilityPort, unavailableDeliveryCapability } from '../../src/ports/delivery-capability-port.ts';
import { GatewayBindingPort, unavailableGatewayBinding } from '../../src/ports/gateway-binding-port.ts';
import { PaymentTermEvidencePort, unavailablePaymentTermEvidence } from '../../src/ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort, unavailablePickupCapability } from '../../src/ports/pickup-capability-port.ts';
import { RefundableItemsPort, unavailableRefundableItems } from '../../src/ports/refundable-items-port.ts';

/**
 * Handler requirements reach the HTTP layer only as `HttpRouter.Request<'Requires', _>`, which the BFF
 * assembly accepts without proof, and governed Read requirements are not typed at the transport at all.
 * These tests prove at run time, through the real `makePaymentApiRuntime`, that owner evidence ports
 * merged into the Core runtimes (as api/index.ts merges `paymentUnavailableOwnerPortsLive`) are present
 * where Action and Read handlers run.
 *
 * The request bodies must decode against the route's public payload; they are typed by the encoded
 * schemas, so replacing the placeholder schema of `configure-payment-method-enablement` or
 * `payment-method-applicability` fails typecheck here until the owning lane supplies a valid request.
 */
const actionPath = '/payment/actions/configure-payment-method-enablement';
const actionBody: typeof ConfigurePaymentMethodEnablementPayloadSchema.Encoded = {
  customerConfigurationId: 'customer-configuration-composition',
  enabled: true,
  method: 'BANK_TRANSFER_ADVANCE',
  reason: 'Composition proof enablement',
};
const readPath = '/reads/payment-method-applicability';
const readBody: typeof PaymentMethodApplicabilityRequestSchema.Encoded = {
  amount: { amountMinor: 10_000, currency: 'CZK' },
  branches: [{ method: 'BANK_TRANSFER_ADVANCE' }],
  customerConfigurationId: 'customer-configuration-composition',
  paymentTermRef: {
    moduleId: 'payment.term-catalog',
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'payment.term-catalog.payment-term',
    tenantId: '11111111-1111-4111-8111-111111111111',
  },
  purchasingContext: {
    channelId: 'channel-b2b',
    contextRef: 'purchasing-context-1',
    contextRevision: 'revision-1',
    marketId: 'market-cz',
    subject: { guestEvidenceRef: 'guest-evidence-1', guestSessionRef: 'guest-session-1', kind: 'GUEST' },
  },
};

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const principal = {
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'better-auth-session:payment-foundation-composition-test',
  authMethod: 'session',
  principalId,
  tenantId,
} as const;
const stopped = 'stopped after composition proof';

type PaymentOwnerPortsLayer = Layer.Layer<Layer.Success<typeof paymentUnavailableOwnerPortsLive>>;

const ownerPortsIn = (context: Context.Context<never>) => ({
  commitment: Context.getOrUndefined(context, CommitmentOutcomePort),
  delivery: Context.getOrUndefined(context, DeliveryCapabilityPort),
  gateway: Context.getOrUndefined(context, GatewayBindingPort),
  pickup: Context.getOrUndefined(context, PickupCapabilityPort),
  refundableItems: Context.getOrUndefined(context, RefundableItemsPort),
  term: Context.getOrUndefined(context, PaymentTermEvidencePort),
});
type ObservedOwnerPorts = ReturnType<typeof ownerPortsIn>;

const unavailableOwnerPorts = {
  commitment: unavailableCommitmentOutcome,
  delivery: unavailableDeliveryCapability,
  gateway: unavailableGatewayBinding,
  pickup: unavailablePickupCapability,
  refundableItems: unavailableRefundableItems,
  term: unavailablePaymentTermEvidence,
};

const captureRuntimes = () => {
  const actionSeen: ObservedOwnerPorts[] = [];
  const readSeen: ObservedOwnerPorts[] = [];
  const actionRuntime: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('not needed in composition proof'),
    resolveActionExecution: () => Effect.die('not needed in composition proof'),
    runAction: () =>
      Effect.context().pipe(
        Effect.flatMap((context) => {
          actionSeen.push(ownerPortsIn(context));
          return Effect.die(stopped);
        }),
      ),
  };
  const readRuntime: ReadRuntimeService = {
    runRead: () =>
      Effect.context().pipe(
        Effect.flatMap((context) => {
          readSeen.push(ownerPortsIn(context));
          return Effect.die(stopped);
        }),
      ),
  };
  return { actionRuntime, actionSeen, readRuntime, readSeen };
};

const mountPaymentTransport = Effect.fn('PaymentFoundationCompositionTest.mount')(function* mount(
  actionRuntime: ActionRuntimeService,
  readRuntime: ReadRuntimeService,
  ownerPorts: PaymentOwnerPortsLayer,
) {
  const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(
    ['payment'],
    ultramodernApiMarker.buildMarker,
  );
  const compositionDocument = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(compositionSnapshot);
  const issuer = 'https://shell.payment-foundation-composition.test';
  const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
  const publicJwk = {
    ...(yield* Effect.promise(() => exportJWK(publicKey))),
    alg: 'EdDSA',
    kid: 'payment-foundation-composition-test',
    use: 'sig',
  };
  const assembled = makePaymentApiRuntime(
    Layer.succeed(ReadRuntime, readRuntime).pipe(Layer.provideMerge(ownerPorts)),
    Layer.mergeAll(
      Layer.succeed(ActionRuntime, actionRuntime),
      Layer.succeed(ActiveApplicationCompositionSource, { load: Effect.succeed(compositionDocument) }),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            keys: [publicJwk],
          }),
        }),
      ),
    ).pipe(Layer.provideMerge(ownerPorts)),
    Layer.succeed(GatewayAssertionRedemptionService, { consume: () => Effect.void }),
  );
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => assembled.createHandler()),
    (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
  );
  return Effect.fn('PaymentFoundationCompositionTest.post')(function* post(
    path: string,
    body: typeof actionBody | typeof readBody,
  ) {
    const token = yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: compositionSnapshot.composition.revision,
        principal,
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: 1,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('payment')
        .setSubject(principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(randomUUID())
        .sign(privateKey),
    );
    return yield* Effect.promise(() =>
      runtime.handler(
        new Request(`http://localhost${path}`, {
          body: JSON.stringify(body),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            'x-correlation-id': 'payment-foundation-composition',
          },
          method: 'POST',
        }),
      ),
    );
  });
});

it.live('#1145 production composition gives Action and Read handlers the fail-closed owner evidence ports', () =>
  Effect.gen(function* verifyUnavailableOwnerPortComposition() {
    const { actionRuntime, actionSeen, readRuntime, readSeen } = captureRuntimes();
    const post = yield* mountPaymentTransport(actionRuntime, readRuntime, paymentUnavailableOwnerPortsLive);

    const actionResponse = yield* post(actionPath, actionBody);
    const readResponse = yield* post(readPath, readBody);

    expect(actionResponse.status).toBe(500);
    expect(readResponse.status).toBe(500);
    expect(actionSeen).toStrictEqual([unavailableOwnerPorts]);
    expect(readSeen).toStrictEqual([unavailableOwnerPorts]);
  }),
);

it.live('#1145 owner evidence fixtures supplied to the runtimes replace the fail-closed defaults', () =>
  Effect.gen(function* verifyFixtureOwnerPortComposition() {
    const gatewayFixture = { ...unavailableGatewayBinding };
    const ownerPorts: PaymentOwnerPortsLayer = Layer.mergeAll(
      Layer.succeed(PaymentTermEvidencePort, unavailablePaymentTermEvidence),
      Layer.succeed(GatewayBindingPort, gatewayFixture),
      Layer.succeed(DeliveryCapabilityPort, unavailableDeliveryCapability),
      Layer.succeed(PickupCapabilityPort, unavailablePickupCapability),
      Layer.succeed(CommitmentOutcomePort, unavailableCommitmentOutcome),
      Layer.succeed(RefundableItemsPort, unavailableRefundableItems),
    );
    const { actionRuntime, actionSeen, readRuntime, readSeen } = captureRuntimes();
    const post = yield* mountPaymentTransport(actionRuntime, readRuntime, ownerPorts);

    yield* post(actionPath, actionBody);
    yield* post(readPath, readBody);

    expect(actionSeen).toHaveLength(1);
    expect(readSeen).toHaveLength(1);
    expect(actionSeen[0]?.gateway).toBe(gatewayFixture);
    expect(readSeen[0]?.gateway).toBe(gatewayFixture);
  }),
);
