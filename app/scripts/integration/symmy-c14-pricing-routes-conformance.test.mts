import { randomUUID } from 'node:crypto';

import { bootstrapInternalC14PricingSourceAuthority } from '@app/pricing/testing/c14-source-authority-bootstrap';
import { makeOwnedIntegrationPriceGroupReaderWorkloadControlNative } from '@app/core-runtime/testing/workload-binding-native';
import { PriceGroupSourcePricesResponseSchema } from '@app/pricing/apis/price-group-source-prices';
import { PriceGroupRefSchema } from '@app/price-group-catalog/resources/price-group';
import { SymmyItemOutcomeSchema } from '@app/shared-contracts/symmy';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { assert, expect, it } from 'effect-rstest';
import { Array as EffectArray, Cause, DateTime, Duration, Effect, Exit, Layer, Order, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { bootstrapInternalC14PricingRouteInputs } from './support/symmy-c14-pricing-routes-inputs.mts';
import {
  decodeInternalC14CapturedPriceGrant,
  decodeInternalC14PriceGrantFor,
} from './support/symmy-c14-pricing-routes-plan.mts';
import { assertInternalC14PriceRecovery } from './support/symmy-c14-pricing-routes-recovery.mts';
import { makeInternalC14PricingRouteFixture } from './support/symmy-c14-pricing-routes-runtime.mts';
import { startProductWorker, SymmyC14ProductFixtureUnavailable } from './support/symmy-c14-product-runtime.mts';

const firstPageQuery = 'limit=1&offset=0';
const pricingFixturePurpose = 'implementation-1096-registered-workload-gateway';
// The native Group Action rejects a start before its own operation time. Allow for Shell admission,
// durable delivery and the protected owner request before checking the definition at its actual boundary.
const groupScheduleLeadTime = { seconds: 15 } as const;
const waitUntil = Effect.fn('InternalC14PricingRoutes.waitUntil')(function* waitUntil(
  at: Parameters<typeof DateTime.toEpochMillis>[0],
) {
  const remaining = DateTime.toEpochMillis(at) - DateTime.toEpochMillis(yield* DateTime.now);
  if (remaining > 0) {
    yield* Effect.sleep(Duration.millis(remaining));
  }
});
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const admitted = Schema.Struct({
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.Literal('queued'),
});
const statusSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(SymmyItemOutcomeSchema)),
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.String,
});
const projectionSchema = Schema.Struct({
  count: Schema.Int,
  limit: Schema.Int,
  offset: Schema.Int,
  priceLists: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      description: Schema.String,
      endsAt: Schema.optionalKey(PricingInstantSchema),
      name: Schema.String,
      priceGroupRef: PriceGroupRefSchema,
      prices: Schema.optionalKey(PriceGroupSourcePricesResponseSchema),
      startsAt: PricingInstantSchema,
    }),
  ),
});
const observe = <A, E, R>(reason: string, read: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  Effect.gen(function* observeNativeResult() {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const value = yield* read;
      if (done(value)) {
        return value;
      }
      yield* Effect.sleep(Duration.millis(250));
    }
    return yield* new SymmyC14ProductFixtureUnavailable({ message: reason });
  });

type PricingFixture = Effect.Success<ReturnType<typeof makeInternalC14PricingRouteFixture>>;
/** One public price list. The route fills in everything else: contract, fence, reasons, identities and sources. */
const publicList = (list: {
  readonly businessCode: string;
  readonly code: string;
  readonly effectiveFrom: string;
  readonly prices: readonly unknown[];
  readonly purpose: string;
}) => ({
  businessCode: list.businessCode,
  code: list.code,
  description: 'INTERNAL_C14 actual native Price Group receiving proof',
  effectiveFrom: list.effectiveFrom,
  name: `Internal ${list.businessCode}`,
  prices: list.prices,
  purpose: list.purpose,
});
const publicPrice = (input: {
  readonly at: string;
  readonly marketId: string;
  readonly selection: { readonly productRef: Schema.Json; readonly variantRef: Schema.Json };
  readonly unitRef: Schema.Json;
}) => ({
  amount: '25',
  commercialScope: { channelId: 'B2C', marketId: input.marketId },
  currencyCode: 'CZK',
  effectiveFrom: input.at,
  productRef: input.selection.productRef,
  unitBasis: { quantity: '1', unitRef: input.unitRef },
  variantRef: input.selection.variantRef,
});
const pricesPath = '/api/symmy/v1/price-lists/prices/batch';
const outcomesOf = (job: typeof statusSchema.Type) =>
  (job.items ?? []).flatMap((item) => item.effects).map(({ status }) => status);
const tableCounts = ({ prices, revisions }: { readonly prices: number; readonly revisions: number }) => ({
  prices,
  revisions,
});
/** The first price GET /price-lists lists for one price list. */
const firstListedPrice = (lists: typeof projectionSchema.Type, code: string) =>
  lists.priceLists.find((list) => list.code === code)?.prices?.prices[0]?.price;
const currentRevisionOf = (price: ReturnType<typeof firstListedPrice>) =>
  price?.outcome === 'PRICE_DEFINITION_CURRENT' ? price.definition.revision : undefined;
/** A refused request reaches no owner: no job is admitted and no Price is written. */
const assertPriceBatchRefusals = Effect.fn('InternalC14PricingRoutes.priceBatchRefusals')(function* batchRefusals(
  fixture: PricingFixture,
  group: { readonly priceGroupRef: typeof PriceGroupRefSchema.Type },
  price: ReturnType<typeof publicPrice>,
) {
  const client = yield* HttpClient.HttpClient;
  const ownerCounts = fixture.admin<{ jobs: number; writes: number }>`select
    (select count(*)::integer from symmy_integration.import_jobs where tenant_id=${fixture.tenantId}) as jobs,
    (select count(*)::integer from core.action_invocations where tenant_id=${fixture.tenantId}
      and action_key='commerce.pricing.define-price') as writes`;
  const before = yield* ownerCounts;
  const refusedHeaders = {
    'idempotency-key': 'INTERNAL_C14_REFUSED_PRICE_BATCH',
    'x-api-key': Redacted.value(fixture.key.secret),
  };
  const send = (body: Schema.Json) =>
    Effect.gen(function* sendRefusedPrice() {
      return yield* client.post(`${fixture.shell.baseUrl}${pricesPath}`, {
        body: yield* HttpBody.json(body),
        headers: refusedHeaders,
      });
    });
  const body = { priceGroupRef: group.priceGroupRef, prices: [{ ...price, operation: 'DEFINE' }] };
  // A list that does not exist.
  const unknown = yield* send({
    ...body,
    priceGroupRef: { ...group.priceGroupRef, resourceId: randomUUID() },
  });
  expect(unknown.status).toBe(403);
  // A list that exists but that this route's source did not create: the same answer, so no list is revealed.
  const [configured] = yield* fixture.admin<{ plan: string }>`select fixture_plan::text as plan
    from symmy_integration.job_routes where tenant_id=${fixture.tenantId} and route_id=${fixture.selectedRouteId}`;
  if (configured === undefined) {
    return yield* new SymmyC14ProductFixtureUnavailable({ message: 'The prices route is not enrolled' });
  }
  const foreign = yield* Effect.acquireUseRelease(
    fixture.admin`update symmy_integration.job_routes
      set fixture_plan=jsonb_set(fixture_plan,'{sourceRouteId}',to_jsonb(${randomUUID()}::text))
      where tenant_id=${fixture.tenantId} and route_id=${fixture.selectedRouteId}`,
    () => send(body),
    () =>
      fixture.admin`update symmy_integration.job_routes set fixture_plan=${configured.plan}::jsonb
        where tenant_id=${fixture.tenantId} and route_id=${fixture.selectedRouteId}`.pipe(Effect.orDie),
  );
  expect(foreign.status).toBe(403);
  expect(yield* foreign.json).toEqual(yield* unknown.json);
  // The internal plan body is no longer a body of this route.
  const internal = yield* send({ contractVersion: 'INTERNAL_C14', plan: { items: [] } });
  expect(internal.status).toBe(400);
  // The old path with a code segment finds no route.
  const oldPath = yield* client.post(`${fixture.shell.baseUrl}/api/symmy/v1/price-lists/some-code/prices/batch`, {
    body: yield* HttpBody.json(body),
    headers: refusedHeaders,
  });
  expect(oldPath.status).toBe(404);
  expect(yield* ownerCounts).toEqual(before);
  return yield* Effect.void;
});

/** An existing list does not hold back the new one behind it: each create fences on the head it meets. */
const assertExistingListDoesNotBlockNewOne = Effect.fn('InternalC14PricingRoutes.existingThenNew')(
  function* existingThenNew<E, R>(
    fixture: PricingFixture,
    existing: ReturnType<typeof publicList>,
    settleLists: (key: string, lists: readonly unknown[]) => Effect.Effect<typeof statusSchema.Type, E, R>,
  ) {
    const groupCount = fixture.admin<{ count: number }>`select count(*)::integer as count
      from price_group_catalog.price_groups where tenant_id=${fixture.tenantId}`;
    const [before] = yield* groupCount;
    const startsAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, groupScheduleLeadTime));
    const settled = yield* settleLists('INTERNAL_C14_EXISTING_AND_NEW_LISTS', [
      existing,
      publicList({
        businessCode: 'INTERNAL_C14_PRICE_GROUP_MIXED',
        code: 'INTERNAL_C14_MIXED_NEW_LIST',
        effectiveFrom: startsAt,
        prices: [],
        purpose: 'Explicit INTERNAL_C14 existing list followed by a new list',
      }),
    ]);
    expect(outcomesOf(settled)).toEqual(['conflict', 'accepted_change']);
    expect((yield* groupCount)[0]?.count).toBe((before?.count ?? 0) + 1);
    // A list is readable once its definition starts, so the projections that follow wait for it.
    yield* waitUntil(DateTime.makeUnsafe(startsAt));
  },
);

const refRecord = Schema.Record(Schema.String, Schema.Json);
const inTenant = (ref: Schema.Json, tenantId: string): Schema.Json => ({
  ...Schema.decodeUnknownSync(refRecord)(ref),
  tenantId,
});

/**
 * A price that names another tenant is not accepted for its item. It neither fails the request nor holds back the
 * list it belongs to or the lists beside it.
 */
const assertForeignTenantPrices = Effect.fn('InternalC14PricingRoutes.foreignTenantPrices')(
  function* foreignTenantPrices<E, R>(
    fixture: PricingFixture,
    input: {
      readonly priceFacts: Omit<Parameters<typeof publicPrice>[0], 'at'>;
      readonly settleLists: (key: string, lists: readonly unknown[]) => Effect.Effect<typeof statusSchema.Type, E, R>;
    },
  ) {
    const foreignTenantId = randomUUID();
    const startsAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, groupScheduleLeadTime));
    const own = publicPrice({ ...input.priceFacts, at: startsAt });
    const foreignUnit = { ...input.priceFacts, unitRef: inTenant(input.priceFacts.unitRef, foreignTenantId) };
    const foreign = yield* input.settleLists('INTERNAL_C14_FOREIGN_TENANT_PRICE', [
      publicList({
        businessCode: 'INTERNAL_C14_PRICE_GROUP_FOREIGN',
        code: 'INTERNAL_C14_FOREIGN_PRICE_LIST',
        effectiveFrom: startsAt,
        prices: [
          { ...own, productRef: inTenant(own.productRef, foreignTenantId) },
          publicPrice({ ...foreignUnit, at: startsAt }),
        ],
        purpose: 'Explicit INTERNAL_C14 prices of another tenant',
      }),
      publicList({
        businessCode: 'INTERNAL_C14_PRICE_GROUP_AFTER_FOREIGN',
        code: 'INTERNAL_C14_AFTER_FOREIGN_LIST',
        effectiveFrom: startsAt,
        prices: [],
        purpose: 'Explicit INTERNAL_C14 list after prices of another tenant',
      }),
    ]);
    expect(outcomesOf(foreign)).toEqual(['accepted_change', 'unsupported', 'unsupported', 'accepted_change']);
    const [prices] = yield* fixture.admin<{
      count: number;
    }>`select count(*)::integer as count from pricing.prices where tenant_id=${fixture.tenantId}`;
    expect(prices?.count).toBe(1);
    yield* waitUntil(DateTime.makeUnsafe(startsAt));
  },
);

it.live(
  'INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority',
  () =>
    Effect.scoped(
      Effect.gen(function* nativePriceListRoutes() {
        const fixture = yield* makeInternalC14PricingRouteFixture();
        yield* Effect.logInfo({ phase: 'pricing-fixture-ready' });
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? Effect.logError(
                'INTERNAL_C14 Pricing fixture exit',
                Cause.prettyErrors(exit.cause).map(({ name, stack }) => ({
                  location: stack?.match(/symmy-c14-pricing-routes-[a-z-]+(?:\.test)?\.mts:\d+:\d+/u)?.[0],
                  type: name,
                })),
              ).pipe(
                Effect.andThen(
                  Effect.all(
                    {
                      gateway: fixture.shell.gatewayDiagnostics(),
                      group: fixture.groupOwner.diagnostic,
                      issuer: fixture.shell.issuerDiagnostics(),
                      pricing: fixture.pricingOwner.diagnostic,
                      release: fixture.shell.releaseDiagnostics(),
                      requests: fixture.shell.requestDiagnostics(),
                      worker: fixture.worker.diagnostic,
                    },
                    { concurrency: 1 },
                  ).pipe(
                    Effect.flatMap((diagnostics) =>
                      Effect.logError('INTERNAL_C14 Pricing fixture failure diagnostics', diagnostics),
                    ),
                    Effect.catch(() => Effect.logError('INTERNAL_C14 Pricing fixture diagnostics unavailable')),
                  ),
                ),
              )
            : Effect.void,
        );
        const client = yield* HttpClient.HttpClient;
        const headers = { 'x-api-key': Redacted.value(fixture.key.secret) };
        const submit = (idempotencyKey: string, priceLists: readonly unknown[]) =>
          Effect.gen(function* submitPriceLists() {
            const response = yield* client.post(`${fixture.shell.baseUrl}/api/symmy/v1/price-lists/batch-upsert`, {
              body: yield* HttpBody.json({ priceLists }),
              headers: { ...headers, 'idempotency-key': idempotencyKey },
            });
            if (response.status !== 202) {
              const problem = yield* response.json.pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.Struct({
                      code: Schema.optionalKey(Schema.String),
                      reason: Schema.optionalKey(Schema.String),
                      title: Schema.optionalKey(Schema.String),
                      type: Schema.optionalKey(Schema.String),
                    }),
                  ),
                ),
              );
              const owner = yield* fixture.symmyOwner.diagnostic;
              const gateway = yield* fixture.shell.gatewayDiagnostics();
              const release = yield* fixture.shell.releaseDiagnostics();
              return yield* new SymmyC14ProductFixtureUnavailable({
                message: `Actual ${idempotencyKey} admission HTTP ${response.status}; problem: ${JSON.stringify(problem)}; owner: ${owner}; gateway: ${JSON.stringify(gateway)}; release: ${JSON.stringify(release)}`,
              });
            }
            expect(response.status).toBe(202);
            return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(admitted)));
          });
        const groupLists = [
          publicList({
            businessCode: 'INTERNAL_C14_PRICE_GROUP_A',
            code: fixture.firstRecordId,
            effectiveFrom: fixture.at,
            prices: [],
            purpose: 'Explicit INTERNAL_C14 source group pricing',
          }),
          publicList({
            businessCode: 'INTERNAL_C14_PRICE_GROUP_B',
            code: fixture.secondRecordId,
            effectiveFrom: fixture.at,
            prices: [],
            purpose: 'Explicit INTERNAL_C14 contractor source group pricing',
          }),
        ];
        const receipt = yield* submit('INTERNAL_C14_PRICE_GROUPS', groupLists);
        expect(yield* submit('INTERNAL_C14_PRICE_GROUPS', groupLists)).toEqual(receipt);
        // The same key with other content is refused before anything is read or written.
        const conflicting = yield* client.post(`${fixture.shell.baseUrl}/api/symmy/v1/price-lists/batch-upsert`, {
          body: yield* HttpBody.json({ priceLists: [groupLists[0]] }),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_PRICE_GROUPS' },
        });
        expect(conflicting.status).toBe(409);
        const readStatus = (jobId: string) =>
          Effect.gen(function* actualJobStatus() {
            const response = yield* client.get(`${fixture.shell.baseUrl}/api/symmy/v1/jobs/${jobId}`, {
              headers,
            });
            if (response.status !== 200) {
              const problems = yield* response.json.pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.Struct({
                      code: Schema.optionalKey(Schema.String),
                      reason: Schema.optionalKey(Schema.String),
                      status: Schema.optionalKey(Schema.Int),
                    }),
                  ),
                ),
              );
              const diagnostic = yield* fixture.symmyOwner.diagnostic;
              const workerDiagnostic = yield* fixture.worker.diagnostic;
              const gateway = yield* fixture.shell.gatewayDiagnostics();
              const release = yield* fixture.shell.releaseDiagnostics();
              return yield* new SymmyC14ProductFixtureUnavailable({
                message: `Actual status HTTP ${response.status}; ${JSON.stringify(problems)}; owner: ${diagnostic}; worker: ${workerDiagnostic}; gateway: ${JSON.stringify(gateway)}; release: ${JSON.stringify(release)}`,
              });
            }
            return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(statusSchema)));
          });
        const completed = yield* observe(
          'Actual Price Groups did not settle',
          readStatus(receipt.jobId),
          (value) =>
            value.status.startsWith('completed_') || value.status === 'blocked' || value.status === 'indeterminate',
        ).pipe(
          Effect.catchTag('SymmyC14ProductFixtureUnavailable', (failure) =>
            fixture.worker.diagnostic.pipe(
              Effect.flatMap((diagnostic) =>
                Effect.fail(new SymmyC14ProductFixtureUnavailable({ message: `${failure.message}; ${diagnostic}` })),
              ),
            ),
          ),
        );
        if (completed.status !== 'completed_all') {
          const groupDiagnostic = yield* fixture.groupOwner.diagnostic;
          const workerDiagnostic = yield* fixture.worker.diagnostic;
          const gateway = yield* fixture.shell.gatewayDiagnostics();
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: `Actual group job: ${JSON.stringify(completed)}; group: ${groupDiagnostic}; worker: ${workerDiagnostic}; gateway: ${JSON.stringify(gateway)}`,
          });
        }
        expect((completed.items ?? []).flatMap((item) => item.effects).map(({ status }) => status)).toEqual([
          'accepted_change',
          'accepted_change',
        ]);
        const inputs = yield* bootstrapInternalC14PricingRouteInputs(fixture);
        yield* Effect.logInfo({ phase: 'pricing-groups-and-inputs-ready' });
        expect(inputs.readiness.evidence).toBeDefined();
        yield* waitUntil(DateTime.makeUnsafe(fixture.at));
        const get = (query: string, expectedStatus = 200) =>
          Effect.gen(function* readActualPriceListProjection() {
            const response = yield* client.get(`${fixture.shell.baseUrl}/api/symmy/v1/price-lists?${query}`, {
              headers,
            });
            if (response.status !== expectedStatus) {
              const problem = yield* response.json.pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.Struct({
                      code: Schema.optionalKey(Schema.String),
                      reason: Schema.optionalKey(Schema.String),
                      title: Schema.optionalKey(Schema.String),
                      type: Schema.optionalKey(Schema.String),
                    }),
                  ),
                ),
              );
              const group = yield* fixture.groupOwner.diagnostic;
              const pricing = yield* fixture.pricingOwner.diagnostic;
              const proxy = yield* fixture.priceBarrier.diagnostic;
              const symmy = yield* fixture.symmyOwner.diagnostic;
              const gateway = yield* fixture.shell.gatewayDiagnostics();
              const issuer = yield* fixture.shell.issuerDiagnostics();
              const requests = yield* fixture.shell.requestDiagnostics();
              const release = yield* fixture.shell.releaseDiagnostics();
              return yield* new SymmyC14ProductFixtureUnavailable({
                message: `Actual Price List projection HTTP ${response.status}; problem: ${JSON.stringify(problem)}; group: ${group}; pricing: ${pricing}; proxy: ${proxy}; symmy: ${symmy}; gateway: ${JSON.stringify(gateway)}; issuer: ${JSON.stringify(issuer)}; requests: ${JSON.stringify(requests)}; release: ${JSON.stringify(release)}`,
              });
            }
            return response;
          });
        const firstResponse = yield* get(firstPageQuery);
        const first = yield* firstResponse.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)));
        expect({ count: first.count, limit: first.limit, offset: first.offset }).toEqual({
          count: 2,
          limit: 1,
          offset: 0,
        });
        expect(first.priceLists).toHaveLength(1);
        const secondResponse = yield* get('limit=1&offset=1');
        expect(secondResponse.status).toBe(200);
        const second = yield* secondResponse.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)));
        expect({ count: second.count, limit: second.limit, offset: second.offset }).toEqual({
          count: 2,
          limit: 1,
          offset: 1,
        });
        expect(second.priceLists).toHaveLength(1);
        const all = [...first.priceLists, ...second.priceLists];
        expect(
          EffectArray.sort(
            all.map(({ code }) => code),
            Order.String,
          ),
        ).toEqual(EffectArray.sort([fixture.firstRecordId, fixture.secondRecordId], Order.String));
        expect(new Set(all.map(({ code }) => code)).size).toBe(2);
        for (const list of all) {
          expect(list.priceGroupRef.resourceType).toBe('pricing.price-group-catalog.price-group');
          expect(list.priceGroupRef.tenantId).toBe(fixture.tenantId);
        }
        expect(new Set(all.map(({ priceGroupRef }) => priceGroupRef.resourceId)).size).toBe(2);
        const [forbidden] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${fixture.tenantId} and (action_key like 'commerce.customer-context.%' or action_key like '%promotion%' or action_key like 'commerce.tax.%' or action_key like 'commerce.assortment.%')`;
        expect(forbidden?.count).toBe(0);
        // A create-only body never changes an existing price list: its business code is already owned.
        const retry = yield* submit(`INTERNAL_C14_PRICE_GROUPS_RETRY_${randomUUID()}`, groupLists);
        const replayed = yield* observe(
          'Actual Price Group replay did not settle',
          readStatus(retry.jobId),
          (value) =>
            value.status.startsWith('completed_') || value.status === 'blocked' || value.status === 'indeterminate',
        );
        // Every list answers for itself: both business codes are owned, so both end conflict.
        expect(outcomesOf(replayed)).toEqual(['conflict', 'conflict']);
        const replayProjectionResponse = yield* get('limit=2&offset=0');
        expect(replayProjectionResponse.status).toBe(200);
        const replayProjection = yield* replayProjectionResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
        );
        expect(replayProjection.count).toBe(2);
        expect(replayProjection.priceLists.map(({ priceGroupRef }) => priceGroupRef)).toEqual(
          all.map(({ priceGroupRef }) => priceGroupRef),
        );
        const originalGroup = all.find(({ code }) => code === fixture.firstRecordId);
        assert.isOk(originalGroup);
        const originalGroupRef = originalGroup.priceGroupRef;
        const heldEffectiveAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, groupScheduleLeadTime));
        const priceFacts = {
          marketId: inputs.market.marketRef.resourceId,
          selection: inputs.readiness.selection,
          unitRef: inputs.unit.unit,
        };
        const missingAuthority = [
          publicList({
            businessCode: 'INTERNAL_C14_PRICE_GROUP_HELD',
            code: 'INTERNAL_C14_HELD_PRICE_LIST',
            effectiveFrom: heldEffectiveAt,
            prices: [publicPrice({ ...priceFacts, at: heldEffectiveAt })],
            purpose: 'Explicit INTERNAL_C14 held source group pricing',
          }),
        ];
        // A known negative native ACK is never reissued as if no canonical row proved non-commit.
        const heldJob = yield* submit('INTERNAL_C14_MISSING_PRICE_AUTHORITY', missingAuthority);
        const held = yield* observe(
          'The actual missing-authority Price did not settle',
          readStatus(heldJob.jobId),
          (value) => value.status.startsWith('completed_') || value.status === 'indeterminate',
        );
        if (held.status !== 'completed_partial') {
          const group = yield* fixture.groupOwner.diagnostic;
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: `Actual missing-authority job: ${JSON.stringify(held)}; explicit Group effectiveAt: ${heldEffectiveAt}; observedAt: ${DateTime.formatIso(yield* DateTime.now)}; native Group: ${group}`,
          });
        }
        expect(held.status).toBe('completed_partial');
        expect((held.items ?? []).flatMap((item) => item.effects).map(({ status }) => status)).toEqual([
          'accepted_change',
          'unresolved',
        ]);
        expect(yield* submit('INTERNAL_C14_MISSING_PRICE_AUTHORITY', missingAuthority)).toEqual(heldJob);
        const [afterHeld] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from pricing.prices where tenant_id=${fixture.tenantId}`;
        expect(afterHeld?.count).toBe(0);
        yield* waitUntil(DateTime.makeUnsafe(heldEffectiveAt));
        const heldGroupResponse = yield* get('limit=100&offset=0');
        expect(heldGroupResponse.status).toBe(200);
        const heldGroups = yield* heldGroupResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
        );
        const heldGroup = heldGroups.priceLists.find(({ code }) => code === 'INTERNAL_C14_HELD_PRICE_LIST');
        assert.isOk(heldGroup);
        const groupEffectiveAt = DateTime.add(yield* DateTime.now, groupScheduleLeadTime);
        const deferred = [
          publicList({
            businessCode: 'INTERNAL_C14_PRICE_GROUP_C',
            code: 'INTERNAL_C14_NEW_PRICE_LIST_C',
            effectiveFrom: DateTime.formatIso(groupEffectiveAt),
            prices: [publicPrice({ ...priceFacts, at: DateTime.formatIso(groupEffectiveAt) })],
            purpose: 'Explicit INTERNAL_C14 API exclusive source group pricing',
          }),
        ];
        yield* fixture.priceBarrier.armForNextPrice;
        const deferredJob = yield* submit('INTERNAL_C14_NEW_GROUP_AND_PRICE', deferred);
        const actualRequest = yield* fixture.priceBarrier.arrived.pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(20),
            orElse: () =>
              Effect.gen(function* describeMissingNativePriceDispatch() {
                const status = yield* readStatus(deferredJob.jobId);
                const worker = yield* fixture.worker.diagnostic;
                const pricing = yield* fixture.pricingOwner.diagnostic;
                const proxy = yield* fixture.priceBarrier.diagnostic;
                return yield* new SymmyC14ProductFixtureUnavailable({
                  message: `The deferred Price never reached its actual dispatch boundary; status: ${JSON.stringify(status)}; worker: ${worker}; pricing: ${pricing}; proxy: ${proxy}`,
                });
              }),
          }),
        );
        const parentRows =
          yield* fixture.admin`select owner_receipt from symmy_integration.job_effects where tenant_id=${fixture.tenantId} and job_id=${deferredJob.jobId} and effect_key='group-create'`.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(
                  Schema.Struct({
                    owner_receipt: Schema.Struct({
                      _tag: Schema.Literal('PriceGroupCreated'),
                      priceGroupRef: PriceGroupRefSchema,
                      prices: Schema.optionalKey(PriceGroupSourcePricesResponseSchema),
                    }),
                  }),
                ),
              ),
            ),
          );
        expect(parentRows).toHaveLength(1);
        const [parentReceipt] = parentRows;
        const newPriceId = actualRequest.priceRef.resourceId;
        expect(actualRequest.identityKey.catalogSelection).toEqual(inputs.readiness.selection);
        expect(actualRequest.identityKey.priceGroupSelector).toEqual({
          kind: 'PRICE_GROUP',
          priceGroupRef: parentReceipt.owner_receipt.priceGroupRef,
        });
        yield* waitUntil(groupEffectiveAt);
        const exactGrant = yield* decodeInternalC14CapturedPriceGrant(
          actualRequest,
          DateTime.formatIso(yield* DateTime.now),
        );
        // This explicit operator fixture setup makes no claim of production auto-granting or upfront grantability.
        yield* bootstrapInternalC14PricingSourceAuthority({
          grant: exactGrant,
          legalEntityId: fixture.legalEntityId,
          operatorPrincipalId: fixture.integration.issuerPrincipalId,
          operatorProviderUserId: fixture.shell.providerUserId,
          ownedDatabase: fixture.isolated,
          purpose: pricingFixturePurpose,
          runtimeConnectionString: Redacted.make(fixture.isolated.connections.runtime.connectionString),
          tenantId: fixture.tenantId,
        });
        yield* fixture.priceBarrier.release;
        const lostAck = yield* fixture.priceBarrier.committedReplyLost.pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(20),
            orElse: () =>
              Effect.fail(
                new SymmyC14ProductFixtureUnavailable({
                  message: 'The actual Price did not commit before its deliberate ACK loss',
                }),
              ),
          }),
        );
        expect(lostAck.provenance.canonicalLink.priceRef.resourceId).toBe(newPriceId);
        yield* fixture.worker.child.kill();
        yield* fixture.worker.child.exitCode;
        expect(yield* fixture.priceBarrier.sourceReceiptReads).toBe(0);
        const beforeRestart = yield* readStatus(deferredJob.jobId);
        expect(beforeRestart.status.startsWith('completed_')).toBe(false);
        const [afterLostAck] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from pricing.prices where tenant_id=${fixture.tenantId}`;
        expect(afterLostAck?.count).toBe(1);
        const restarted = yield* startProductWorker(fixture.workerArtifact, {
          ...fixture.environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_PRICING_RESTARTED_PROCESS',
        });
        const defined = yield* Effect.raceFirst(
          observe(
            'The restarted worker did not recover the committed Price receipt',
            readStatus(deferredJob.jobId),
            (value) => value.status.startsWith('completed_'),
          ),
          restarted.child.exitCode.pipe(
            Effect.flatMap((code) =>
              Effect.fail(
                new SymmyC14ProductFixtureUnavailable({
                  message: `The restarted native Price worker exited before recovery with code ${code}`,
                }),
              ),
            ),
          ),
        ).pipe(
          Effect.catchTag('SymmyC14ProductFixtureUnavailable', (failure) =>
            Effect.gen(function* describeUnsettledPriceRecovery() {
              const retainedStatus = yield* readStatus(deferredJob.jobId).pipe(
                Effect.catch(() => Effect.succeed(null)),
              );
              const worker = yield* restarted.diagnostic;
              const pricing = yield* fixture.pricingOwner.diagnostic;
              const commands = yield* fixture.priceBarrier.armedPriceCommandCount;
              const receiptReads = yield* fixture.priceBarrier.sourceReceiptReads;
              const gateway = yield* fixture.shell.gatewayDiagnostics();
              const issuer = yield* fixture.shell.issuerDiagnostics();
              const facts = yield* fixture.admin<{
                admitted_intent: string;
                executor_matches: boolean;
                invocation_matches: boolean;
                request_hash_matches: boolean;
                resolved_intent: null | string;
                state: string;
              }>`select e.effect #>> '{intent,_tag}' as admitted_intent,
                e.owner_executor_principal_id is not distinct from i.principal_id as executor_matches,
                e.owner_invocation_id is not distinct from i.action_invocation_id as invocation_matches,
                e.owner_request_hash is not distinct from i.request_hash as request_hash_matches,
                e.resolved_effect #>> '{intent,_tag}' as resolved_intent,e.state
                from symmy_integration.job_effects e join core.action_invocations i
                  on i.tenant_id=e.tenant_id and i.idempotency_key=e.effect_id::text
                  and i.principal_id=${fixture.systemId}
                  and i.action_key='commerce.pricing.define-price' and i.status='succeeded'
                where e.tenant_id=${fixture.tenantId} and e.job_id=${deferredJob.jobId} and e.effect_key='price-define'`;
              return yield* new SymmyC14ProductFixtureUnavailable({
                message: `${failure.message}; status: ${JSON.stringify(retainedStatus)}; commands: ${commands}; receiptReads: ${receiptReads}; facts: ${JSON.stringify(facts)}; pricing: ${pricing}; worker: ${worker}; gateway: ${JSON.stringify(gateway)}; issuer: ${JSON.stringify(issuer)}`,
              });
            }),
          ),
        );
        if (defined.status !== 'completed_all') {
          const pricing = yield* fixture.pricingOwner.diagnostic;
          const proxy = yield* fixture.priceBarrier.diagnostic;
          const worker = yield* restarted.diagnostic;
          const gateway = yield* fixture.shell.gatewayDiagnostics();
          const calls = yield* fixture.admin<{
            action_key: string;
            status: string;
          }>`select action_key,status from core.action_invocations where tenant_id=${fixture.tenantId} and action_key='commerce.pricing.define-price'`;
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: `Actual deferred Price outcome: ${JSON.stringify(defined)}; native calls: ${JSON.stringify(calls)}; pricing: ${pricing}; proxy: ${proxy}; worker: ${worker}; gateway: ${JSON.stringify(gateway)}`,
          });
        }
        expect(defined.status).toBe('completed_all');
        expect((defined.items ?? []).flatMap((item) => item.effects).map(({ status }) => status)).toEqual([
          'accepted_change',
          'accepted_change',
        ]);
        expect(yield* fixture.priceBarrier.armedPriceCommandCount).toBe(1);
        expect(yield* fixture.priceBarrier.sourceReceiptReads).toBeGreaterThanOrEqual(1);
        yield* Effect.logInfo({ phase: 'pricing-committed-price-recovered' });

        // An existing business code ends conflict for its list and its price is not accepted, nothing is written.
        const duplicateJob = yield* submit('INTERNAL_C14_EXISTING_LIST_WITH_PRICE', deferred);
        const duplicated = yield* observe(
          'The existing price list did not settle',
          readStatus(duplicateJob.jobId),
          (value) => value.status.startsWith('completed_') || value.status === 'indeterminate',
        );
        expect((duplicated.items ?? []).flatMap((item) => item.effects).map(({ status }) => status)).toEqual([
          'conflict',
          'unsupported',
        ]);
        const [afterDuplicate] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from pricing.prices where tenant_id=${fixture.tenantId}`;
        expect(afterDuplicate?.count).toBe(1);

        const settleLists = (idempotencyKey: string, lists: readonly unknown[]) =>
          submit(idempotencyKey, lists).pipe(
            Effect.flatMap((job) =>
              observe(
                `The price lists ${idempotencyKey} did not settle`,
                readStatus(job.jobId),
                (value) => value.status.startsWith('completed_') || value.status === 'indeterminate',
              ),
            ),
          );
        yield* assertExistingListDoesNotBlockNewOne(fixture, groupLists[0], settleLists);
        yield* assertForeignTenantPrices(fixture, { priceFacts, settleLists });

        const selectedAt = DateTime.formatIso(yield* DateTime.now);
        const batchPrice = { ...publicPrice({ ...priceFacts, at: selectedAt }), operation: 'DEFINE' };
        const otherGroup = all.find(({ code }) => code === fixture.secondRecordId);
        assert.isOk(otherGroup);
        yield* assertPriceBatchRefusals(fixture, { priceGroupRef: originalGroupRef }, batchPrice);
        yield* Effect.logInfo({ phase: 'pricing-independent-list-controls-accepted' });
        const submitPrices = (
          idempotencyKey: string,
          priceGroupRef: typeof PriceGroupRefSchema.Type,
          prices: readonly Schema.Json[],
        ) =>
          Effect.gen(function* submitPriceBatch() {
            const response = yield* client.post(`${fixture.shell.baseUrl}${pricesPath}`, {
              body: yield* HttpBody.json({ priceGroupRef, prices }),
              headers: { ...headers, 'idempotency-key': idempotencyKey },
            });
            if (response.status !== 202) {
              const pricing = yield* fixture.pricingOwner.diagnostic;
              const gateway = yield* fixture.shell.gatewayDiagnostics();
              const requests = yield* fixture.shell.requestDiagnostics();
              return yield* new SymmyC14ProductFixtureUnavailable({
                message: `Price batch ${idempotencyKey} HTTP ${response.status}; body: ${yield* response.text}; pricing: ${pricing.slice(-2500)}; gateway: ${JSON.stringify(gateway.slice(-3))}; requests: ${JSON.stringify(requests).slice(-2500)}`,
              });
            }
            return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(admitted)));
          });
        const settle = (job: typeof admitted.Type) =>
          observe(
            'The actual price batch did not settle',
            readStatus(job.jobId),
            (value) => value.status.startsWith('completed_') || value.status === 'indeterminate',
          );
        const priceCounts = fixture.admin<{ prices: number; revisions: number; revisions_called: number }>`select
          (select count(*)::integer from pricing.prices where tenant_id=${fixture.tenantId}) as prices,
          (select count(*)::integer from pricing.price_revisions where tenant_id=${fixture.tenantId}) as revisions,
          (select count(*)::integer from core.action_invocations where tenant_id=${fixture.tenantId}
            and action_key='commerce.pricing.revise-price') as revisions_called`;

        const grant = yield* decodeInternalC14PriceGrantFor({
          effectiveFrom: selectedAt,
          groupRef: originalGroupRef,
          marketId: inputs.market.marketRef.resourceId,
          selection: inputs.readiness.selection,
          sellingLegalEntityId: fixture.legalEntityId,
          unitRef: inputs.unit.unit,
          verifiedAt: selectedAt,
        });
        expect(
          yield* bootstrapInternalC14PricingSourceAuthority({
            grant,
            legalEntityId: fixture.legalEntityId,
            operatorPrincipalId: fixture.integration.issuerPrincipalId,
            operatorProviderUserId: fixture.shell.providerUserId,
            ownedDatabase: fixture.isolated,
            purpose: pricingFixturePurpose,
            runtimeConnectionString: Redacted.make(fixture.isolated.connections.runtime.connectionString),
            tenantId: fixture.tenantId,
          }),
        ).toEqual({ outcome: 'STORED' });
        const selectedJob = yield* submitPrices('INTERNAL_C14_SELECTED_PRICE', originalGroupRef, [batchPrice]);
        // The same key and body replays the job, and the same key with another body is refused.
        expect(yield* submitPrices('INTERNAL_C14_SELECTED_PRICE', originalGroupRef, [batchPrice])).toEqual(selectedJob);
        const reused = yield* client.post(`${fixture.shell.baseUrl}${pricesPath}`, {
          body: yield* HttpBody.json({
            priceGroupRef: originalGroupRef,
            prices: [{ ...batchPrice, amount: '26' }],
          }),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_SELECTED_PRICE' },
        });
        expect(reused.status).toBe(409);
        const selectedResult = yield* settle(selectedJob);
        expect(selectedResult.status).toBe('completed_all');
        expect(outcomesOf(selectedResult)).toEqual(['accepted_change']);
        const withPricesResponse = yield* get('limit=100&offset=0&priceLimit=1&priceOffset=0');
        expect(withPricesResponse.status).toBe(200);
        const withPrices = yield* withPricesResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
        );
        const priced = withPrices.priceLists.find(({ code }) => code === fixture.firstRecordId);
        assert.isOk(priced?.prices);
        expect(priced.prices.count).toBe(1);
        expect(priced.prices.prices).toHaveLength(1);
        const [nativePrice] = priced.prices.prices;
        expect(nativePrice.price.outcome).toBe('PRICE_DEFINITION_CURRENT');
        if (nativePrice.price.outcome !== 'PRICE_DEFINITION_CURRENT') {
          return yield* new SymmyC14ProductFixtureUnavailable({ message: 'The accepted native Price is not Current' });
        }
        expect(nativePrice.price.definition.priceRef.resourceType).toBe('commerce.pricing.price');
        expect(nativePrice.price.definition.identityKey.priceGroupSelector).toEqual({
          kind: 'PRICE_GROUP',
          priceGroupRef: originalGroupRef,
        });
        const emptyPricePageResponse = yield* get('limit=100&offset=0&priceLimit=1&priceOffset=1');
        expect(emptyPricePageResponse.status).toBe(200);
        const emptyPricePage = yield* emptyPricePageResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
        );
        expect(emptyPricePage.priceLists.find(({ code }) => code === fixture.firstRecordId)?.prices).toMatchObject({
          count: 1,
          limit: 1,
          offset: 1,
          prices: [],
        });
        // REVISE copies the priceRef and the revision GET /price-lists returned, unchanged.
        const { definition: listed } = nativePrice.price;
        const reviseOf = (amount: string, revisionId = listed.revision.revisionId) => ({
          amount,
          currencyCode: 'CZK',
          expectedRevision: { revision: listed.revision.revision, revisionId },
          operation: 'REVISE',
          priceRef: listed.priceRef,
        });
        const listedPrice = () =>
          get('limit=100&offset=0&priceLimit=1&priceOffset=0').pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
            Effect.map((lists) => firstListedPrice(lists, fixture.firstRecordId)),
          );
        const beforeRevise = yield* priceCounts;
        // A price of another list than the one the body names is refused for its item, and nothing is written.
        const otherList = yield* settle(
          yield* submitPrices('INTERNAL_C14_REVISE_OTHER_LIST', otherGroup.priceGroupRef, [reviseOf('30')]),
        );
        expect(otherList.status).toBe('completed_none');
        expect(outcomesOf(otherList)).toEqual(['unresolved']);
        expect(yield* priceCounts).toEqual(beforeRevise);
        // A price that names another tenant is not accepted for its item, whatever its operation. It neither fails the
        // request nor changes the items beside it, which are still judged on their own.
        const foreignRefTenantId = randomUUID();
        const ungrantedBeside = { ...batchPrice, unitBasis: { ...batchPrice.unitBasis, quantity: '3' } };
        const foreignBatch = yield* settle(
          yield* submitPrices('INTERNAL_C14_FOREIGN_TENANT_BATCH', originalGroupRef, [
            { ...batchPrice, productRef: inTenant(batchPrice.productRef, foreignRefTenantId) },
            ungrantedBeside,
            { ...reviseOf('31'), priceRef: { ...listed.priceRef, tenantId: foreignRefTenantId } },
          ]),
        );
        expect(foreignBatch.status).toBe('completed_none');
        expect(outcomesOf(foreignBatch)).toEqual(['unsupported', 'unresolved', 'unsupported']);
        expect(yield* priceCounts).toEqual(beforeRevise);
        // Items are independent. A price without a source authority grant for its exact identity is held, and a
        // revision that is no longer the current one ends conflict. Neither writes anything.
        const ungrantedPrice = { ...batchPrice, unitBasis: { ...batchPrice.unitBasis, quantity: '2' } };
        const stale = yield* settle(
          yield* submitPrices('INTERNAL_C14_REVISE_STALE', originalGroupRef, [
            ungrantedPrice,
            reviseOf('30', randomUUID()),
          ]),
        );
        expect(stale.status).toBe('completed_none');
        expect(outcomesOf(stale)).toEqual(['unresolved', 'conflict']);
        expect((yield* priceCounts).map(tableCounts)).toEqual(beforeRevise.map(tableCounts));
        expect(currentRevisionOf(yield* listedPrice())).toEqual(listed.revision);
        // The revision the caller read is the current one: the amount changes and the revision number rises. The
        // grant of the DEFINE covers it although Pricing reads the unit quantity back with nine decimals, and the
        // revision starts at the time the source asserts (the admission time), not at the owner clock.
        const beforeCurrentRevise = yield* priceCounts;
        const current = yield* settle(
          yield* submitPrices('INTERNAL_C14_REVISE_CURRENT', originalGroupRef, [reviseOf('30')]),
        );
        expect(current.status).toBe('completed_all');
        expect(outcomesOf(current)).toEqual(['accepted_change']);
        const after = yield* priceCounts;
        expect(after.map(tableCounts)).toEqual(
          beforeCurrentRevise.map(({ prices, revisions }) => ({ prices, revisions: revisions + 1 })),
        );
        expect(currentRevisionOf(yield* listedPrice())).toMatchObject({
          monetaryAmount: { amount: '30.000000000' },
          revision: listed.revision.revision + 1,
        });
        // The revision the caller read is now stale: a second revision of it ends conflict and writes nothing.
        const staleNow = yield* settle(
          yield* submitPrices('INTERNAL_C14_REVISE_AFTER_REVISION', originalGroupRef, [reviseOf('31')]),
        );
        expect(outcomesOf(staleNow)).toEqual(['conflict']);
        expect((yield* priceCounts).map(tableCounts)).toEqual(after.map(tableCounts));
        const [actualPrices] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from pricing.prices where tenant_id=${fixture.tenantId}`;
        expect(actualPrices?.count).toBe(2);
        const [implicitCalls] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${fixture.tenantId} and (action_key like 'commerce.customer-context.%' or action_key like '%promotion%' or action_key like 'commerce.tax.%' or action_key like 'commerce.assortment.%')`;
        expect(implicitCalls?.count).toBe(0);

        const revokedGroupEffectiveAt = DateTime.add(yield* DateTime.now, groupScheduleLeadTime);
        const revokedLists = [
          publicList({
            businessCode: 'INTERNAL_C14_PRICE_GROUP_REVOKED',
            code: 'INTERNAL_C14_REVOKED_PRICE_LIST',
            effectiveFrom: DateTime.formatIso(revokedGroupEffectiveAt),
            prices: [publicPrice({ ...priceFacts, at: DateTime.formatIso(revokedGroupEffectiveAt) })],
            purpose: 'Explicit INTERNAL_C14 route deactivation race',
          }),
        ];
        const { revocation } = fixture.priceBarrier;
        yield* revocation.armForNextPrice;
        const revokedJob = yield* submit('INTERNAL_C14_REVOKE_DURING_PRICE_DISPATCH', revokedLists);
        yield* Effect.logInfo({ phase: 'pricing-revisions-accepted' });
        const heldPrice = yield* revocation.arrived.pipe(Effect.timeout('20 seconds'));
        const readSettledEffects = () =>
          fixture.admin<{
            action_key: string;
            effect_key: string;
            invocation_id: string;
            job_id: string;
            outcome: string;
            outcome_status: string;
            receipt: string | null;
            receipt_kind: string | null;
          }>`
            select i.action_key,e.effect_key,e.owner_invocation_id as invocation_id,e.job_id,
              e.outcome::text as outcome,e.outcome->>'status' as outcome_status,
              e.owner_receipt::text as receipt,e.owner_receipt->>'_tag' as receipt_kind
            from symmy_integration.job_effects e join core.action_invocations i
              on i.tenant_id=e.tenant_id and i.action_invocation_id=e.owner_invocation_id
            where e.tenant_id=${fixture.tenantId} and e.state='settled' and i.status='succeeded'
              and (e.job_id in (${deferredJob.jobId},${selectedJob.jobId})
                or (e.job_id=${revokedJob.jobId} and e.effect_key='group-create'))
            order by e.job_id,e.effect_key`;
        const settledBeforeRevocation = yield* readSettledEffects();
        expect(settledBeforeRevocation).toHaveLength(4);
        expect(settledBeforeRevocation.every(({ outcome_status }) => outcome_status === 'accepted_change')).toBe(true);
        expect(
          settledBeforeRevocation.filter(({ action_key }) => action_key === 'commerce.pricing.define-price'),
        ).toHaveLength(2);
        expect(settledBeforeRevocation.filter(({ receipt_kind }) => receipt_kind === 'PriceGroupCreated')).toHaveLength(
          2,
        );
        yield* waitUntil(revokedGroupEffectiveAt);
        const revocationGrant = yield* decodeInternalC14CapturedPriceGrant(
          heldPrice,
          DateTime.formatIso(yield* DateTime.now),
        );
        yield* bootstrapInternalC14PricingSourceAuthority({
          grant: revocationGrant,
          legalEntityId: fixture.legalEntityId,
          operatorPrincipalId: fixture.integration.issuerPrincipalId,
          operatorProviderUserId: fixture.shell.providerUserId,
          ownedDatabase: fixture.isolated,
          purpose: pricingFixturePurpose,
          runtimeConnectionString: Redacted.make(fixture.isolated.connections.runtime.connectionString),
          tenantId: fixture.tenantId,
        });
        // The authenticated native request has passed the worker's route check. Commit the
        // operator's update before forwarding that same request to the receiving Action.
        const disabled = yield* fixture.admin<{ route_id: string }>`
          update symmy_integration.job_routes set active=false
          where tenant_id=${fixture.tenantId} and route_id=${fixture.routeId} and active returning route_id`;
        expect(disabled).toEqual([{ route_id: fixture.routeId }]);
        yield* revocation.release;
        expect(yield* revocation.reply.pipe(Effect.timeout('20 seconds'))).toEqual({
          code: 'action_transaction_failed',
          status: 503,
        });
        expect(yield* readSettledEffects()).toEqual(settledBeforeRevocation);
        expect(
          yield* fixture.admin<{ count: number }>`select count(*)::integer as count from pricing.prices
            where tenant_id=${fixture.tenantId}`,
        ).toEqual([actualPrices]);

        yield* restarted.child.kill();
        yield* restarted.child.exitCode;
        yield* assertInternalC14PriceRecovery({
          fixture,
          originalJobId: deferredJob.jobId,
          originalPriceRef: lostAck.provenance.canonicalLink.priceRef,
          originalProvenance: lostAck.provenance,
          selectedJobId: selectedJob.jobId,
        });
        expect(yield* fixture.priceBarrier.armedPriceCommandCount).toBe(1);
        const reader = yield* makeOwnedIntegrationPriceGroupReaderWorkloadControlNative({
          integrationPrincipalId: fixture.integration.principalId,
          operatorPrincipalId: fixture.integration.issuerPrincipalId,
          operatorProviderUserId: fixture.shell.providerUserId,
          ownedDatabase: fixture.isolated,
          purpose: pricingFixturePurpose,
          tenantId: fixture.tenantId,
        });
        yield* reader.revoke();
        const denied = yield* get(firstPageQuery, 403);
        expect(denied.status).toBe(403);
        const rebound = yield* reader.rebind();
        expect(rebound.bindingId).not.toBe(reader.originalBinding.bindingId);
        expect(rebound.incarnation).not.toBe(reader.originalBinding.incarnation);
        const enrollments = yield* fixture.admin<{
          binding_id: string;
          incarnation: string;
          revoked: boolean;
          status: string;
        }>`select binding_id,incarnation,revoked_at is not null as revoked,status from core.access_workload_bindings
          where tenant_id=${fixture.tenantId} and principal_id=${fixture.integration.principalId}
          and workload_key='pricing.price-group-catalog.source-read'`;
        expect(enrollments).toHaveLength(2);
        expect(enrollments).toContainEqual({
          binding_id: reader.originalBinding.bindingId,
          incarnation: reader.originalBinding.incarnation,
          revoked: true,
          status: 'revoked',
        });
        expect(enrollments).toContainEqual({
          binding_id: rebound.bindingId,
          incarnation: rebound.incarnation,
          revoked: false,
          status: 'active',
        });
        expect((yield* get(firstPageQuery)).status).toBe(200);
        yield* fixture.groupOwner.child.kill();
        yield* fixture.groupOwner.child.exitCode;
        const unavailable = yield* get(firstPageQuery, 503);
        expect(unavailable.status).toBe(503);
        assert.isTrue(all.every(({ code }) => code.length > 0));
        yield* Effect.logInfo({ phase: 'pricing-scenario-complete' });
        return yield* Effect.void;
      }),
    ).pipe(
      Effect.tap(() => Effect.logInfo({ phase: 'pricing-teardown-complete' })),
      Effect.provide(services),
    ),
  900_000,
);
