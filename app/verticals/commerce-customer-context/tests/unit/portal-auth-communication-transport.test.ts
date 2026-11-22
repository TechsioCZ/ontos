import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { getActionHandler } from '@app/core-runtime/testing/actions';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { NodeCrypto } from '@effect/platform-node';
import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionUnavailableError,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime';
import { ConfigProvider, DateTime, Effect, Layer, Option, Ref, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import type { ActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import type { DomainEventContractMap } from '../../../../packages/core-runtime/src/actions/events.ts';
import { PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import { relayPortalAuthCommunicationRequestAction } from '../../src/actions/relay-portal-auth-communication-request.action.ts';
import { CommercePortalAuthCommunicationRequestSubmitter } from '../../src/portal-auth/communications/communication-request-submitter.ts';
import { CommercePortalAuthCommunicationStore } from '../../src/portal-auth/communications/communication-store.ts';
import { PortalAuthCommunicationUnavailable } from '../../src/portal-auth/communications/communication-unavailable.ts';
import type { PortalAuthIssuance } from '../../src/portal-auth/communications/issuance.ts';
import {
  makePortalAuthCommunicationRelayLive,
  relayCommunicationRequests,
} from '../../src/portal-auth/communications/request-relay.ts';
import { PortalAuthRelayTransportLive } from '../../src/portal-auth/communications/relay-transport.ts';
import { CommercePortalAuthTrustedScope } from '../../src/portal-auth/communications/trusted-scope.ts';
import { portalAuthCommunicationRequest, storedRequestOf } from '../../src/portal-auth/communications/request.ts';
import { PortalAuthCommunicationSourceGateway } from '../../src/workers/portal-auth-communication-source-gateway.ts';
import { SubmitPortalAuthCommunicationRequestRejected } from '../../src/workers/submit-portal-auth-communication-request-rejected.ts';
import { handleSubmitPortalAuthCommunicationRequest } from '../../src/workers/submit-portal-auth-communication-request.worker.ts';
import { makeCommunicationStoreDouble } from '../support/portal-auth-communication-store.double.ts';

/**
 * #1406 D1, the production hops after the Auth-local outbox: the relay hands a committed request to this module's own
 * `relay-portal-auth-communication-request` Action, which only queues it for the module's source worker, and the worker submits
 * it to Communications through its registered-workload gateway. The gateway, the Shell and Communications are doubles here; the
 * real Action of Communications is the end-to-end suites'. Every value is FICTIONAL.
 */

const TENANT = '7e000000-0000-4000-8000-0000000000c1';
const OTHER_TENANT = '7e000000-0000-4000-8000-0000000000c2';
const LEGAL_ENTITY = '7e000000-0000-4000-8000-0000000000c3';
const COMPOSITION = 'a'.repeat(64);
const ISSUED_AT = DateTime.makeUnsafe('2026-11-22T10:00:00.000Z');
const TOPIC = 'commerce.customer-context.portal-auth-communication-requested.v1';
const WORKER_KEY = 'commerce.customer-context.submit-portal-auth-communication-request';

const issuance = (name: string): PortalAuthIssuance => ({
  expiresAt: DateTime.add(ISSUED_AT, { minutes: 30 }),
  flow: 'reset-password',
  issuanceRef: Schema.decodeSync(PortalAuthIssuanceRefSchema)(name),
  issuedAt: ISSUED_AT,
  providerSubjectId: 'subject-transport',
});
const requestOf = (name: string, tenantId = TENANT) => portalAuthCommunicationRequest(issuance(name), { tenantId });

const relayPrincipal = {
  authBindingId: '7e000000-0000-4000-8000-0000000000d2',
  authContextRef: 'fictional-api-key:portal-auth-relay',
  authMethod: 'api_key' as const,
  correlationId: 'portal-auth-relay',
  principalId: '7e000000-0000-4000-8000-0000000000d3',
  tenantId: TENANT,
};
const tenantScope = trustVerifiedGatewayPrincipalContext(relayPrincipal, COMPOSITION);
const companyScope = trustVerifiedGatewayPrincipalContext(
  { ...relayPrincipal, legalEntityId: LEGAL_ENTITY },
  COMPOSITION,
);

const actionContext = <DomainEvents extends DomainEventContractMap>(
  collector: ActionCollector<DomainEvents>,
  scope: typeof tenantScope,
) => ({
  actionInvocationId: '7e000000-0000-4000-8000-0000000000d1',
  addDomainEvent: collector.addDomainEvent,
  addOutboxMessage: collector.addOutboxMessage,
  compositionRevision: COMPOSITION,
  recordAuditEvidence: collector.recordAuditEvidence,
  recordDataAccess: collector.recordDataAccess,
  scope,
  services: {},
});

const relay = (payload: { readonly request: CommunicationRequestEncoded }, scope = tenantScope) => {
  const collector = createActionCollector(
    relayPortalAuthCommunicationRequestAction.descriptor.domainEvents,
    'commerce.customer-context',
    relayPortalAuthCommunicationRequestAction.descriptor.accessEvidencePolicy,
    relayPortalAuthCommunicationRequestAction.descriptor.auditEvidenceSchema,
    COMPOSITION,
  );
  return getActionHandler(relayPortalAuthCommunicationRequestAction)(payload, actionContext(collector, scope)).pipe(
    Effect.result,
    Effect.map((result) => ({ material: collector.snapshot(), result })),
  );
};

const deliveryOf = (overrides: Partial<OutboxWorkerHandlerContext> = {}): OutboxWorkerHandlerContext => ({
  attemptNumber: 1,
  claimId: 'claim:transport',
  compositionRevision: COMPOSITION,
  consumerModuleKey: 'commerce.customer-context',
  deliveryId: 'delivery:transport',
  domainEventId: 'event:transport',
  messageId: 'message:transport',
  producerModuleKey: 'commerce.customer-context',
  tenantId: TENANT,
  tenantSequenceNo: 1n,
  topic: TOPIC,
  workerKey: WORKER_KEY,
  ...overrides,
});

const gatewayDouble = (
  answer: () => Effect.Effect<void, SubmitPortalAuthCommunicationRequestRejected> = () => Effect.void,
) => {
  const calls: { readonly context: OutboxWorkerHandlerContext; readonly request: CommunicationRequestEncoded }[] = [];
  const layer = Layer.succeed(PortalAuthCommunicationSourceGateway, {
    submit: (request, context) => {
      calls.push({ context, request });
      return answer();
    },
  });
  return { calls, layer };
};

describe('The Portal Auth relay Action (#1406 D1)', () => {
  it.effect('queues a Tenant request of this module once for the source worker and decides nothing', () =>
    Effect.gen(function* queued() {
      const request = yield* requestOf('pa-transport-1');
      const { material, result } = yield* relay({ request });
      expect(Result.isSuccess(result)).toBe(true);
      expect(result).toMatchObject({ success: { outcome: 'RELAYED' } });
      expect(material.domainEvents.map(({ eventType }) => eventType)).toStrictEqual([TOPIC]);
      expect(material.outboxMessages).toHaveLength(1);
      expect(material.outboxMessages[0]?.message.topic).toBe(TOPIC);
      expect(material.outboxMessages[0]?.message.payloadJson).toStrictEqual({ request });
    }),
  );

  it.effect('refuses a request claiming another scope or another source, and queues nothing', () =>
    Effect.gen(function* refused() {
      const foreignTenant = yield* relay({ request: yield* requestOf('pa-transport-2', OTHER_TENANT) });
      const ownRequest = yield* requestOf('pa-transport-3');
      const companyScoped = yield* relay({ request: ownRequest }, companyScope);
      const foreignSource = yield* relay({
        request: { ...ownRequest, source: { moduleKey: 'fictional.other-source' } },
      });
      expect(foreignTenant.result).toMatchObject({ failure: { code: 'portal_auth_request_scope_mismatch' } });
      expect(companyScoped.result).toMatchObject({ failure: { code: 'portal_auth_request_scope_mismatch' } });
      expect(foreignSource.result).toMatchObject({ failure: { code: 'portal_auth_request_source_mismatch' } });
      for (const { material } of [foreignTenant, companyScoped, foreignSource]) {
        expect(material.domainEvents).toHaveLength(0);
        expect(material.outboxMessages).toHaveLength(0);
      }
    }),
  );
});

describe('The Portal Auth source worker (#1406 D1)', () => {
  it.effect('submits the exact request inside its own delivery, and a redelivery submits the same request again', () =>
    Effect.gen(function* submits() {
      const request = yield* requestOf('pa-transport-4');
      const gateway = gatewayDouble();
      const run = handleSubmitPortalAuthCommunicationRequest({ request }, deliveryOf()).pipe(
        Effect.provide(gateway.layer),
      );
      yield* run;
      yield* run;
      expect(gateway.calls.map((call) => call.request)).toStrictEqual([request, request]);
      expect(gateway.calls[0]?.context.workerKey).toBe(WORKER_KEY);
    }),
  );

  it.effect('refuses, finally, a delivery that is not exactly its own, and reaches no gateway', () =>
    Effect.gen(function* refuses() {
      const request = yield* requestOf('pa-transport-5');
      const gateway = gatewayDouble();
      const foreign = [
        deliveryOf({ workerKey: 'commerce.customer-context.execute-privacy-measure-worker' }),
        deliveryOf({ topic: 'commerce.customer-context.other.v1' }),
        deliveryOf({ producerModuleKey: 'privacy.core' }),
        deliveryOf({ tenantId: OTHER_TENANT }),
      ];
      for (const delivery of foreign) {
        const failure = yield* handleSubmitPortalAuthCommunicationRequest({ request }, delivery).pipe(
          Effect.provide(gateway.layer),
          Effect.flip,
        );
        expect(failure).toMatchObject({ code: 'WORKER_CONTEXT_INVALID', retryable: false });
      }
      const companyScoped = { ...request, scope: { legalEntityId: LEGAL_ENTITY, tenantId: TENANT } };
      expect(
        yield* handleSubmitPortalAuthCommunicationRequest({ request: companyScoped }, deliveryOf()).pipe(
          Effect.provide(gateway.layer),
          Effect.flip,
        ),
      ).toMatchObject({ code: 'WORKER_CONTEXT_INVALID' });
      expect(gateway.calls).toHaveLength(0);
    }),
  );

  it.effect('an unreachable Communications intake stays retryable, so Core delivers the same request again', () =>
    Effect.gen(function* retryable() {
      const request = yield* requestOf('pa-transport-6');
      const gateway = gatewayDouble(() =>
        Effect.fail(
          new SubmitPortalAuthCommunicationRequestRejected({
            code: 'COMMUNICATIONS_UNAVAILABLE',
            reason: 'fictional outage',
            retryable: true,
          }),
        ),
      );
      const failure = yield* handleSubmitPortalAuthCommunicationRequest({ request }, deliveryOf()).pipe(
        Effect.provide(gateway.layer),
        Effect.flip,
      );
      expect(failure).toMatchObject({ code: 'COMMUNICATIONS_UNAVAILABLE', retryable: true });
    }),
  );
});

describe('The relay over the production transport (#1406 D1)', () => {
  it.effect(
    'a RELAYED row is closed as RELAYED and keeps its protected value until Auth itself ends the issuance',
    () =>
      Effect.gen(function* relayed() {
        yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
        const store = makeCommunicationStoreDouble();
        const request = yield* requestOf('pa-transport-8');
        yield* store.service.record({
          issuance: issuance('pa-transport-8'),
          now: ISSUED_AT,
          request: yield* storedRequestOf(request),
          sealedValue: 'v1.sealed',
          supersede: false,
          tenantId: TENANT,
        });
        const submitted: CommunicationRequestEncoded[] = [];
        const result = yield* relayCommunicationRequests({
          leaseMillis: 30_000,
          leaseOwner: 'relay-transport',
          limit: 8,
          maxRetryMillis: 60_000,
          retryMillis: 1000,
          tenantId: TENANT,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(CommercePortalAuthCommunicationStore, store.service),
              Layer.succeed(CommercePortalAuthCommunicationRequestSubmitter, {
                submit: (sent) => {
                  submitted.push(sent);
                  return Effect.succeed({ outcome: 'RELAYED' } as const);
                },
              }),
            ),
          ),
        );
        expect(result).toMatchObject({ claimed: 1, relayed: 1 });
        const row = (yield* Ref.get(store.outbox)).get('pa-transport-8');
        expect(row?.state).toBe('RELAYED');
        expect(Option.getOrThrow(row?.outcome ?? Option.none())).toBe('{"outcome":"RELAYED"}');
        expect(
          Option.isSome((yield* Ref.get(store.issuances)).get('pa-transport-8')?.sealedValue ?? Option.none()),
        ).toBe(true);
        expect(submitted).toStrictEqual([request]);
      }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe('The relay loop and the production relay transport (#1406 D1)', () => {
  it.effect(
    'the relay loop submits a committed row of the trusted Tenant within its interval, and none of another Tenant',
    () =>
      Effect.gen(function* loop() {
        yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
        const store = makeCommunicationStoreDouble();
        for (const [name, tenantId] of [
          ['pa-loop-own', TENANT],
          ['pa-loop-foreign', OTHER_TENANT],
        ] as const) {
          yield* store.service.record({
            issuance: issuance(name),
            now: ISSUED_AT,
            request: yield* storedRequestOf(yield* requestOf(name, tenantId)),
            sealedValue: 'v1.sealed',
            supersede: false,
            tenantId,
          });
        }
        const submitted: string[] = [];
        yield* Effect.scoped(
          Effect.gen(function* running() {
            yield* Layer.build(
              makePortalAuthCommunicationRelayLive(Effect.succeed(true)).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(CommercePortalAuthCommunicationStore, store.service),
                    Layer.succeed(CommercePortalAuthCommunicationRequestSubmitter, {
                      submit: (sent) => {
                        submitted.push(sent.occurrence.occurrenceId);
                        return Effect.succeed({ outcome: 'RELAYED' } as const);
                      },
                    }),
                    Layer.succeed(CommercePortalAuthTrustedScope, { current: Effect.succeed({ tenantId: TENANT }) }),
                    NodeCrypto.layer,
                  ),
                ),
              ),
            );
            yield* TestClock.adjust('2 seconds');
          }),
        );
        expect(submitted).toStrictEqual(['pa-loop-own']);
        expect((yield* Ref.get(store.outbox)).get('pa-loop-foreign')?.state).toBe('PENDING');
      }).pipe(Effect.provide(TestClock.layer())),
  );

  const unavailableComposition = Layer.succeed(
    ActiveApplicationCompositionService,
    makeActiveApplicationCompositionService(
      Effect.fail(
        new ActiveApplicationCompositionUnavailableError({ cause: 'fictional', reason: 'Fictional authority' }),
      ),
    ),
  );
  const transportWith = (configuration: Record<string, string>) =>
    CommercePortalAuthCommunicationRequestSubmitter.pipe(
      Effect.provide(
        PortalAuthRelayTransportLive.pipe(
          Layer.provide(
            Layer.merge(unavailableComposition, ConfigProvider.layer(ConfigProvider.fromUnknown(configuration))),
          ),
        ),
      ),
    );

  it.effect(
    'the production transport fails closed, and sends nothing, without its configuration or an admitted composition',
    () =>
      Effect.gen(function* failClosed() {
        const request = yield* requestOf('pa-transport-9');
        const unconfigured = yield* transportWith({});
        const configured = yield* transportWith({
          COMMERCE_PORTAL_AUTH_COMMUNICATION_RELAY_API_KEY: 'fictional-relay-key',
          ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL: 'https://commerce.example.test',
          ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test',
        });
        for (const transport of [unconfigured, configured]) {
          const failure = yield* Effect.flip(transport.submit(request));
          expect(Schema.is(PortalAuthCommunicationUnavailable)(failure)).toBe(true);
          expect(failure).toMatchObject({ operation: 'relay-portal-auth-communication-request' });
          expect(JSON.stringify(failure)).not.toContain('fictional-relay-key');
        }
      }),
  );
});
