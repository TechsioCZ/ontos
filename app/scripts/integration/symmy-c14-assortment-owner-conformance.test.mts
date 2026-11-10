import { randomUUID } from 'node:crypto';

import { ImportSymmyRulePayloadSchema } from '@app/assortment/actions/import-symmy-rule';
import { SYMMY_FIXTURE_ROUTES, SymmyRouteContextSchema } from '@app/shared-contracts/symmy';
import {
  decodeSymmyAssortmentRuleSource,
  mapSymmyAssortmentRule,
} from '@app/symmy-integration/symmy-internal-contracts';
import { PgClient } from '@effect/sql-pg';
import { expect, it } from 'effect-rstest';
import { Duration, Effect, FileSystem, Option, Queue, Redacted, Schema } from 'effect';

import {
  SymmyC14ProductFixtureUnavailable,
  buildProductOwner,
  buildProductWorker,
  startProductOwner,
  startProductWorker,
} from './support/symmy-c14-product-runtime.mts';
import {
  encodePolicyFixtureJson as encodeJson,
  initializePolicyFixtureScopes,
  makeSymmyC14PolicyClient,
  makeSymmyC14PolicyFixture,
  observePolicyFixtureUntil,
  policyFixtureServices,
} from './support/symmy-c14-policy-fixture.mts';

const workloadKey = 'commerce.assortment.symmy-fixture-rule-import';
const declarationKey = 'commerce.assortment.symmy-fixture-rule.import';
const routeKey = 'assortmentRulesFixtureBatch';
const mappingVersion = 'INTERNAL_C14_ASSORTMENT_RULE_V1';
const operation = {
  entrypointKey: 'commerce.assortment.import-symmy-rule',
  moduleId: 'commerce.assortment',
  schemaVersion: '1',
};
const lifecyclePolicy = { policyId: 'INTERNAL_C14_ASSORTMENT_RETENTION', revision: 'v1' };
const fixtureId = 'INTERNAL_C14_ASSORTMENT';
const acceptedIdempotencyKey = 'internal-assortment-accepted';
const symmyPath = SYMMY_FIXTURE_ROUTES[routeKey].path;
const committedLossSchema = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    type: Schema.Literal('committed-response-lost'),
  }),
);
const policyFixture = Effect.fn('SymmyC14Assortment.policyFixture')(function* policyFixture(input: {
  readonly integrationPrincipalId: string;
  readonly routeId: string;
  readonly sellerId: string;
  readonly tenantId: string;
}) {
  const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
    moduleId,
    resourceId,
    resourceType,
    tenantId: input.tenantId,
  });
  const productId = randomUUID();
  const groupId = randomUUID();
  const channelId = randomUUID();
  const marketId = randomUUID();
  const storefrontId = randomUUID();
  const source = {
    audience: {
      groupRef: ref('commerce.customer-context', 'commerce.customer-context.customer-group', groupId),
      kind: 'COMMERCE_CUSTOMER_GROUP',
    },
    commercialScope: {
      channelRef: ref('commerce.channel', 'commerce.channel.channel', channelId),
      commerceMarketRef: ref('commerce.market', 'commerce.market.market', marketId),
      sellingLegalEntityRef: ref('party.registry', 'party.registry.legal-entity', input.sellerId),
      storefrontRef: ref('commerce.storefront', 'commerce.storefront.storefront', storefrontId),
    },
    contractVersion: mappingVersion,
    effect: 'DENY',
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    purpose: 'PURCHASE',
    reason: 'Explicit purchase restriction for the C14 fixture Customer Group',
    selector: { kind: 'PRODUCT', productRef: ref('commerce.catalog', 'commerce.catalog.product', productId) },
    sourceRecordId: 'policy-fixture-1',
  };
  const issuerId = 'INTERNAL_C14_ASSORTMENT_ISSUER';
  const sourceNamespace = 'INTERNAL_C14_ASSORTMENT_POLICY';
  const routeRevision = 'INTERNAL_C14_ASSORTMENT_ROUTE_V1';
  const routeContext = yield* Schema.decodeUnknownEffect(SymmyRouteContextSchema)({
    allowedOwnerOperations: [operation],
    factFamily: 'ASSORTMENT_RULE',
    issuerId,
    mappingVersion,
    principalId: input.integrationPrincipalId,
    route: { integrationRouteId: input.routeId, tenantId: input.tenantId },
    routeRevision,
    sellingLegalEntityId: input.sellerId,
    sourceNamespace,
  });
  const { payload } = yield* mapSymmyAssortmentRule(routeContext, yield* decodeSymmyAssortmentRuleSource(source));
  return {
    command: yield* Schema.encodeEffect(ImportSymmyRulePayloadSchema)(payload),
    expectedPolicy: {
      binding_kind: source.audience.kind,
      channel_resource_id: channelId,
      customer_group_resource_id: groupId,
      effect: source.effect,
      effective_from: source.effectiveFrom,
      legal_entity_id: input.sellerId,
      market_resource_id: marketId,
      purpose: source.purpose,
      selector_kind: source.selector.kind,
      selector_target_resource_id: productId,
      stable_code: payload.rule.stableCode,
      storefront_resource_id: storefrontId,
    },
    occurrence: {
      entityKind: 'ASSORTMENT_RULE',
      issuerId,
      sourceNamespace,
      sourceRecordId: source.sourceRecordId,
    },
    routeRevision,
    source,
  };
});

const routePlan = (fixture: Effect.Success<ReturnType<typeof policyFixture>>, reason = fixture.source.reason) =>
  encodeJson({
    items: [
      {
        effects: [
          {
            effectKey: 'assortment-rule',
            intent: { _tag: 'AssortmentRuleFixture', source: { ...fixture.source, reason } },
            operation,
          },
        ],
        itemKey: 'assortment-rule',
        source: fixture.occurrence,
        sourceOccurrenceId: randomUUID(),
      },
    ],
  });

it.live(
  'applies only the enrolled Assortment fixture through actual Shell and the C14 worker, and recovers the original owner commit',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeAssortmentConformance() {
        const runtime = yield* makeSymmyC14PolicyFixture({
          declarationKey,
          initializeScopes: (scope) =>
            initializePolicyFixtureScopes(scope).pipe(Effect.provideService(PgClient.PgClient, scope.admin)),
          lifecyclePolicy,
          operation,
          owner: 'assortment',
          workloadKey,
        });
        const {
          admin,
          environment,
          integration,
          ownerContract,
          ownerPort,
          routeId,
          sellerId,
          shell,
          symmy,
          symmyPort,
          system,
          tenantId,
        } = runtime;
        const fixture = yield* policyFixture({
          integrationPrincipalId: integration.principalId,
          routeId,
          sellerId,
          tenantId,
        });
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,legal_entity_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
          values(${routeId},${tenantId},${integration.principalId},${sellerId},true,array[${fixtureId}],${yield* routePlan(fixture)}::jsonb,${mappingVersion},${routeKey},${fixture.routeRevision},${yield* encodeJson(lifecyclePolicy)}::jsonb)`;
        const fs = yield* FileSystem.FileSystem;
        const faultDirectory = yield* fs.makeTempDirectoryScoped({ prefix: 'INTERNAL_C14_ASSORTMENT_' });
        const faultMarker = `${faultDirectory}/drop-owner-response`;
        yield* fs.writeFileString(faultMarker, 'INTERNAL_C14 transport fault after native owner commit');
        const permits = yield* Schema.decodeUnknownEffect(Schema.Json)([
          { command: fixture.command, principalId: system.principalId },
        ]);
        const assortmentReceiver = yield* startProductOwner({
          artifacts: yield* buildProductOwner(ownerContract),
          contract: ownerContract,
          environment: {
            ...environment,
            ONTOS_ASSORTMENT_SYMMY_RULE_FIXTURES: yield* encodeJson(permits),
            ONTOS_C14_RESPONSE_LOSS_MARKER: faultMarker,
            ONTOS_C14_RESPONSE_LOSS_OPERATION: 'assortment-import',
          },
          port: ownerPort,
          prefix: '/assortment-api',
        });
        const symmyReceiver = yield* startProductOwner({
          artifacts: yield* buildProductOwner(symmy),
          contract: symmy,
          environment,
          port: symmyPort,
          prefix: '/symmy-integration-api',
        });

        const { poll, post, submit } = yield* makeSymmyC14PolicyClient(
          runtime,
          symmyPath,
          fixtureId,
          symmyReceiver.diagnostic,
        );
        expect((yield* post('untrusted', { fixtureId }, Redacted.make('invalid-c14-fixture-key'))).status).toBe(401);
        expect((yield* post('supplied-plan', { fixtureId, plan: {} })).status).toBe(400);
        const accepted = yield* submit(acceptedIdempotencyKey);
        expect((yield* post('unknown-fixture', { fixtureId: 'NO_SUCH_FIXTURE' })).status).toBe(403);
        expect(yield* submit(acceptedIdempotencyKey)).toEqual(accepted);

        const workerArtifact = yield* buildProductWorker(symmy);
        const firstWorker = yield* startProductWorker(workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_ASSORTMENT_FIRST_PROCESS',
        });
        const failure = (reason: string, workerDiagnostic: Effect.Effect<string>) =>
          Effect.all([
            assortmentReceiver.diagnostic,
            symmyReceiver.diagnostic,
            workerDiagnostic,
            shell.issuerDiagnostics().pipe(
              Effect.flatMap(encodeJson),
              Effect.orElseSucceed(() => 'Issuer diagnostics unavailable'),
            ),
            admin`select error_message from core.outbox_attempts where finished_at is not null order by finished_at desc limit 3`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
              Effect.flatMap(encodeJson),
              Effect.orElseSucceed(() => 'Outbox diagnostics unavailable'),
            ),
          ]).pipe(
            Effect.flatMap((diagnostics) =>
              Effect.fail(
                new SymmyC14ProductFixtureUnavailable({
                  message: `${reason}; native diagnostics: ${diagnostics.join('\n')}`,
                }),
              ),
            ),
          );
        const lostCommit = yield* Effect.gen(function* waitForLostResponse() {
          for (;;) {
            const event = Schema.decodeUnknownOption(committedLossSchema)(yield* Queue.take(assortmentReceiver.output));
            if (Option.isSome(event)) {
              return event.value;
            }
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(35),
            orElse: () =>
              failure('The real Assortment owner did not commit and lose its response', firstWorker.diagnostic),
          }),
        );
        expect(lostCommit.path).toBe('/assortment-api/assortment/actions/import-symmy-rule');

        const readPolicy = admin`select b.binding_kind,b.channel_resource_id,b.customer_group_resource_id,
          r.effect,to_char(b.effective_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as effective_from,
          b.legal_entity_id,b.market_resource_id,r.purpose,r.selector_kind,
          r.selector_target_resource_id,s.stable_code,b.storefront_resource_id
          from assortment.assortment_applicability_bindings b
          join assortment.assortment_rule_revisions r using (tenant_id,rule_revision_id)
          join assortment.assortment_stable_rules s using (tenant_id,stable_rule_id)
          where b.tenant_id=${tenantId}`;
        const [committed] = yield* admin<{
          action_invocation_id: string;
          principal_id: string;
        }>`select action_invocation_id,principal_id
          from core.action_invocations where tenant_id=${tenantId} and action_key=${operation.entrypointKey} and status='succeeded'`;
        expect(committed?.principal_id).toBe(system.principalId);
        expect(yield* readPolicy).toEqual([fixture.expectedPolicy]);
        yield* firstWorker.child.kill();
        yield* firstWorker.child.exitCode;
        yield* fs.remove(faultMarker);
        const restarted = yield* startProductWorker(workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_ASSORTMENT_RESTARTED_PROCESS',
        });
        const final = yield* observePolicyFixtureUntil(
          poll(accepted.jobId),
          ({ status }) => status === 'completed_all',
          failure('The restarted C14 worker did not settle the original Assortment effect', restarted.diagnostic),
        );
        expect(final.items).toMatchObject([{ outcome: 'accepted' }]);
        const [ledger] = yield* admin<{ owner_invocation_id: string; state: string }>`select owner_invocation_id,state
          from symmy_integration.job_effects where tenant_id=${tenantId} and job_id=${accepted.jobId}`;
        expect(ledger).toEqual({ owner_invocation_id: committed?.action_invocation_id, state: 'settled' });
        expect(yield* submit(acceptedIdempotencyKey)).toEqual(accepted);

        yield* admin`update symmy_integration.job_routes set fixture_plan=${yield* routePlan(fixture, 'Unapproved altered policy')}::jsonb,
          route_revision='INTERNAL_C14_ASSORTMENT_ROUTE_V2' where tenant_id=${tenantId} and route_id=${routeId}`;
        const altered = yield* submit('internal-assortment-altered');
        const denied = yield* observePolicyFixtureUntil(
          poll(altered.jobId),
          ({ status }) => status === 'completed_none',
          failure('The unapproved Assortment command did not settle as denied', restarted.diagnostic),
        );
        expect(denied.items).toMatchObject([{ outcome: 'not_accepted' }]);
        const [deniedEffect] = yield* admin`select outcome->>'status' as status
          from symmy_integration.job_effects where tenant_id=${tenantId} and job_id=${altered.jobId}`;
        expect(deniedEffect).toEqual({ status: 'denied' });
        expect(yield* readPolicy).toEqual([fixture.expectedPolicy]);
        const [counts] = yield* admin`select
          (select count(*)::integer from assortment.assortment_stable_rules where tenant_id=${tenantId}) as rules,
          (select count(*)::integer from assortment.assortment_rule_revisions where tenant_id=${tenantId}) as revisions,
          (select count(*)::integer from assortment.assortment_applicability_bindings where tenant_id=${tenantId}) as bindings,
          (select count(*)::integer from core.action_invocations where tenant_id=${tenantId} and action_key=${operation.entrypointKey} and status='succeeded') as succeeded`;
        expect(counts).toEqual({ bindings: 1, revisions: 1, rules: 1, succeeded: 1 });
        yield* admin`update symmy_integration.job_routes
          set fixture_plan=fixture_plan || jsonb_build_object('sourceRouteId',${randomUUID()}::text),
          route_revision='INTERNAL_C14_ASSORTMENT_ROUTE_V3' where tenant_id=${tenantId} and route_id=${routeId}`;
        expect((yield* post('aliased-fixture-source', { fixtureId })).status).toBe(403);
      }),
    ).pipe(Effect.provide(policyFixtureServices)),
  180_000,
);
