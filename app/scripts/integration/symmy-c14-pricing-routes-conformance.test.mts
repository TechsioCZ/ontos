import { randomUUID } from 'node:crypto';

import { CreatePriceGroupDefinitionRevisionPayloadSchema } from '@app/price-group-catalog/actions/create-price-group-definition-revision';
import { executePriceGroupDefinitionWithAuthorization } from '@app/price-group-catalog/api/client';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { bootstrapInternalC14PricingSourceAuthority } from '@app/pricing/testing/c14-source-authority-bootstrap';
import { makeOwnedIntegrationPriceGroupReaderWorkloadControlNative } from '@app/core-runtime/testing/workload-binding-native';
import { PriceGroupSourcePricesResponseSchema } from '@app/pricing/apis/price-group-source-prices';
import { PriceGroupRefSchema } from '@app/price-group-catalog/resources/price-group';
import { SymmyItemOutcomeSchema } from '@app/shared-contracts/symmy';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import { decodeSymmySourceSelector, encodeSymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { assert, expect, it } from 'effect-rstest';
import {
  Array as EffectArray,
  Cause,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Order,
  Redacted,
  Schema,
} from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { bootstrapInternalC14PricingRouteInputs } from './support/symmy-c14-pricing-routes-inputs.mts';
import {
  decodeInternalC14CapturedPriceGrant,
  decodeInternalC14DeferredPriceListPlan,
  decodeInternalC14PriceGroupRevisionPlan,
  decodeInternalC14SourcePricePlan,
  internalPricingRouteSource,
} from './support/symmy-c14-pricing-routes-plan.mts';
import { enrollInternalC14SelectedPriceRoute } from './support/symmy-c14-pricing-routes-selected.mts';
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
  status: Schema.Literal('admitted'),
});
const statusSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(SymmyItemOutcomeSchema)),
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.String,
});
const projectionSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  count: Schema.Int,
  limit: Schema.Int,
  offset: Schema.Int,
  price_lists: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      priceGroupRef: Schema.optionalKey(PriceGroupRefSchema),
      prices: Schema.optionalKey(PriceGroupSourcePricesResponseSchema),
      source_record_id: Schema.String,
    }),
  ),
  projection: Schema.Literal('price_lists'),
  unsupported_fields: Schema.Array(Schema.String),
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
const readNativeCurrentGroup = Effect.fn('InternalC14PricingRoutes.currentGroup')(function* readCurrentGroup(
  fixture: PricingFixture,
  priceGroupRef: typeof PriceGroupRefSchema.Type,
) {
  const gateway = yield* issueApiKeyGatewayContext(
    { audience: 'price-group-catalog', compositionRevision: fixture.snapshot.composition.revision },
    {
      apiKey: fixture.key.secret,
      baseUrl: `${fixture.shell.baseUrl}/shell-super-app-api`,
      requestCorrelation: randomUUID(),
    },
  );
  const result = yield* executePriceGroupDefinitionWithAuthorization(
    { priceGroupRef, trustedOperationAt: DateTime.formatIso(yield* DateTime.now) },
    `Bearer ${gateway.token}`,
    randomUUID(),
    {
      baseUrl: `${fixture.groupOwner.origin}/price-group-catalog-api`,
      compositionRevision: fixture.snapshot.composition.revision,
    },
  );
  if (result.selection !== 'CURRENT') {
    return yield* new SymmyC14ProductFixtureUnavailable({ message: 'The actual current Group fence is unavailable' });
  }
  return result;
});

const assertSelectedPriceRefusals = Effect.fn('InternalC14PricingRoutes.selectedRefusals')(function* selectedRefusals(
  fixture: PricingFixture,
  group: { readonly id: string; readonly priceGroupRef: typeof PriceGroupRefSchema.Type },
  plan: typeof SymmyInternalExecutionPlanSchema.Type,
) {
  const client = yield* HttpClient.HttpClient;
  const body = { contractVersion: 'INTERNAL_C14', plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(plan) };
  const ownerCounts = fixture.admin<{ jobs: number; writes: number }>`select
    (select count(*)::integer from symmy_integration.import_jobs where tenant_id=${fixture.tenantId}) as jobs,
    (select count(*)::integer from core.action_invocations where tenant_id=${fixture.tenantId}
      and action_key='commerce.pricing.define-price') as writes`;
  const before = yield* ownerCounts;
  const foreignAlias = encodeSymmySourceSelector(
    {
      issuerId: 'INTERNAL_C14_OTHER_ISSUER',
      routeId: fixture.sourceRouteId,
      selectorKind: 'PRICE_GROUP',
      sourceNamespace: internalPricingRouteSource.namespace,
      tenantId: fixture.tenantId,
    },
    fixture.firstRecordId,
    group.priceGroupRef.resourceId,
  );
  const refusedHeaders = {
    'idempotency-key': 'INTERNAL_C14_REFUSED_SELECTED_PRICE',
    'x-api-key': Redacted.value(fixture.key.secret),
  };
  const send = (code: string) =>
    Effect.gen(function* sendRefusedPrice() {
      return yield* client.post(`${fixture.shell.baseUrl}/api/symmy/v1/price-lists/${code}/prices/batch`, {
        body: yield* HttpBody.json(body),
        headers: refusedHeaders,
      });
    });
  expect((yield* send('unknown-c14-list')).status).toBe(403);
  expect((yield* send(foreignAlias)).status).toBe(403);
  const malformed = {
    ...body,
    plan: {
      ...body.plan,
      items: body.plan.items.map((item) => ({
        ...item,
        effects: item.effects.map((effect) =>
          Match.value(effect.intent).pipe(
            Match.when({ _tag: 'PriceDefine' }, (intent) => {
              const { unitBasis, ...withoutUnit } = intent.payload.identityKey;
              expect(unitBasis).toBeDefined();
              return { ...effect, intent: { ...intent, payload: { ...intent.payload, identityKey: withoutUnit } } };
            }),
            Match.orElse(() => effect),
          ),
        ),
      })),
    },
  };
  const malformedResponse = yield* client.post(
    `${fixture.shell.baseUrl}/api/symmy/v1/price-lists/${group.id}/prices/batch`,
    { body: yield* HttpBody.json(malformed), headers: refusedHeaders },
  );
  expect(malformedResponse.status).toBe(400);
  const unboundUpsert = yield* client.post(`${fixture.shell.baseUrl}/api/symmy/v1/price-lists/batch-upsert`, {
    body: yield* HttpBody.json(body),
    headers: { ...refusedHeaders, 'idempotency-key': 'INTERNAL_C14_REFUSED_UNBOUND_PRICE' },
  });
  expect(unboundUpsert.status).toBe(403);
  const [configured] = yield* fixture.admin<{ plan: string }>`select fixture_plan::text as plan
    from symmy_integration.job_routes where tenant_id=${fixture.tenantId} and route_id=${fixture.selectedRouteId}`;
  if (configured === undefined) {
    return yield* new SymmyC14ProductFixtureUnavailable({ message: 'The selected Pricing fixture is not enrolled' });
  }
  const unboundLiteralCode = 'INTERNAL_C14_UNBOUND_LIST';
  yield* Effect.acquireUseRelease(
    fixture.admin`update symmy_integration.job_routes set fixture_plan=fixture_plan-'selector', route_code=${unboundLiteralCode}
      where tenant_id=${fixture.tenantId} and route_id=${fixture.selectedRouteId}`,
    Effect.fn('InternalC14PricingRoutes.rejectUnselectedFixture')(function* rejectUnselectedFixture() {
      const unboundFixture = yield* client.post(
        `${fixture.shell.baseUrl}/api/symmy/v1/price-lists/${unboundLiteralCode}/prices/batch`,
        {
          body: yield* HttpBody.json({ fixtureId: 'INTERNAL_C14' }),
          headers: { ...refusedHeaders, 'idempotency-key': 'INTERNAL_C14_REFUSED_UNBOUND_FIXTURE' },
        },
      );
      expect(unboundFixture.status).toBe(403);
    }),
    () =>
      fixture.admin`update symmy_integration.job_routes set fixture_plan=${configured.plan}::jsonb, route_code=${fixture.firstRecordId}
      where tenant_id=${fixture.tenantId} and route_id=${fixture.selectedRouteId}`.pipe(Effect.orDie),
  );
  expect(yield* ownerCounts).toEqual(before);
  return yield* Effect.void;
});

const groupLookupRef = Effect.fn('InternalC14PricingRoutes.groupLookupRef')(function* lookupRef(
  id: string,
  tenantId: string,
) {
  return yield* Match.value(yield* decodeSymmySourceSelector(id)).pipe(
    Match.tag('Legacy', () =>
      Effect.fail(new SymmyC14ProductFixtureUnavailable({ message: 'The projected list has no qualified selector' })),
    ),
    Match.tag('Qualified', ({ targetResourceId }) =>
      Schema.decodeUnknownEffect(PriceGroupRefSchema)({
        moduleId: 'pricing.price-group-catalog',
        resourceId: targetResourceId,
        resourceType: 'pricing.price-group-catalog.price-group',
        tenantId,
      }),
    ),
    Match.exhaustive,
  );
});

const assertWrongGroupRefused = Effect.fn('InternalC14PricingRoutes.wrongGroupRefusal')(function* wrongGroupRefusal<
  E,
  R,
>(
  response: HttpClientResponse.HttpClientResponse,
  readStatus: (jobId: string) => Effect.Effect<typeof statusSchema.Type, E, R>,
) {
  if (response.status === 202) {
    const job = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(admitted)));
    const refused = yield* observe('The mismatched Price Group did not settle', readStatus(job.jobId), (value) =>
      value.status.startsWith('completed_'),
    );
    expect(refused.status).toBe('completed_none');
    expect((refused.items ?? []).flatMap((item) => item.effects).map(({ status }) => status)).toEqual(['unresolved']);
  } else {
    expect(response.status).toBe(403);
  }
});

it.live(
  'INTERNAL_C14 Price List routes preserve real source Group identity, paging and current read authority',
  () =>
    Effect.scoped(
      Effect.gen(function* nativePriceListRoutes() {
        const fixture = yield* makeInternalC14PricingRouteFixture();
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
        const submit = (idempotencyKey: string, plan = fixture.plan) =>
          Effect.gen(function* submitGroupPlan() {
            const response = yield* client.post(`${fixture.shell.baseUrl}/api/symmy/v1/price-lists/batch-upsert`, {
              body: yield* HttpBody.json({
                contractVersion: 'INTERNAL_C14',
                plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(plan),
              }),
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
        const receipt = yield* submit('INTERNAL_C14_PRICE_GROUPS');
        expect(yield* submit('INTERNAL_C14_PRICE_GROUPS')).toEqual(receipt);
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
        expect(inputs.readiness.evidence).toBeDefined();
        yield* waitUntil(DateTime.makeUnsafe(fixture.at));
        const get = (query: string, expectedStatus = 200) =>
          Effect.gen(function* readActualPriceListProjection() {
            const response = yield* client.get(
              `${fixture.shell.baseUrl}/api/symmy/v1/price-lists?contractVersion=INTERNAL_C14&${query}`,
              { headers },
            );
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
        expect(first.price_lists).toHaveLength(1);
        const secondResponse = yield* get('limit=1&offset=1');
        expect(secondResponse.status).toBe(200);
        const second = yield* secondResponse.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)));
        expect({ count: second.count, limit: second.limit, offset: second.offset }).toEqual({
          count: 2,
          limit: 1,
          offset: 1,
        });
        expect(second.price_lists).toHaveLength(1);
        const all = [...first.price_lists, ...second.price_lists];
        expect(
          EffectArray.sort(
            all.map(({ source_record_id }) => source_record_id),
            Order.String,
          ),
        ).toEqual(EffectArray.sort([fixture.firstRecordId, fixture.secondRecordId], Order.String));
        expect(new Set(all.map(({ id }) => id)).size).toBe(2);
        for (const list of all) {
          expect(list.id).toHaveLength(87);
          expect(list).not.toHaveProperty('priceGroupRef');
          const filteredResponse = yield* get(`code=${encodeURIComponent(list.source_record_id)}&limit=1&offset=0`);
          expect(filteredResponse.status).toBe(200);
          const filtered = yield* filteredResponse.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
          );
          expect(filtered.count).toBe(1);
          expect(filtered.price_lists).toEqual([list]);
        }
        const [forbidden] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${fixture.tenantId} and (action_key like 'commerce.customer-context.%' or action_key like '%promotion%' or action_key like 'commerce.tax.%' or action_key like 'commerce.assortment.%')`;
        expect(forbidden?.count).toBe(0);
        const retry = yield* submit(`INTERNAL_C14_PRICE_GROUPS_RETRY_${randomUUID()}`);
        const replayed = yield* observe(
          'Actual Price Group replay did not settle',
          readStatus(retry.jobId),
          (value) =>
            value.status.startsWith('completed_') || value.status === 'blocked' || value.status === 'indeterminate',
        );
        expect((replayed.items ?? []).flatMap((item) => item.effects).map(({ status }) => status)).toEqual([
          'duplicate',
          'duplicate',
        ]);
        const replayProjectionResponse = yield* get('limit=2&offset=0');
        expect(replayProjectionResponse.status).toBe(200);
        const replayProjection = yield* replayProjectionResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
        );
        expect(replayProjection.count).toBe(2);
        expect(replayProjection.price_lists.map(({ id }) => id)).toEqual(all.map(({ id }) => id));
        const originalGroup = all.find(({ source_record_id }) => source_record_id === fixture.firstRecordId);
        assert.isOk(originalGroup);
        const originalGroupRef = yield* groupLookupRef(originalGroup.id, fixture.tenantId);
        const current = yield* readNativeCurrentGroup(fixture, originalGroupRef);
        const expectedCurrent = yield* Schema.decodeUnknownEffect(
          CreatePriceGroupDefinitionRevisionPayloadSchema.fields.expectedCurrent,
        )(current.currentEvidence);
        const revisionAt = DateTime.add(yield* DateTime.now, groupScheduleLeadTime);
        const revisionPlan = yield* decodeInternalC14PriceGroupRevisionPlan({
          at: DateTime.formatIso(revisionAt),
          current: expectedCurrent,
          occurrenceId: randomUUID(),
          recordId: fixture.firstRecordId,
          sourceRouteId: fixture.sourceRouteId,
        });
        const revision = yield* submit('INTERNAL_C14_PRICE_GROUP_REVISION', revisionPlan);
        const revised = yield* observe(
          'Actual Price Group revision did not settle',
          readStatus(revision.jobId),
          (value) =>
            value.status.startsWith('completed_') || value.status === 'blocked' || value.status === 'indeterminate',
        );
        expect((revised.items ?? []).flatMap((item) => item.effects).map(({ status }) => status)).toEqual([
          'accepted_change',
        ]);
        yield* waitUntil(revisionAt);
        const revisedResponse = yield* get(`code=${encodeURIComponent(fixture.firstRecordId)}&limit=1&offset=0`);
        expect(revisedResponse.status).toBe(200);
        const revisedProjection = yield* revisedResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
        );
        expect(revisedProjection.price_lists).toEqual([{ ...originalGroup, name: 'Internal revised group A' }]);
        const beforeHeld = yield* readNativeCurrentGroup(fixture, originalGroupRef);
        const heldImportedAt = DateTime.formatIso(yield* DateTime.now);
        const heldEffectiveAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, groupScheduleLeadTime));
        const missingAuthority = yield* decodeInternalC14DeferredPriceListPlan({
          at: heldEffectiveAt,
          expectedCatalogRevision: beforeHeld.currentEvidence.catalogRevision,
          groupBusinessCode: 'INTERNAL_C14_PRICE_GROUP_HELD',
          groupOccurrenceId: randomUUID(),
          groupPurpose: 'Explicit INTERNAL_C14 held source group pricing',
          groupRecordId: 'INTERNAL_C14_HELD_PRICE_LIST',
          importedAt: heldImportedAt,
          marketId: inputs.market.marketRef.resourceId,
          occurrenceId: randomUUID(),
          priceId: randomUUID(),
          recordId: 'INTERNAL_C14_PRICE_WITHOUT_AUTHORITY',
          selection: inputs.readiness.selection,
          sellingLegalEntityId: fixture.legalEntityId,
          sourceRouteId: fixture.sourceRouteId,
          unitRef: inputs.unit.unit,
        });
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
        const heldGroupResponse = yield* get('code=INTERNAL_C14_HELD_PRICE_LIST&limit=1&offset=0');
        expect(heldGroupResponse.status).toBe(200);
        const heldGroups = yield* heldGroupResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
        );
        expect(heldGroups.price_lists).toHaveLength(1);
        const [heldGroup] = heldGroups.price_lists;
        // Current evidence is per Group: use the most recently created Group's actual fence.
        const heldGroupRef = yield* groupLookupRef(heldGroup.id, fixture.tenantId);
        const refreshed = yield* readNativeCurrentGroup(fixture, heldGroupRef);
        const importedAt = DateTime.formatIso(yield* DateTime.now);
        const groupEffectiveAt = DateTime.add(yield* DateTime.now, groupScheduleLeadTime);
        const newPriceId = randomUUID();
        const groupRecordId = 'INTERNAL_C14_NEW_PRICE_LIST_C';
        const deferred = yield* decodeInternalC14DeferredPriceListPlan({
          at: DateTime.formatIso(groupEffectiveAt),
          expectedCatalogRevision: refreshed.currentEvidence.catalogRevision,
          groupBusinessCode: 'INTERNAL_C14_PRICE_GROUP_C',
          groupOccurrenceId: randomUUID(),
          groupPurpose: 'Explicit INTERNAL_C14 API exclusive source group pricing',
          groupRecordId,
          importedAt,
          marketId: inputs.market.marketRef.resourceId,
          occurrenceId: randomUUID(),
          priceId: newPriceId,
          recordId: 'INTERNAL_C14_NEW_PRICE_C',
          selection: inputs.readiness.selection,
          sellingLegalEntityId: fixture.legalEntityId,
          sourceRouteId: fixture.sourceRouteId,
          unitRef: inputs.unit.unit,
        });
        yield* fixture.priceBarrier.armForPrice(newPriceId);
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
          yield* fixture.admin`select owner_receipt from symmy_integration.job_effects where tenant_id=${fixture.tenantId} and job_id=${deferredJob.jobId} and effect_key='new-group'`.pipe(
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
        expect(actualRequest.priceRef.resourceId).toBe(newPriceId);
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
        const restarted = yield* startProductWorker(
          fixture.workerArtifact,
          { ...fixture.environment, ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_PRICING_RESTARTED_PROCESS' },
          fixture.moduleKey.secret,
        );
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
                where e.tenant_id=${fixture.tenantId} and e.job_id=${deferredJob.jobId} and e.effect_key='new-price'`;
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

        const selectedAt = DateTime.formatIso(yield* DateTime.now);
        const selectedPriceFacts = {
          at: selectedAt,
          importedAt: selectedAt,
          marketId: inputs.market.marketRef.resourceId,
          recordId: 'INTERNAL_C14_SELECTED_PRICE_A',
          selection: inputs.readiness.selection,
          sellingLegalEntityId: fixture.legalEntityId,
          unitRef: inputs.unit.unit,
        };
        const selectedPrice = yield* decodeInternalC14SourcePricePlan({
          ...selectedPriceFacts,
          groupRef: originalGroupRef,
          occurrenceId: randomUUID(),
          priceId: randomUUID(),
        });
        yield* enrollInternalC14SelectedPriceRoute(fixture, selectedPrice);
        yield* assertSelectedPriceRefusals(
          fixture,
          { id: originalGroup.id, priceGroupRef: originalGroupRef },
          selectedPrice.plan,
        );
        const otherGroup = all.find(({ source_record_id }) => source_record_id === fixture.secondRecordId);
        assert.isOk(otherGroup);
        const wrongGroupPrice = yield* decodeInternalC14SourcePricePlan({
          ...selectedPriceFacts,
          groupRef: yield* groupLookupRef(otherGroup.id, fixture.tenantId),
          occurrenceId: randomUUID(),
          priceId: randomUUID(),
        });
        expect(
          yield* bootstrapInternalC14PricingSourceAuthority({
            grant: wrongGroupPrice.grant,
            legalEntityId: fixture.legalEntityId,
            operatorPrincipalId: fixture.integration.issuerPrincipalId,
            operatorProviderUserId: fixture.shell.providerUserId,
            ownedDatabase: fixture.isolated,
            purpose: pricingFixturePurpose,
            runtimeConnectionString: Redacted.make(fixture.isolated.connections.runtime.connectionString),
            tenantId: fixture.tenantId,
          }),
        ).toEqual({ outcome: 'STORED' });
        const priceOwnerCounts = fixture.admin<{ calls: number; prices: number }>`select
          (select count(*)::integer from core.action_invocations where tenant_id=${fixture.tenantId}
            and action_key='commerce.pricing.define-price') as calls,
          (select count(*)::integer from pricing.prices where tenant_id=${fixture.tenantId}) as prices`;
        const beforeWrongGroup = yield* priceOwnerCounts;
        const wrongGroupBody = {
          contractVersion: 'INTERNAL_C14',
          plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(wrongGroupPrice.plan),
        };
        const wrongGroupSelected = yield* client.post(
          `${fixture.shell.baseUrl}/api/symmy/v1/price-lists/${originalGroup.id}/prices/batch`,
          {
            body: yield* HttpBody.json(wrongGroupBody),
            headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_REFUSED_OTHER_GROUP_SELECTED' },
          },
        );
        yield* assertWrongGroupRefused(wrongGroupSelected, readStatus);
        const wrongGroupUpsert = yield* client.post(`${fixture.shell.baseUrl}/api/symmy/v1/price-lists/batch-upsert`, {
          body: yield* HttpBody.json(wrongGroupBody),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_REFUSED_OTHER_GROUP_UPSERT' },
        });
        expect(wrongGroupUpsert.status).toBe(403);
        expect(yield* priceOwnerCounts).toEqual(beforeWrongGroup);

        const selectedBody = {
          contractVersion: 'INTERNAL_C14',
          plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(selectedPrice.plan),
        };
        const selectedResponse = yield* client.post(
          `${fixture.shell.baseUrl}/api/symmy/v1/price-lists/${originalGroup.id}/prices/batch`,
          {
            body: yield* HttpBody.json(selectedBody),
            headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_SELECTED_PRICE' },
          },
        );
        expect(selectedResponse.status).toBe(202);
        const selectedJob = yield* selectedResponse.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(admitted)));
        const selectedResult = yield* observe(
          'The actual selected Price did not settle',
          readStatus(selectedJob.jobId),
          (value) => value.status.startsWith('completed_') || value.status === 'indeterminate',
        );
        expect(selectedResult.status).toBe('completed_all');
        expect((selectedResult.items ?? []).flatMap((item) => item.effects).map(({ status }) => status)).toEqual([
          'accepted_change',
        ]);
        const withPricesResponse = yield* get(
          `code=${encodeURIComponent(fixture.firstRecordId)}&limit=1&offset=0&priceLimit=1&priceOffset=0`,
        );
        expect(withPricesResponse.status).toBe(200);
        const withPrices = yield* withPricesResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
        );
        const priced = withPrices.price_lists.find(({ id }) => id === originalGroup.id);
        assert.isOk(priced?.prices);
        expect(priced.prices.count).toBe(1);
        expect(priced.prices.prices).toHaveLength(1);
        const [nativePrice] = priced.prices.prices;
        expect(nativePrice.price.outcome).toBe('PRICE_DEFINITION_CURRENT');
        if (nativePrice.price.outcome !== 'PRICE_DEFINITION_CURRENT') {
          return yield* new SymmyC14ProductFixtureUnavailable({ message: 'The accepted native Price is not Current' });
        }
        expect(nativePrice.price.definition.priceRef).toEqual(selectedPrice.payload.priceRef);
        expect(nativePrice.price.definition.identityKey.priceGroupSelector).toEqual({
          kind: 'PRICE_GROUP',
          priceGroupRef: originalGroupRef,
        });
        const emptyPricePageResponse = yield* get(
          `code=${encodeURIComponent(fixture.firstRecordId)}&limit=1&offset=0&priceLimit=1&priceOffset=1`,
        );
        expect(emptyPricePageResponse.status).toBe(200);
        const emptyPricePage = yield* emptyPricePageResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema)),
        );
        expect(emptyPricePage.price_lists[0]?.prices).toMatchObject({ count: 1, limit: 1, offset: 1, prices: [] });
        const [actualPrices] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from pricing.prices where tenant_id=${fixture.tenantId}`;
        expect(actualPrices?.count).toBe(2);
        const [implicitCalls] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${fixture.tenantId} and (action_key like 'commerce.customer-context.%' or action_key like '%promotion%' or action_key like 'commerce.tax.%' or action_key like 'commerce.assortment.%')`;
        expect(implicitCalls?.count).toBe(0);

        const latestGroup = yield* readNativeCurrentGroup(fixture, parentReceipt.owner_receipt.priceGroupRef);
        const revokedPriceId = randomUUID();
        const revokedGroupEffectiveAt = DateTime.add(yield* DateTime.now, groupScheduleLeadTime);
        const revokedPlan = yield* decodeInternalC14DeferredPriceListPlan({
          at: DateTime.formatIso(revokedGroupEffectiveAt),
          expectedCatalogRevision: latestGroup.currentEvidence.catalogRevision,
          groupBusinessCode: 'INTERNAL_C14_PRICE_GROUP_REVOKED',
          groupOccurrenceId: randomUUID(),
          groupPurpose: 'Explicit INTERNAL_C14 route deactivation race',
          groupRecordId: 'INTERNAL_C14_REVOKED_PRICE_LIST',
          importedAt: DateTime.formatIso(yield* DateTime.now),
          marketId: inputs.market.marketRef.resourceId,
          occurrenceId: randomUUID(),
          priceId: revokedPriceId,
          recordId: 'INTERNAL_C14_REVOKED_PRICE',
          selection: inputs.readiness.selection,
          sellingLegalEntityId: fixture.legalEntityId,
          sourceRouteId: fixture.sourceRouteId,
          unitRef: inputs.unit.unit,
        });
        const { revocation } = fixture.priceBarrier;
        yield* revocation.armForPrice(revokedPriceId);
        const revokedJob = yield* submit('INTERNAL_C14_REVOKE_DURING_PRICE_DISPATCH', revokedPlan);
        const heldPrice = yield* revocation.arrived.pipe(Effect.timeout('20 seconds'));
        expect(heldPrice.priceRef.resourceId).toBe(revokedPriceId);
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
                or (e.job_id=${revokedJob.jobId} and e.effect_key='new-group'))
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
        yield* fixture.admin`insert into core.access_workload_company_bindings(company_binding_id,incarnation,tenant_id,workload_binding_id,legal_entity_id,status)
          values(${randomUUID()},${randomUUID()},${fixture.tenantId},${rebound.bindingId},${fixture.legalEntityId},'active')`;
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
        assert.isTrue(all.every(({ source_record_id }) => source_record_id.length > 0));
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(services)),
  420_000,
);
