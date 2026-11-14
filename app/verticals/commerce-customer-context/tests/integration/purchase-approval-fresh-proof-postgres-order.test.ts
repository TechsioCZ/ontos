import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import { consumeOrderPurchaseApprovalAction } from '../../src/actions/consume-order-purchase-approval.action.ts';
import { ConsumeOrderPurchaseApprovalPayloadSchema } from '../../shared/actions/consume-order-purchase-approval.ts';
import { CommittedOrderApprovalEvidenceResponseSchema } from '@app/commerce-order-contracts/committed-order-approval-evidence';
import { FetchHttpClient } from 'effect/http';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ApprovalRevalidationSchema, PurchasingApprovalRejected } from '../../shared/domain/purchasing-approval.ts';
import { randomUUID } from 'node:crypto';
import {
  ActionRuntime,
  isVerifiedGatewayPrincipalContext,
  readVerifiedGatewayActor,
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionSnapshotSchema,
} from '@app/core-runtime';
import { ConfigProvider, Context, DateTime, Deferred, Effect, Fiber, Layer, Result, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import {
  assertNoOpenActionTransaction,
  awaitPausedAuthority,
  extendedObservationSeconds,
  holdGenuineRequest,
  holdGenuineTenant,
  scenario,
  services,
  waitForExactBlock,
} from './purchase-approval-fresh-proof-postgres.fixture.ts';

/**
 * Order and Shell replies are transport fixtures; all clients, Action gates and SQL are real. The buyer is the
 * verified subject and the Order module the verified actor, as the Shell signs a delegated call.
 */
it.live(
  'consumes an approved proof through the registered Order Action and rejects conflicting evidence',
  () =>
    Effect.scoped(
      Effect.gen(function* realOrderConsumptionAction() {
        const test = yield* scenario('CURRENT', 120_000, false, undefined, true);
        test.setObservationWindow(extendedObservationSeconds);
        const proof = yield* test.check(randomUUID());
        const clock = yield* test.owner.nativeNow();
        const payload = yield* Schema.decodeUnknownEffect(ConsumeOrderPurchaseApprovalPayloadSchema)({
          finalBinding: test.binding,
          idempotencyKey: randomUUID(),
          orderRef: {
            moduleId: 'commerce.order',
            resourceId: randomUUID(),
            resourceType: 'commerce.order.order',
            tenantId: test.owner.tenantId,
          },
          revalidationRef: proof.revalidation.revalidationRef,
        });
        const evidence = yield* Schema.decodeUnknownEffect(CommittedOrderApprovalEvidenceResponseSchema)({
          ...payload,
          buyerPrincipalId: test.owner.principal.principalId,
          commitmentCorrelationId: test.correlation,
          committedAt: DateTime.formatIso(clock.at),
          consumptionIntent: payload.idempotencyKey,
          counterpartyRef: test.chain.counterpartyRef,
          decisionBundleHash: test.approved.decision.decisionBundleHash,
          decisionBundleVersion: test.approved.decision.decisionBundleVersion,
          legalEntityId: test.owner.legalEntityId,
          observedAt: DateTime.formatIso(clock.at),
          proposalHash: test.chain.proposal.canonicalHash,
          proposalRevisionRef: test.chain.proposal.proposalRevisionRef,
          provenance: 'commerce.order.committed-approval-evidence.v1',
          requestRef: test.approved.request.requestRef,
          storefrontId: test.owner.storefrontId,
          tenantId: test.owner.tenantId,
          validUntil: DateTime.formatIso(DateTime.add(clock.at, { seconds: 25 })),
        });
        const sourceUrl = 'https://composition.order-consumption.test/active';
        const shellUrl = 'https://shell.order-consumption.test';
        const orderUrl = 'https://order.order-consumption.test';
        // Commerce's own module key, handed over the way the host does.
        yield* holdTestModuleCredentials({ 'commerce-customer-context': 'test-owned-customer-context-module-key' });
        const environment = ConfigProvider.orElse(
          ConfigProvider.fromUnknown({
            ONTOS_ACTION_TRANSACTION_IO_GUARD: true,
            ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: sourceUrl,
            ONTOS_COMMERCE_ORDER_API_BASE_URL: `${orderUrl}/commerce-order-api`,
            ONTOS_SHELL_GATEWAY_BASE_URL: `${shellUrl}/shell-super-app-api`,
          }),
          ConfigProvider.fromEnv(),
        );
        const sourceDocument = yield* Schema.encodeEffect(
          Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
        )(test.snapshot);
        // The composition source pins its fetch when its layer is built, so each call's fetch is provided there.
        const compositionLayer = (sourceFetch: typeof globalThis.fetch) =>
          ActiveApplicationCompositionConfigLive.pipe(
            Layer.provide(
              ActiveApplicationCompositionSourceLive.pipe(
                Layer.provide(FetchHttpClient.layer),
                Layer.provide(Layer.succeed(FetchHttpClient.Fetch, sourceFetch)),
              ),
            ),
            Layer.provide(ConfigProvider.layer(environment)),
          );
        const requests: Request[] = [];
        const buyer = test.owner.fixture.manager;
        const orderForBuyer = { calledBy: 'commerce-order', subject: buyer };
        const consume = (
          candidate: typeof payload,
          returnedEvidence: typeof evidence,
          caller: { readonly calledBy?: string; readonly subject: typeof buyer },
        ) =>
          Effect.gen(function* executeRealConsumption() {
            const body = yield* Schema.encodeEffect(CommittedOrderApprovalEvidenceResponseSchema)(returnedEvidence);
            const fetch: typeof globalThis.fetch = async (target, init) => {
              const request = new Request(target, init);
              requests.push(request.clone());
              if (request.url === sourceUrl) {
                return new Response(sourceDocument, { headers: { 'content-type': 'application/json' } });
              }
              if (request.url === `${shellUrl}/shell-super-app-api/auth/delegated/gateway-context`) {
                // Customer Context's own module credential, delegating the verified subject's assertion.
                expect(request.headers.get('x-api-key')).toBe('test-owned-customer-context-module-key');
                expect(await request.json()).toMatchObject({
                  audience: 'commerce-order',
                  legalEntityScope: 'subject',
                  subject: { _tag: 'Assertion' },
                });
                return Response.json({
                  apiBaseUrl: '/commerce-order-api',
                  compositionRevision: test.snapshot.composition.revision,
                  expiresAt: clock.epoch + 30,
                  token: 'test-order-gateway-assertion',
                });
              }
              expect(request.url).toBe(`${orderUrl}/commerce-order-api/reads/committed-order-approval-evidence`);
              expect(request.headers.get('authorization')).toBe('Bearer test-order-gateway-assertion');
              expect(await request.json()).toEqual({
                finalBinding: candidate.finalBinding,
                orderRef: candidate.orderRef,
                revalidationRef: candidate.revalidationRef,
              });
              return Response.json(body);
            };
            const principal = yield* test.owner.authenticatedPrincipal(caller.subject, caller.calledBy);
            expect(isVerifiedGatewayPrincipalContext(principal)).toBe(true);
            expect(principal).toMatchObject({
              authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
              authMethod: 'session',
              legalEntityId: test.owner.legalEntityId,
              principalId: caller.subject.principalId,
              tenantId: test.owner.tenantId,
            });
            expect(readVerifiedGatewayActor(principal)?.appId).toBe(caller.calledBy);
            return yield* Context.get(test.context, ActionRuntime)
              .runAction({
                payload: yield* Schema.encodeEffect(ConsumeOrderPurchaseApprovalPayloadSchema)(candidate),
                principal,
                registration: consumeOrderPurchaseApprovalAction,
                transport: {
                  correlationId: randomUUID(),
                  idempotencyKey: randomUUID(),
                  targetModuleKey: 'commerce.customer-context',
                },
              })
              .pipe(
                Effect.provideService(FetchHttpClient.Fetch, fetch),
                Effect.provide(compositionLayer(fetch)),
                Effect.provide(FetchHttpClient.layer),
                Effect.provideService(ConfigProvider.ConfigProvider, environment),
                Effect.provideContext(test.context),
              );
          });
        const beforeRequest = yield* test.readRequest();
        const beforeProofs = yield* test.readProofs();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        // The buyer alone is not the Order service, and the Order service may act only for the approval's buyer.
        for (const caller of [{ subject: buyer }, { calledBy: 'commerce-order', subject: test.owner.fixture.reader }]) {
          const refused = yield* Effect.result(consume(payload, evidence, caller));
          assert.isOk(Result.isFailure(refused));
          expect(
            yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(refused.failure),
            `caller ${caller.calledBy ?? 'none'} for ${caller.subject.principalId}`,
          ).toMatchObject({ code: caller.calledBy === undefined ? 'PERMISSION_DENIED' : 'COMMIT_CONFLICT' });
          expect(yield* test.readRequest()).toEqual(beforeRequest);
          expect(yield* test.readProofs()).toEqual(beforeProofs);
        }
        const wrongEvidence = yield* Effect.result(
          consume(payload, { ...evidence, proposalHash: 'a'.repeat(64) }, orderForBuyer),
        );
        assert.isOk(Result.isFailure(wrongEvidence));
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(wrongEvidence.failure);
        expect(
          failure.code,
          `Order consumption rejection: ${failure.reason}; transport paths: ${requests.map(({ url }) => new URL(url).pathname).join(', ')}`,
        ).toBe('COMMIT_CONFLICT');
        expect(yield* test.readRequest()).toEqual(beforeRequest);
        expect(yield* test.readProofs()).toEqual(beforeProofs);
        const foreignProof = { ...payload, revalidationRef: { ...payload.revalidationRef, resourceId: randomUUID() } };
        const wrongProof = yield* Effect.result(
          consume(foreignProof, { ...evidence, revalidationRef: foreignProof.revalidationRef }, orderForBuyer),
        );
        assert.isOk(Result.isFailure(wrongProof));
        // The unchanged native consumption routine hides unknown proofs with its canonical permission denial.
        expect(yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(wrongProof.failure)).toMatchObject({
          code: 'PERMISSION_DENIED',
        });
        expect(yield* test.readRequest()).toEqual(beforeRequest);
        expect(yield* test.readProofs()).toEqual(beforeProofs);
        const afterRefusal = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(afterRefusal.events).toEqual(before.events);
        expect(afterRefusal.outbox).toEqual(before.outbox);
        const consumed = yield* consume(payload, evidence, orderForBuyer);
        expect(consumed.outcome).toBe('CONSUMED');
        expect(consumed.request.consumptionProofRef).toEqual(payload.revalidationRef);
        const persisted = yield* test.readRequest();
        const afterConsumption = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(afterConsumption.events).toHaveLength(before.events.length + 1);
        expect(afterConsumption.outbox).toHaveLength(before.outbox.length + 1);
        expect((yield* consume(payload, evidence, orderForBuyer)).outcome).toBe('ALREADY_CONSUMED');
        expect(yield* test.readRequest()).toEqual(persisted);
        expect(yield* test.readProofs()).toEqual(beforeProofs);
        const afterReplay = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(afterReplay.events).toEqual(afterConsumption.events);
        expect(afterReplay.outbox).toEqual(afterConsumption.outbox);
        const otherOrder = { ...payload, orderRef: { ...payload.orderRef, resourceId: randomUUID() } };
        const conflict = yield* Effect.result(
          consume(otherOrder, { ...evidence, orderRef: otherOrder.orderRef }, orderForBuyer),
        );
        assert.isOk(Result.isFailure(conflict));
        expect(yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(conflict.failure)).toMatchObject({
          code: 'COMMIT_CONFLICT',
        });
        expect(yield* test.readRequest()).toEqual(persisted);
        expect(yield* test.readProofs()).toEqual(beforeProofs);
        const afterConflict = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(afterConflict.events).toEqual(afterConsumption.events);
        expect(afterConflict.outbox).toEqual(afterConsumption.outbox);
        expect(
          requests.some(({ url }) => url === `${shellUrl}/shell-super-app-api/auth/delegated/gateway-context`),
        ).toBe(true);
        expect(
          requests.some(({ url }) => url === `${orderUrl}/commerce-order-api/reads/committed-order-approval-evidence`),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'prepares registered revalidations concurrently without SQL and gates their final commits on the Core Tenant',
  () =>
    Effect.scoped(
      Effect.gen(function* tenantGateSerialization() {
        const test = yield* scenario();
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        yield* test.expire(first.revalidation.validUntil);
        const pauseA = yield* test.pauseAuthority();
        const entries = test.authorityEntries();
        const actionA = yield* test.check(randomUUID()).pipe(Effect.forkScoped);
        yield* awaitPausedAuthority(pauseA, actionA);
        yield* assertNoOpenActionTransaction(test);
        const pauseB = yield* test.pauseAuthority();
        const actionB = yield* test.check(randomUUID()).pipe(Effect.forkScoped);
        yield* awaitPausedAuthority(pauseB, actionB);
        expect(test.authorityEntries()).toBe(entries + 2);
        yield* assertNoOpenActionTransaction(test);

        const held = yield* holdGenuineTenant(test);
        yield* Deferred.succeed(pauseA.release, true);
        yield* waitForExactBlock(test, held.blocker, 'TENANT');
        expect(yield* test.readProofs()).toEqual(original);
        expect(yield* test.readRequest()).toEqual(request);
        yield* Deferred.succeed(held.release, true);
        yield* Fiber.join(held.holder);
        const a = yield* Fiber.join(actionA);
        yield* assertNoOpenActionTransaction(test);
        yield* Deferred.succeed(pauseB.release, true);
        const b = yield* Fiber.join(actionB);
        expect(a.revalidation.revalidationRef.resourceId).not.toBe(b.revalidation.revalidationRef.resourceId);
        expect(test.authorityEntries()).toBe(entries + 2);
        const records = yield* test.readProofs();
        expect(records).toHaveLength(3);
        expect(records.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
          original[0],
        );
        for (const issued of [a, b]) {
          const encodedEvidence = yield* Schema.encodeEffect(ApprovalRevalidationSchema.fields.evidence)(
            issued.revalidation.evidence,
          );
          expect(
            records.find((row) => row.revalidationResourceId === issued.revalidation.revalidationRef.resourceId)
              ?.evidence,
          ).toEqual(encodedEvidence);
        }
        expect(yield* test.readRequest()).toEqual(request);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events).toHaveLength(before.events.length + 2);
        expect(after.outbox).toHaveLength(before.outbox.length + 2);
        expect(after.events).toEqual(expect.arrayContaining(before.events));
        expect(after.outbox).toEqual(expect.arrayContaining(before.outbox));
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'preserves different-intent Submit conflict while registered revalidation authority is paused without SQL',
  () =>
    Effect.scoped(
      Effect.gen(function* actualSubmissionCompetition() {
        const test = yield* scenario();
        const request = yield* test.readRequest();
        const proofs = yield* test.readProofs();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const pause = yield* test.pauseAuthority();
        const entries = test.authorityEntries();
        const check = yield* test.check(randomUUID()).pipe(Effect.forkScoped);
        yield* awaitPausedAuthority(pause, check);
        yield* assertNoOpenActionTransaction(test);
        const submit = yield* test.submitAgain().pipe(Effect.result, Effect.forkScoped);
        const result = yield* Fiber.join(submit);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(result.failure);
          expect(failure.code).toBe('IDEMPOTENCY_CONFLICT');
        }
        expect(test.authorityEntries()).toBe(entries + 1);
        yield* assertNoOpenActionTransaction(test);
        expect(yield* test.readProofs()).toEqual(proofs);
        expect(yield* test.readRequest()).toEqual(request);
        const rejected = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(rejected.events).toEqual(before.events);
        expect(rejected.outbox).toEqual(before.outbox);
        yield* Deferred.succeed(pause.release, true);
        const issued = yield* Fiber.join(check);
        const records = yield* test.readProofs();
        expect(records).toHaveLength(1);
        expect(records[0]?.revalidationResourceId).toBe(issued.revalidation.revalidationRef.resourceId);
        expect(yield* test.readRequest()).toEqual(request);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events).toHaveLength(before.events.length + 1);
        expect(after.outbox).toHaveLength(before.outbox.length + 1);
        expect(after.events).toEqual(expect.arrayContaining(before.events));
        expect(after.outbox).toEqual(expect.arrayContaining(before.outbox));
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'refuses original I1 after the actual registered request wait crosses exclusive P1 expiry',
  () =>
    Effect.scoped(
      Effect.gen(function* registeredExpiryAfterWait() {
        const test = yield* scenario();
        const intent = randomUUID();
        const first = yield* test.check(intent);
        const original = yield* test.readProofs();
        const held = yield* holdGenuineRequest(test);
        const replay = yield* test.check(intent).pipe(Effect.result, Effect.forkScoped);
        const pid = yield* waitForExactBlock(test, held.blocker, 'REQUEST', first.revalidation.validUntil);
        yield* test.expire(first.revalidation.validUntil);
        expect(yield* waitForExactBlock(test, held.blocker, 'REQUEST')).toBe(pid);
        yield* Deferred.succeed(held.release, true);
        yield* Fiber.join(held.holder);
        const result = yield* Fiber.join(replay);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(result.failure);
          expect(failure.code).toBe('OWNER_CONFIRMATION_EXPIRED');
        }
        expect(yield* test.readProofs()).toEqual(original);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);
