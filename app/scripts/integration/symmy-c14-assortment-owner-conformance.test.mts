import { randomUUID } from 'node:crypto';

import { ImportSymmyRulePayloadSchema } from '@app/assortment/actions/import-symmy-rule';
import { findPostgresFailure } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { SYMMY_FIXTURE_ROUTES, SymmyRouteContextSchema } from '@app/shared-contracts/symmy';
import {
  decodeSymmyAssortmentRuleSource,
  mapSymmyAssortmentRule,
} from '@app/symmy-integration/symmy-internal-contracts';
import { PgClient } from '@effect/sql-pg';
import { expect, it } from 'effect-rstest';
import { Duration, Effect, Option, Queue, Redacted, Schema } from 'effect';

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
const ownerProblemSchema = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    problem: Schema.Struct({ code: Schema.String }),
    status: Schema.Int,
    type: Schema.Literal('owner-http-problem'),
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
    databaseCommand: {
      channel: channelId,
      effect: payload.rule.effect,
      effectiveFrom: source.effectiveFrom,
      fingerprint: computeCanonicalValueHash({
        effect: payload.rule.effect,
        purpose: payload.rule.purpose,
        selector: payload.rule.selector,
      }),
      group: groupId,
      market: marketId,
      product: productId,
      purpose: payload.rule.purpose,
      reason: payload.rule.reason,
      stableCode: payload.rule.stableCode,
      storefront: storefrontId,
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

const routePlan = (fixture: Effect.Success<ReturnType<typeof policyFixture>>) =>
  encodeJson({
    items: [
      {
        effects: [
          {
            effectKey: 'assortment-rule',
            intent: { _tag: 'AssortmentRuleFixture', source: fixture.source },
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
  'refuses unproven Assortment owner facts and rejects direct fixture writes under the shared runtime role',
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
        const capability = randomUUID();
        const permits = yield* encodeJson([
          { command: fixture.command, permit: capability, principalId: system.principalId },
        ]);
        const databaseCommand = yield* encodeJson(fixture.databaseCommand);
        yield* admin`insert into assortment.c14_rule_fixture_permits
          (tenant_id,legal_entity_id,principal_id,source_principal_id,permit_digest,command_digest)
          values(${tenantId},${sellerId},${system.principalId},${integration.principalId},
            encode(sha256(convert_to(${capability}::uuid::text,'UTF8')),'hex'),
            encode(sha256(convert_to(${databaseCommand}::jsonb::text,'UTF8')),'hex'))`;
        const assortmentReceiver = yield* startProductOwner({
          artifacts: yield* buildProductOwner(ownerContract),
          contract: ownerContract,
          environment: {
            ...environment,
            ONTOS_ASSORTMENT_SYMMY_RULE_FIXTURES: permits,
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

        const { post, submit } = yield* makeSymmyC14PolicyClient(
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

        const [admission] = yield* admin<{ admission_invocation_id: string }>`select admission_invocation_id
          from symmy_integration.import_jobs where tenant_id=${tenantId} and job_id=${accepted.jobId}`;
        expect(admission).toBeDefined();
        const runtimeSql = yield* PgClient.make({ url: Redacted.make(environment.DATABASE_URL) });
        const direct = <Value, Failure>(query: Effect.Effect<Value, Failure>) =>
          runtimeSql.withTransaction(
            runtimeSql`select set_config('ontos.tenant_id',${tenantId},true),
              set_config('ontos.legal_entity_id',${sellerId},true)`.pipe(Effect.andThen(query)),
          );
        const [fence] = yield* direct(runtimeSql<{ open: boolean }>`select
          trust.lock_source_execution_fence(${tenantId}::uuid,${admission.admission_invocation_id}::uuid) as open`);
        expect(fence?.open).toBe(true);
        const expectSqlDenial = (query: Effect.Effect<unknown, unknown>) =>
          direct(query).pipe(
            Effect.flip,
            Effect.map((failure) => expect(Option.getOrUndefined(findPostgresFailure(failure))?.code).toBe('42501')),
          );
        yield* expectSqlDenial(runtimeSql`select * from assortment.write_c14_rule_fixture(
          ${tenantId}::uuid,${sellerId}::uuid,${randomUUID()}::uuid,${system.principalId}::uuid,
          ${admission.admission_invocation_id}::uuid,${integration.principalId}::uuid,${databaseCommand}::jsonb)`);
        const callFixture = (permit: string, command: string) =>
          runtimeSql`select * from assortment.import_c14_rule_fixture(
            ${tenantId}::uuid,${sellerId}::uuid,${randomUUID()}::uuid,${system.principalId}::uuid,
            ${admission.admission_invocation_id}::uuid,${integration.principalId}::uuid,${permit}::uuid,${command}::jsonb)`;
        yield* expectSqlDenial(callFixture(randomUUID(), databaseCommand));
        const tampered = yield* encodeJson({ ...fixture.databaseCommand, reason: 'Unenrolled Assortment rule' });
        yield* expectSqlDenial(callFixture(capability, tampered));

        const worker = yield* startProductWorker(yield* buildProductWorker(symmy), {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_ASSORTMENT_CURRENTNESS_PROCESS',
        });
        const refused = yield* Effect.gen(function* waitForOwnerRefusal() {
          for (;;) {
            const event = Schema.decodeUnknownOption(ownerProblemSchema)(yield* Queue.take(assortmentReceiver.output));
            if (Option.isSome(event)) {
              return event.value;
            }
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(35),
            orElse: () =>
              Effect.all([assortmentReceiver.diagnostic, symmyReceiver.diagnostic, worker.diagnostic]).pipe(
                Effect.flatMap((diagnostics) =>
                  Effect.fail(
                    new SymmyC14ProductFixtureUnavailable({
                      message: `The Assortment owner did not report unavailable currentness: ${diagnostics.join(' | ')}`,
                    }),
                  ),
                ),
              ),
          }),
        );
        expect(refused).toEqual({
          path: '/assortment-api/assortment/actions/import-symmy-rule',
          problem: { code: 'action_permission_check_failed' },
          status: 503,
          type: 'owner-http-problem',
        });
        yield* worker.child.kill();
        yield* worker.child.exitCode;
        yield* admin`update core.source_execution_fences set state='cancelled'
          where tenant_id=${tenantId} and admission_invocation_id=${admission.admission_invocation_id}`;
        yield* expectSqlDenial(callFixture(capability, databaseCommand));
        const [counts] = yield* admin`select
          (select count(*)::integer from assortment.assortment_stable_rules where tenant_id=${tenantId}) as rules,
          (select count(*)::integer from assortment.assortment_rule_revisions where tenant_id=${tenantId}) as revisions,
          (select count(*)::integer from assortment.assortment_applicability_bindings where tenant_id=${tenantId}) as bindings`;
        expect(counts).toEqual({ bindings: 0, revisions: 0, rules: 0 });
        yield* admin`update symmy_integration.job_routes
          set fixture_plan=fixture_plan || jsonb_build_object('sourceRouteId',${randomUUID()}::text),
          route_revision='INTERNAL_C14_ASSORTMENT_ROUTE_V3' where tenant_id=${tenantId} and route_id=${routeId}`;
        expect((yield* post('aliased-fixture-source', { fixtureId })).status).toBe(403);
      }),
    ).pipe(Effect.provide(policyFixtureServices)),
  180_000,
);
