import {
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionService,
  makeActiveApplicationCompositionService,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import { makeTestAccessGateLayers, testAccessSpecOf } from '@app/core-runtime/testing/access-gate';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { assert, describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makeInventoryApiRuntime } from '../../api/index.ts';
import { EndExternalStockCorrelationPayloadSchema } from '../../shared/actions/end-external-stock-correlation.ts';
import { EstablishExternalStockCorrelationPayloadSchema } from '../../shared/actions/establish-external-stock-correlation.ts';
import { ImportSourceAssertionPayloadSchema } from '../../shared/actions/import-source-assertion.ts';
import { SelectInventoryBackendPayloadSchema } from '../../shared/actions/select-inventory-backend.ts';
import {
  EndExternalStockCorrelationActionForbiddenProblemSchema,
  EndExternalStockCorrelationActionInvalidProblemSchema,
  EndExternalStockCorrelationActionPreconditionProblemSchema,
} from '../../shared/apis/end-external-stock-correlation-action.ts';
import {
  EstablishExternalStockCorrelationActionForbiddenProblemSchema,
  EstablishExternalStockCorrelationActionInvalidProblemSchema,
  EstablishExternalStockCorrelationActionPreconditionProblemSchema,
} from '../../shared/apis/establish-external-stock-correlation-action.ts';
import {
  ImportSourceAssertionActionForbiddenProblemSchema,
  ImportSourceAssertionActionInvalidProblemSchema,
  ImportSourceAssertionActionPreconditionProblemSchema,
} from '../../shared/apis/import-source-assertion-action.ts';
import {
  InventorySourceImportReceiptForbiddenProblemSchema,
  InventorySourceImportReceiptRequestSchema,
} from '../../shared/apis/inventory-source-import-receipt.ts';
import {
  SelectInventoryBackendActionForbiddenProblemSchema,
  SelectInventoryBackendActionInvalidProblemSchema,
  SelectInventoryBackendActionPreconditionProblemSchema,
} from '../../shared/apis/select-inventory-backend-action.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { selectInventoryBackendAction } from '../../src/actions/select-inventory-backend.action.ts';
import { executeEndExternalStockCorrelationWithAuthorization } from '../../src/api/end-external-stock-correlation-action-client.ts';
import { executeEstablishExternalStockCorrelationWithAuthorization } from '../../src/api/establish-external-stock-correlation-action-client.ts';
import { executeImportSourceAssertionWithAuthorization } from '../../src/api/import-source-assertion-action-client.ts';
import { executeInventorySourceImportReceiptWithAuthorization } from '../../src/api/inventory-source-import-receipt-client.ts';
import { executeSelectInventoryBackendWithAuthorization } from '../../src/api/select-inventory-backend-action-client.ts';
import type { InventoryBackendConfigurationPersistence } from '../../src/persistence/inventory-backend-configuration-repository.ts';
import { makeInventoryBackendConfigurationService } from '../../src/services/inventory-backend-configuration.service.ts';
import { inventoryRegistration } from '../../vertical.registration.ts';
import { sourceImportCompositionFixture } from '../support/source-import-composition.fixture.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '66666666-6666-4666-8666-666666666666';
const principal = {
  authBindingId: principalId,
  authContextRef: 'better-auth-session:test',
  authMethod: 'session',
  principalId,
  tenantId,
} as const;
const ref = (resourceType: string, resourceId: string) =>
  ({ moduleId: 'commerce.inventory', resourceId, resourceType, tenantId }) as const;
const positionRef = ref('commerce.inventory.stock-position', '88888888-8888-4888-8888-888888888888');
const issuer = { backendId: 'erp-request-headers', backendKind: 'external_business_system' } as const;
const externalKey = (identifierKind: 'ITEM' | 'LOCATION', externalValue: string) => ({
  customerConfigurationId: 'request-headers',
  externalScope: 'erp-company:main',
  externalValue,
  identifierKind,
  issuer,
  namespace: 'erp-stock',
  tenantId,
});
const observedAt = '2026-11-20T12:00:00.000Z';
const proposal = {
  assertionId: '99999999-9999-4999-8999-999999999999',
  businessObservedAt: observedAt,
  coverage: [],
  customerConfigurationId: 'request-headers',
  factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
  issuer,
  itemExternalKey: externalKey('ITEM', 'SKU-1'),
  locationExternalKey: externalKey('LOCATION', 'WH-MAIN'),
  orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '1' },
  ownerEvidenceRef: 'erp-stock:snapshot:1',
  positionRef,
  quantity: {
    amount: '12',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  receivedAt: observedAt,
  sourceReference: 'erp-stock:snapshot:1',
} as const;

// The registered Read runtime takes evidence identifiers from Crypto; each live test builds Node Crypto in its scope.
const nodeCrypto = Layer.build(NodeCrypto.layer).pipe(Effect.map((context) => Context.get(context, Crypto.Crypto)));

interface SentRequest {
  readonly body: string;
  readonly headers: Headers;
}
/** What reaches the registered runtime: the generated client's own request, or that request with one change. */
type Exchange = (sent: SentRequest) => SentRequest;
const asSent: Exchange = (sent) => sent;
const replaceHeaders = (sent: SentRequest, change: (headers: Headers) => void): SentRequest => {
  const headers = new Headers(sent.headers);
  change(headers);
  return { body: sent.body, headers };
};
const withoutIdempotencyKey: Exchange = (sent) => replaceHeaders(sent, (headers) => headers.delete('idempotency-key'));
const withIdempotencyKey =
  (value: string): Exchange =>
  (sent) =>
    replaceHeaders(sent, (headers) => headers.set('idempotency-key', value));
const withProposalIntent: Exchange = (sent) =>
  replaceHeaders(sent, (headers) => headers.set('x-action-intent', 'propose'));
const withUnknownIntent: Exchange = (sent) =>
  replaceHeaders(sent, (headers) => headers.set('x-action-intent', 'approve'));
const withTraceId =
  (value: string): Exchange =>
  (sent) =>
    replaceHeaders(sent, (headers) => headers.set('x-trace-id', value));
const withUndeclaredPayloadField: Exchange = (sent) => ({
  body: `{"undeclaredField":true,${sent.body.slice(1)}`,
  headers: sent.headers,
});

/**
 * The registered Inventory API runtime with the real Action and Read lifecycles over scripted storage. Unless a test
 * scripts another answer, the access gate denies every operation, so a request that reaches its handler is
 * authenticated, enters the runtime and is refused there; nothing is written.
 */
const makeRegisteredInventory = Effect.fn('InventoryRequestHeadersTest.make')(function* makeRegisteredInventory(
  gate: Pick<ActionTestHarnessOptions, 'access' | 'mandateDispatch' | 'services'> = {},
) {
  const composition = yield* sourceImportCompositionFixture;
  const { revision } = composition.composition;
  const compositionDocument = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(composition);
  const tokenIssuer = 'https://shell.inventory-request-headers.test';
  const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
  const publicJwk = {
    ...(yield* Effect.promise(() => exportJWK(publicKey))),
    alg: 'EdDSA',
    kid: 'inventory-request-headers',
    use: 'sig',
  };
  const issuedAt = Math.floor((yield* DateTime.nowAsDate).getTime() / 1000);
  const jti = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  const token = yield* Effect.promise(() =>
    new SignJWT({
      compositionRevision: revision,
      principal,
      targetBuildMarker: ultramodernApiMarker.buildMarker,
      ver: 1,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid, typ: 'JWT' })
      .setIssuer(tokenIssuer)
      .setAudience('inventory')
      .setSubject(principalId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
      .setJti(jti)
      .sign(privateKey),
  );
  const actions = yield* makeActionTestHarness({
    ...gate,
    applicationComposition: makeActiveApplicationCompositionService(Effect.succeed(composition)),
    expectedDeployment: ultramodernApiMarker,
    ownerRegistration: inventoryRegistration,
  });
  const reads = yield* makeReadTestHarness({
    access: 'denied',
    compositionRevision: revision,
    executeOwnerQuery: () => Effect.die('A denied Read runs no owner query'),
    operationTime: new Date(observedAt),
    ownerRegistration: inventoryRegistration,
    scope: { ...trustVerifiedGatewayPrincipalContext(principal, revision), correlationId: 'request-headers' },
  });
  // The demo line's owner approval provider, which the registered runtime requires beside its Action runtime; it
  // answers from the same scripted access as the Actions.
  const accessServices = yield* Layer.build(makeTestAccessGateLayers({ spec: testAccessSpecOf(gate.access) }));
  const ownerApprovals = yield* Layer.build(
    makeOwnerActionApprovalsLive(ultramodernApiMarker, inventoryRegistration).pipe(
      Layer.provide(
        Layer.mergeAll(
          reads.ownerServices,
          Layer.succeedContext(accessServices),
          Layer.succeed(Crypto.Crypto, yield* Crypto.Crypto),
          Layer.succeed(
            ActiveApplicationCompositionService,
            makeActiveApplicationCompositionService(Effect.succeed(composition)),
          ),
        ),
      ),
    ),
  );
  let redemptions = 0;
  const assembled = makeInventoryApiRuntime(
    reads.layer,
    Layer.mergeAll(
      actions.layer,
      Layer.succeedContext(ownerApprovals),
      Layer.succeed(ActiveApplicationCompositionSource, { load: Effect.succeed(compositionDocument) }),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: tokenIssuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            keys: [publicJwk],
          }),
        }),
      ),
    ),
    // Authentication redeems the assertion inside the handler, so each redemption is one request that reached it.
    Layer.succeed(GatewayAssertionRedemptionService, {
      consume: () =>
        Effect.sync(() => {
          redemptions += 1;
        }),
    }),
  );
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => assembled.createHandler()),
    (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
  );
  const delivered: { readonly headers: readonly string[]; readonly status: number }[] = [];
  const fetchThrough =
    (exchange: Exchange): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init);
      const { body, headers } = exchange({ body: await request.text(), headers: request.headers });
      const response = await runtime.handler(new Request(request.url, { body, headers, method: request.method }));
      delivered.push({ headers: [...headers.keys()], status: response.status });
      return response;
    };
  return {
    /** The answer as a Result, for a request that may succeed. */
    attempt: <Success, Failure, Requirements>(
      exchange: Exchange,
      call: (authorization: string) => Effect.Effect<Success, Failure, Requirements>,
    ) =>
      call(`Bearer ${token}`).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchThrough(exchange)), Effect.result),
    send: <Success, Failure, Requirements>(
      exchange: Exchange,
      call: (authorization: string) => Effect.Effect<Success, Failure, Requirements>,
    ) =>
      call(`Bearer ${token}`).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchThrough(exchange)), Effect.flip),
    snapshot: () => ({ actions: actions.snapshot(), delivered: [...delivered], redemptions }),
  };
});

const clientOptions = (idempotencyKey: string) => ({ baseUrl: 'https://inventory.example', idempotencyKey });

interface ActionCase {
  readonly call: (authorization: string, idempotencyKey: string) => Effect.Effect<unknown, unknown>;
  readonly forbidden: Schema.Constraint;
  readonly invalid: Schema.Constraint;
  readonly name: string;
  readonly precondition: Schema.Constraint;
}

const selectBackend = (authorization: string, idempotencyKey: string) =>
  Schema.decodeUnknownEffect(SelectInventoryBackendPayloadSchema)({
    authorizationTargetRef: ref(
      'commerce.inventory.inventory-backend-configuration',
      '33333333-3333-4333-8333-333333333333',
    ),
    customerConfigurationId: 'request-headers',
    selection: {
      backend: issuer.backendKind,
      backendId: issuer.backendId,
      exactReservationCapability: 'UNSUPPORTED',
      stockCorrectionCapability: 'UNSUPPORTED',
    },
  }).pipe(
    Effect.flatMap((payload) =>
      executeSelectInventoryBackendWithAuthorization(payload, authorization, 'select', clientOptions(idempotencyKey)),
    ),
  );

const actionCases: readonly ActionCase[] = [
  {
    call: selectBackend,
    forbidden: SelectInventoryBackendActionForbiddenProblemSchema,
    invalid: SelectInventoryBackendActionInvalidProblemSchema,
    name: 'select-inventory-backend',
    precondition: SelectInventoryBackendActionPreconditionProblemSchema,
  },
  {
    call: (authorization, idempotencyKey) =>
      Schema.decodeUnknownEffect(EstablishExternalStockCorrelationPayloadSchema)({
        correlationRef: ref('commerce.inventory.external-stock-correlation', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        effectiveFrom: observedAt,
        externalKey: externalKey('ITEM', 'SKU-1'),
        ownerEvidenceRef: 'erp-stock:ITEM:SKU-1',
        target: {
          _tag: 'STOCK_ITEM',
          ref: ref('commerce.inventory.stock-item', '22222222-2222-4222-8222-222222222222'),
        },
      }).pipe(
        Effect.flatMap((payload) =>
          executeEstablishExternalStockCorrelationWithAuthorization(
            payload,
            authorization,
            'correlate',
            clientOptions(idempotencyKey),
          ),
        ),
      ),
    forbidden: EstablishExternalStockCorrelationActionForbiddenProblemSchema,
    invalid: EstablishExternalStockCorrelationActionInvalidProblemSchema,
    name: 'establish-external-stock-correlation',
    precondition: EstablishExternalStockCorrelationActionPreconditionProblemSchema,
  },
  {
    call: (authorization, idempotencyKey) =>
      Schema.decodeUnknownEffect(EndExternalStockCorrelationPayloadSchema)({
        correlationRef: ref('commerce.inventory.external-stock-correlation', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        endedAt: observedAt,
        externalKey: externalKey('ITEM', 'SKU-1'),
      }).pipe(
        Effect.flatMap((payload) =>
          executeEndExternalStockCorrelationWithAuthorization(
            payload,
            authorization,
            'end-correlation',
            clientOptions(idempotencyKey),
          ),
        ),
      ),
    forbidden: EndExternalStockCorrelationActionForbiddenProblemSchema,
    invalid: EndExternalStockCorrelationActionInvalidProblemSchema,
    name: 'end-external-stock-correlation',
    precondition: EndExternalStockCorrelationActionPreconditionProblemSchema,
  },
  {
    call: (authorization, idempotencyKey) =>
      Schema.decodeUnknownEffect(ImportSourceAssertionPayloadSchema)({
        authorizationTargetRef: positionRef,
        items: [proposal],
      }).pipe(
        Effect.flatMap((payload) =>
          executeImportSourceAssertionWithAuthorization(
            payload,
            authorization,
            'import',
            clientOptions(idempotencyKey),
          ),
        ),
      ),
    forbidden: ImportSourceAssertionActionForbiddenProblemSchema,
    invalid: ImportSourceAssertionActionInvalidProblemSchema,
    name: 'import-source-assertion',
    precondition: ImportSourceAssertionActionPreconditionProblemSchema,
  },
];

const readReceipt = (authorization: string) =>
  Schema.decodeUnknownEffect(InventorySourceImportReceiptRequestSchema)({
    actionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    itemIndex: 0,
    proposal,
  }).pipe(
    Effect.flatMap((payload) =>
      executeInventorySourceImportReceiptWithAuthorization(payload, authorization, 'receipt', {
        baseUrl: 'https://inventory.example',
      }),
    ),
  );

describe('Inventory HTTP requests with transport headers', () => {
  for (const action of actionCases) {
    it.live(`${action.name} reaches its handler; a missing idempotency key and an undeclared field are refused`, () =>
      Effect.gen(function* actionRequestHeaders() {
        const inventory = yield* makeRegisteredInventory();

        // The generated client sends authorization, content-type and x-correlation-id beside its idempotency key.
        const sent = yield* inventory.send(asSent, (authorization) => action.call(authorization, 'sent-key'));
        expect(Schema.is(action.forbidden)(sent)).toBe(true);
        expect(sent).toMatchObject({ code: 'action_permission_denied', status: 403 });
        const reached = inventory.snapshot();
        expect(reached.delivered[0]?.headers).toEqual(
          expect.arrayContaining(['authorization', 'content-type', 'idempotency-key', 'x-correlation-id']),
        );
        expect(reached.redemptions).toBe(1);
        expect(reached.actions.invocations.map((invocation) => invocation.idempotencyKey)).toEqual(['sent-key']);

        // Without the key the request still reaches the runtime, which refuses it before any invocation exists.
        const missingKey = yield* inventory.send(withoutIdempotencyKey, (authorization) =>
          action.call(authorization, 'removed-key'),
        );
        expect(Schema.is(action.precondition)(missingKey)).toBe(true);
        expect(missingKey).toMatchObject({ status: 428 });
        expect(inventory.snapshot().redemptions).toBe(2);
        expect(inventory.snapshot().actions.invocations).toHaveLength(1);

        // The declared header keeps its bounds, and the payload codec still refuses an undeclared field, both
        // before the handler authenticates anything.
        const { stages } = inventory.snapshot().actions;
        const overlongKey = yield* inventory.send(withIdempotencyKey('k'.repeat(201)), (authorization) =>
          action.call(authorization, 'replaced-key'),
        );
        expect(Schema.is(action.invalid)(overlongKey)).toBe(true);
        const undeclared = yield* inventory.send(withUndeclaredPayloadField, (authorization) =>
          action.call(authorization, 'undeclared-key'),
        );
        expect(Schema.is(action.invalid)(undeclared)).toBe(true);

        // The request mode is a closed literal and the trace identifier is bounded like the key: any other intent
        // and an overlong trace identifier are refused, never ignored.
        const unknownIntent = yield* inventory.send(withUnknownIntent, (authorization) =>
          action.call(authorization, 'unknown-intent-key'),
        );
        expect(Schema.is(action.invalid)(unknownIntent)).toBe(true);
        const overlongTrace = yield* inventory.send(withTraceId('t'.repeat(201)), (authorization) =>
          action.call(authorization, 'overlong-trace-key'),
        );
        expect(Schema.is(action.invalid)(overlongTrace)).toBe(true);
        expect(inventory.snapshot().redemptions).toBe(2);
        expect(inventory.snapshot().actions.stages).toEqual(stages);
      }).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
    );
  }

  it.live('inventory-source-import-receipt reaches its handler and still refuses an undeclared field', () =>
    Effect.gen(function* readRequestHeaders() {
      const inventory = yield* makeRegisteredInventory();

      const sent = yield* inventory.send(asSent, readReceipt);
      expect(Schema.is(InventorySourceImportReceiptForbiddenProblemSchema)(sent)).toBe(true);
      expect(inventory.snapshot().delivered[0]).toEqual({
        headers: expect.arrayContaining(['authorization', 'content-type', 'x-correlation-id']),
        status: 403,
      });
      expect(inventory.snapshot().redemptions).toBe(1);

      // The payload codec refuses an undeclared field before the handler authenticates anything.
      yield* inventory.send(withUndeclaredPayloadField, readReceipt);
      expect(inventory.snapshot().delivered[1]?.status).toBe(400);
      expect(inventory.snapshot().redemptions).toBe(1);
    }).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
  );
});

/** A proposal store that holds no parked proposal; parking or executing a mandate through it fails the test. */
const noParkedProposal: NonNullable<ActionTestHarnessOptions['mandateDispatch']> = {
  claim: () => Effect.die('A proposal request claims no mandate'),
  commit: () => Effect.die('A proposal request commits no mandate'),
  loadParkedProposal: () => Effect.succeed(Option.none()),
  parkProposal: () => Effect.die('An allowed proposal request parks nothing'),
  prepare: () => Effect.die('A proposal request prepares no mandate'),
};

describe('Inventory HTTP requests asking for a proposal', () => {
  it.live('select-inventory-backend answers only results, so a proposal request is refused before it can write', () =>
    Effect.gen(function* resultOnlyProposal() {
      let writes = 0;
      const persistence: InventoryBackendConfigurationPersistence = {
        findCurrent: () => Effect.succeed(Option.none()),
        insertInitial: (configuration) =>
          Effect.sync(() => {
            writes += 1;
            return { configuration, outcome: 'INSERTED' as const };
          }),
      };
      const inventory = yield* makeRegisteredInventory({
        access: 'allowed',
        services: [
          bindActionTestServices(selectInventoryBackendAction, makeInventoryBackendConfigurationService(persistence)),
        ],
      });

      // The endpoint declares no proposal answer, so Core refuses the intent before an invocation exists.
      const proposed = yield* inventory.attempt(withProposalIntent, (authorization) =>
        selectBackend(authorization, 'propose-key'),
      );
      expect(writes).toBe(0);
      expect(inventory.snapshot().actions).toMatchObject({ committed: [], invocations: [], permissionDenials: [] });
      assert(Result.isFailure(proposed));
      expect(proposed.failure).toMatchObject({ code: 'action_permission_denied', status: 403 });
      expect(Schema.is(SelectInventoryBackendActionForbiddenProblemSchema)(proposed.failure)).toBe(true);

      // The same request without the intent is an ordinary run that the allowing gate admits to the writer.
      const ran = yield* inventory.attempt(asSent, (authorization) => selectBackend(authorization, 'run-key'));
      expect(Result.isSuccess(ran)).toBe(true);
      expect(writes).toBe(1);
    }).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
  );

  for (const action of actionCases.filter(({ name }) => name !== 'select-inventory-backend')) {
    it.live(`${action.name} hands a proposal request to Core, which refuses an unneeded one before any handler`, () =>
      Effect.gen(function* proposableProposal() {
        const inventory = yield* makeRegisteredInventory({ access: 'allowed', mandateDispatch: noParkedProposal });

        // The allowing gate refuses an explicit proposal it does not need, so nothing gets past the permission check.
        const proposed = yield* inventory.send(withProposalIntent, (authorization) =>
          action.call(authorization, 'propose-key'),
        );
        expect(proposed).toMatchObject({ code: 'action_permission_denied', status: 403 });
        expect(Schema.is(action.forbidden)(proposed)).toBe(true);
        const refused = inventory.snapshot().actions;
        expect(refused.permissionDenials.map(({ transport }) => transport.idempotencyKey)).toEqual(['propose-key']);
        expect(refused.stages.at(-1)).toBe('permission_checked');

        // The same request without the intent is an ordinary run that passes the same gate.
        yield* inventory.attempt(asSent, (authorization) => action.call(authorization, 'run-key'));
        const ran = inventory.snapshot().actions;
        expect(ran.permissionDenials).toHaveLength(1);
        expect(ran.stages.slice(refused.stages.length)).toContain('policy_boundary');
      }).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
    );
  }
});
