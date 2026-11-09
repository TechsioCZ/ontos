import {
  PriceSourceResultLookupInvalidProblemSchema,
  PriceSourceResultLookupRequestSchema,
  PriceSourceResultLookupResponseSchema,
} from '@app/pricing/apis/price-source-result-lookup';
import type { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import type { PriceSourceProvenanceSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { GatewayForbiddenProblemSchema } from '@app/shared-contracts';
import { expect } from 'effect-rstest';
import { Crypto, Effect, Schema } from 'effect';
import { HttpBody, HttpClient } from 'effect/http';

import type { makeInternalC14PricingRouteFixture } from './symmy-c14-pricing-routes-runtime.mts';
import { issueSymmyC14RecoveryAssertion } from './symmy-c14-product-recovery.mts';
import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

type Fixture = Effect.Success<ReturnType<typeof makeInternalC14PricingRouteFixture>>;
const workerKey = 'integration.symmy.execute-symmy-job';
const originalActionKey = 'commerce.pricing.define-price';
const tupleSchema = Schema.Struct({
  action_invocation_id: PriceSourceResultLookupRequestSchema.fields.actionInvocationId,
  idempotency_key: Schema.String,
  principal_id: Schema.String,
  request_hash: Schema.String,
});
type NativeTuple = typeof tupleSchema.Type;

/** Real signatures authorize only the retained native invocation and the exact protected Read body. */
export const assertInternalC14PriceRecovery = Effect.fn('InternalC14PricingRoutes.recovery')(
  function* assertPriceRecovery(input: {
    readonly fixture: Fixture;
    readonly originalJobId: string;
    readonly originalPriceRef: typeof PriceRefSchema.Type;
    readonly originalProvenance: typeof PriceSourceProvenanceSchema.Type;
    readonly selectedJobId: string;
  }) {
    const { fixture } = input;
    const crypto = yield* Crypto.Crypto;
    const invocationFor = (jobId: string) =>
      fixture.admin`
        select i.action_invocation_id,i.idempotency_key,i.principal_id,i.request_hash
        from symmy_integration.job_effects e join core.action_invocations i
          on i.tenant_id=e.tenant_id and i.action_invocation_id=e.owner_invocation_id
        where e.tenant_id=${fixture.tenantId} and e.job_id=${jobId} and e.state='settled'
          and i.action_key=${originalActionKey} and i.status='succeeded'
          and i.principal_id=${fixture.systemId} and i.legal_entity_id=${fixture.legalEntityId}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([tupleSchema]))),
        Effect.map(([tuple]) => tuple),
      );
    const original = yield* invocationFor(input.originalJobId);
    const selected = yield* invocationFor(input.selectedJobId);
    expect(original.action_invocation_id).not.toBe(selected.action_invocation_id);
    const [delivery] = yield* fixture.admin`
      select d.outbox_delivery_id as delivery_id from core.outbox_deliveries d
      join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id
      join core.domain_events e on e.domain_event_id=m.domain_event_id and e.tenant_id=m.tenant_id
      join symmy_integration.import_jobs j on j.admission_invocation_id=e.action_invocation_id and j.tenant_id=e.tenant_id
      where j.tenant_id=${fixture.tenantId} and j.job_id=${input.originalJobId}
        and d.worker_key=${workerKey} and d.consumer_module_key='integration.symmy'
        and m.producer_module_key='integration.symmy'
    `.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ delivery_id: Schema.String.check(Schema.isUUID()) })]),
        ),
      ),
    );
    const [requirement] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ key: Schema.String })]))(
      (fixture.symmyContract.manifest.requirements?.operations ?? []).filter(
        (candidate) =>
          candidate.entrypointKey === workerKey &&
          candidate.provider.moduleId === 'commerce.pricing' &&
          candidate.provider.entrypointKey === 'commerce.pricing.api.price-source-result-lookup' &&
          candidate.provider.schemaVersion === '1',
      ),
    );
    const issue = (
      actionInvocationId: NativeTuple['action_invocation_id'],
      originalRequestHash = original.request_hash,
    ) =>
      Effect.gen(function* issueExactPriceRecovery() {
        const readPayload = yield* Schema.encodeEffect(PriceSourceResultLookupRequestSchema)({ actionInvocationId });
        return yield* issueSymmyC14RecoveryAssertion({
          audience: 'pricing',
          compositionRevision: fixture.snapshot.composition.revision,
          declarationKey: 'commerce.pricing.price-source-result-lookup.read',
          legalEntityScope: 'subject',
          moduleKey: fixture.moduleKey.secret,
          operationRequirementKey: requirement.key,
          originalActionKey,
          originalIdempotencyKey: original.idempotency_key,
          originalPrincipalId: original.principal_id,
          originalRequestHash,
          readPayload,
          shellGatewayBaseUrl: `${fixture.shell.baseUrl}/shell-super-app-api`,
          source: {
            _tag: 'HistoricalDelivery',
            deliveryId: delivery.delivery_id,
            legalEntityId: fixture.legalEntityId,
            tenantId: fixture.tenantId,
            workerKey,
          },
        });
      });
    const client = yield* HttpClient.HttpClient;
    const read = (
      assertion: Effect.Success<ReturnType<typeof issue>>,
      actionInvocationId: NativeTuple['action_invocation_id'],
    ) =>
      Effect.gen(function* readExactPriceReceipt() {
        const payload = yield* Schema.encodeEffect(PriceSourceResultLookupRequestSchema)({ actionInvocationId });
        return yield* client.post(
          `${new URL(assertion.apiBaseUrl, fixture.shell.baseUrl)}/reads/price-source-result-lookup`,
          {
            body: yield* HttpBody.json(payload),
            headers: {
              authorization: `Bearer ${assertion.token}`,
              'x-correlation-id': yield* crypto.randomUUIDv4(),
              'x-ontos-composition-revision': fixture.snapshot.composition.revision,
            },
          },
        );
      });
    expect(original.request_hash).not.toBe(selected.request_hash);
    const refusedOriginalHash = yield* issue(original.action_invocation_id, selected.request_hash).pipe(
      Effect.as(false),
      Effect.catchTag('GatewayForbiddenProblem', (problem) =>
        Schema.decodeUnknownEffect(GatewayForbiddenProblemSchema)(problem).pipe(Effect.as(true)),
      ),
    );
    expect(refusedOriginalHash).toBe(true);
    const wrongInvocation = yield* issue(selected.action_invocation_id);
    expect((yield* read(wrongInvocation, selected.action_invocation_id)).status).toBe(403);
    const wrongReadHash = yield* issue(original.action_invocation_id);
    const hashRefused = yield* read(wrongReadHash, selected.action_invocation_id);
    expect(hashRefused.status).toBe(400);
    yield* hashRefused.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PriceSourceResultLookupInvalidProblemSchema)),
    );
    const exact = yield* issue(original.action_invocation_id);
    expect(exact.machineContext?.principalId).toBe(fixture.systemId);
    const recovered = yield* read(exact, original.action_invocation_id);
    expect(recovered.status).toBe(200);
    const receipt = yield* recovered.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PriceSourceResultLookupResponseSchema)),
    );
    if (receipt.outcome !== 'PRICE_ACTION_RESULT_FOUND') {
      return yield* new SymmyC14ProductFixtureUnavailable({
        message: 'The exact original native Price receipt was not found',
      });
    }
    expect(receipt.actionInvocationId).toBe(original.action_invocation_id);
    if (receipt.result.outcome !== 'CREATED') {
      return yield* new SymmyC14ProductFixtureUnavailable({
        message: 'The original native Price receipt does not describe its committed creation',
      });
    }
    expect(receipt.result.definition.priceRef).toEqual(input.originalPriceRef);
    expect(receipt.result.provenance.canonicalLink.priceRef).toEqual(input.originalPriceRef);
    expect(receipt.result.provenance).toEqual(input.originalProvenance);
    return yield* Effect.void;
  },
);
