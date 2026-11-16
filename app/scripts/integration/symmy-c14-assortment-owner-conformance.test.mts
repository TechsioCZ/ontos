import { randomUUID } from 'node:crypto';

import {
  ImportSymmyRulePayloadSchema,
  projectSymmyRuleFixtureDatabaseCommand,
} from '@app/assortment/actions/import-symmy-rule';
import { findPostgresFailure } from '@app/core-runtime';
import { SYMMY_FIXTURE_ROUTES, SymmyRouteContextSchema } from '@app/shared-contracts/symmy';
import {
  decodeSymmyAssortmentRuleSource,
  mapSymmyAssortmentRule,
} from '@app/symmy-integration/symmy-internal-contracts';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import { Duration, Effect, FileSystem, Option, Queue, Redacted, Schema } from 'effect';

import {
  changeAssortmentFixtureGroup,
  changeAssortmentFixtureStorefront,
  prepareAssortmentFixtureOwnerFacts,
} from './support/symmy-c14-assortment-owner-facts.mts';
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
  Schema.Struct({ path: Schema.String, type: Schema.Literal('committed-response-lost') }),
);
const staleFactSchema = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    state: Schema.Literals(['ARCHIVED', 'NOT_CURRENT']),
    type: Schema.Literal('assortment-stale-fact'),
  }),
);
const assortmentActionPath = '/assortment-api/assortment/actions/import-symmy-rule';
const catalogCurrentnessPath = '/catalog-api/reads/assortment-product-classification-v1';
const ownerProblemSchema = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.Literal('POST'),
    path: Schema.String,
    problem: Schema.Struct({ code: Schema.optionalKey(Schema.String) }),
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
  const channelId = 'B2C';
  const marketId = randomUUID();
  const storefrontId = randomUUID();
  const storefrontAppId = `c14-assortment-${storefrontId}`;
  const source = {
    audience: {
      groupRef: ref('commerce.customer-context', 'commerce.customer-context.customer-group', groupId),
      kind: 'COMMERCE_CUSTOMER_GROUP',
    },
    commercialScope: {
      channelRef: ref('commerce.channel', 'commerce.channel.channel', channelId),
      commerceMarketRef: ref('commerce.market-catalog', 'commerce.market-catalog.market', marketId),
      sellingLegalEntityRef: ref('core.identity', 'core.identity.legal-entity', input.sellerId),
      storefrontRef: ref(
        'commerce.storefront-registry',
        'commerce.storefront-registry.storefront-application',
        storefrontId,
      ),
    },
    contractVersion: mappingVersion,
    effect: 'DENY',
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    purpose: 'PURCHASE',
    reason: 'Explicit purchase restriction for the C14 fixture Customer Group',
    selector: { kind: 'PRODUCT', productRef: ref('commerce.catalog', 'commerce.catalog.product', productId) },
    sourceRecordId: 'policy-fixture-1',
    storefrontAppId,
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
  const databaseCommand = projectSymmyRuleFixtureDatabaseCommand(payload);
  assert.isOk(databaseCommand);
  return {
    command: yield* Schema.encodeEffect(ImportSymmyRulePayloadSchema)(payload),
    databaseCommand,
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
  'requires Current owner facts and exact SQL enrollment before an internal Assortment import can persist',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeAssortmentConformance() {
        const runtime = yield* makeSymmyC14PolicyFixture({
          initializeScopes: (scope) =>
            initializePolicyFixtureScopes(scope).pipe(Effect.provideService(PgClient.PgClient, scope.runtime)),
          lifecyclePolicy,
          owner: 'assortment',
          workloadKey,
        });
        const {
          admin,
          currentnessReceivers,
          environment,
          integration,
          ownerContract,
          ownerModuleKey,
          ownerPort,
          routeId,
          sellerId,
          symmy,
          symmyModuleKey,
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
        const fs = yield* FileSystem.FileSystem;
        const faultDirectory = yield* fs.makeTempDirectoryScoped({ prefix: 'c14-assortment-native-' });
        const faultMarker = `${faultDirectory}/drop-owner-response`;
        const assortmentReceiver = yield* startProductOwner({
          artifacts: yield* buildProductOwner(ownerContract),
          contract: ownerContract,
          environment: {
            ...environment,
            ONTOS_ASSORTMENT_SYMMY_RULE_FIXTURES: permits,
            ONTOS_C14_RESPONSE_LOSS_MARKER: faultMarker,
            ONTOS_C14_RESPONSE_LOSS_OPERATION: 'assortment-import',
          },
          moduleKey: ownerModuleKey,
          port: ownerPort,
          prefix: '/assortment-api',
        });
        const symmyReceiver = yield* startProductOwner({
          artifacts: yield* buildProductOwner(symmy),
          contract: symmy,
          environment,
          moduleKey: symmyModuleKey,
          port: symmyPort,
          prefix: '/symmy-integration-api',
        });

        expect(currentnessReceivers).toHaveLength(4);
        const ownerReaders = yield* Effect.forEach(
          currentnessReceivers,
          Effect.fn('SymmyC14Assortment.startCurrentnessReceiver')(function* start(receiver) {
            const native = yield* startProductOwner({
              artifacts: yield* buildProductOwner(receiver.contract),
              contract: receiver.contract,
              environment: { ...environment, ONTOS_C14_TRACE_ASSORTMENT_FACTS: 'true' },
              moduleKey: receiver.moduleKey,
              port: receiver.port,
              prefix: `/${receiver.audience}-api`,
            });
            return { audience: receiver.audience, ...native };
          }),
          { concurrency: 2 },
        );
        const { poll, post, submit } = yield* makeSymmyC14PolicyClient(
          runtime,
          symmyPath,
          fixtureId,
          symmyReceiver.diagnostic,
        );
        expect((yield* post('untrusted', { fixtureId }, Redacted.make('invalid-c14-fixture-key'))).status).toBe(401);
        expect((yield* post('supplied-plan', { fixtureId, plan: {} })).status).toBe(400);
        const ownerFactScope = { admin, principalId: system.principalId, sellerId, tenantId };
        yield* prepareAssortmentFixtureOwnerFacts(ownerFactScope, fixture.databaseCommand);
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

        // Admission and the owner permit remain pinned to the formerly Current Product.
        yield* admin`update catalog.products
          set lifecycle_state='RETIRED',retired_effective_at=clock_timestamp(),retired_reason='C14 native stale Product proof'
          where tenant_id=${tenantId} and product_id=${fixture.databaseCommand.product}`;
        const workerArtifact = yield* buildProductWorker(symmy);
        const worker = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_ASSORTMENT_CURRENTNESS_PROCESS',
          },
          symmyModuleKey,
        );
        const waitForOwnerRefusal = Effect.gen(function* waitForOwnerRefusal() {
          for (;;) {
            const event = Schema.decodeUnknownOption(ownerProblemSchema)(yield* Queue.take(assortmentReceiver.output));
            if (
              Option.isSome(event) &&
              event.value.path === assortmentActionPath &&
              event.value.status === 503 &&
              event.value.problem.code === 'action_permission_check_failed'
            ) {
              return event.value;
            }
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(35),
            orElse: () =>
              Effect.all(
                [
                  assortmentReceiver.diagnostic,
                  symmyReceiver.diagnostic,
                  worker.diagnostic,
                  ...ownerReaders.map(({ diagnostic }) => diagnostic),
                ],
                { concurrency: 1 },
              ).pipe(
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
        expect(yield* waitForOwnerRefusal).toEqual({
          method: 'POST',
          path: assortmentActionPath,
          problem: { code: 'action_permission_check_failed' },
          status: 503,
          type: 'owner-http-problem',
        });
        const catalogReader = ownerReaders.find(({ audience }) => audience === 'catalog');
        assert.isOk(catalogReader);
        const productRefusal = yield* Effect.gen(function* waitForProductRefusal() {
          for (;;) {
            const event = Schema.decodeUnknownOption(ownerProblemSchema)(yield* Queue.take(catalogReader.output));
            if (Option.isSome(event) && event.value.path === catalogCurrentnessPath && event.value.status === 503) {
              return event.value;
            }
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(10),
            orElse: () =>
              Effect.all(
                [
                  assortmentReceiver.diagnostic,
                  catalogReader.diagnostic,
                  runtime.shell.issuerDiagnostics().pipe(Effect.flatMap(encodeJson)),
                ],
                { concurrency: 1 },
              ).pipe(
                Effect.flatMap(
                  (diagnostics) =>
                    new SymmyC14ProductFixtureUnavailable({
                      message: `The retired Product was not checked by its Catalog owner: ${diagnostics.join(' | ')}`,
                    }),
                ),
              ),
          }),
        );
        expect(productRefusal).toMatchObject({
          method: 'POST',
          path: catalogCurrentnessPath,
          status: 503,
        });
        yield* worker.child.kill();
        yield* worker.child.exitCode;
        yield* admin`update core.source_execution_fences set state='cancelled'
          where tenant_id=${tenantId} and admission_invocation_id=${admission.admission_invocation_id}`;
        yield* expectSqlDenial(callFixture(capability, databaseCommand));
        const readCounts = admin`select
          (select count(*)::integer from assortment.assortment_stable_rules where tenant_id=${tenantId}) as rules,
          (select count(*)::integer from assortment.assortment_rule_revisions where tenant_id=${tenantId}) as revisions,
          (select count(*)::integer from assortment.assortment_applicability_bindings where tenant_id=${tenantId}) as bindings`;
        expect(yield* readCounts).toEqual([{ bindings: 0, revisions: 0, rules: 0 }]);
        yield* admin`update catalog.products
          set lifecycle_state='ACTIVE',retired_effective_at=null,retired_reason=null
          where tenant_id=${tenantId} and product_id=${fixture.databaseCommand.product}`;
        const rotateEnrollment = (stage: string) => {
          const routeRevision = `${fixture.routeRevision}:${stage}`;
          return admin`update symmy_integration.job_routes set route_revision=${routeRevision}
            where tenant_id=${tenantId} and route_id=${routeId}`;
        };
        const ownerScenarios = [
          {
            audience: 'commerce-customer-context',
            invalidate: changeAssortmentFixtureGroup(ownerFactScope, fixture.databaseCommand.group, 'archive', 1),
            invalidation: 'ARCHIVED',
            restoration: 'REACTIVATED',
            restore: changeAssortmentFixtureGroup(ownerFactScope, fixture.databaseCommand.group, 'reactivate', 2),
            route: '/commerce-customer-context-api/reads/customer-group-detail',
            state: 'ARCHIVED',
          },
          {
            audience: 'storefront-registry',
            invalidate: changeAssortmentFixtureStorefront(
              ownerFactScope,
              fixture.databaseCommand.storefront,
              'SUSPENDED',
              1,
            ),
            invalidation: 'revised',
            restoration: 'revised',
            restore: changeAssortmentFixtureStorefront(ownerFactScope, fixture.databaseCommand.storefront, 'ACTIVE', 2),
            route: '/storefront-registry-api/reads/current-storefront-application',
            state: 'NOT_CURRENT',
          },
        ] as const;
        for (const scenario of ownerScenarios) {
          yield* rotateEnrollment(scenario.audience);
          yield* submit(`internal-assortment-stale-${scenario.audience}`);
          expect((yield* scenario.invalidate)?.outcome).toBe(scenario.invalidation);
          const staleWorker = yield* startProductWorker(
            workerArtifact,
            {
              ...environment,
              ONTOS_C14_WORKER_CLAIM_OWNER: `INTERNAL_C14_STALE_${scenario.audience}`,
            },
            symmyModuleKey,
          );
          const ownerReader = ownerReaders.find(({ audience }) => audience === scenario.audience);
          assert.isOk(ownerReader);
          const staleFact = yield* Effect.gen(function* waitForStaleOwnerFact() {
            for (;;) {
              const event = Schema.decodeUnknownOption(staleFactSchema)(yield* Queue.take(ownerReader.output));
              if (Option.isSome(event)) {
                return event.value;
              }
            }
          }).pipe(Effect.timeout(Duration.seconds(30)));
          expect(staleFact).toMatchObject({ path: scenario.route, state: scenario.state });
          expect((yield* waitForOwnerRefusal).status).toBe(503);
          yield* staleWorker.child.kill();
          yield* staleWorker.child.exitCode;
          expect(yield* readCounts).toEqual([{ bindings: 0, revisions: 0, rules: 0 }]);
          expect((yield* scenario.restore)?.outcome).toBe(scenario.restoration);
        }

        yield* rotateEnrollment('seller');
        const sellerJob = yield* submit('internal-assortment-stale-seller');
        const sellerBefore = yield* runtime.shell.issuerDiagnostics();
        yield* admin`update core.legal_entities set status='suspended' where tenant_id=${tenantId} and legal_entity_id=${sellerId}`;
        const sellerWorker = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_STALE_SELLER',
          },
          symmyModuleKey,
        );
        const sellerOutcome = yield* observePolicyFixtureUntil(
          admin<{ owner_request_hash: string | null; state: string }>`select owner_request_hash,state
            from symmy_integration.job_effects where tenant_id=${tenantId} and job_id=${sellerJob.jobId}`,
          ([effect]) => effect?.state === 'blocked' || effect?.state === 'indeterminate' || effect?.state === 'settled',
          Effect.fail(
            new SymmyC14ProductFixtureUnavailable({
              message: 'The inactive seller was not refused before an owner attempt',
            }),
          ),
        );
        expect(sellerOutcome[0]?.owner_request_hash).toBeNull();
        yield* sellerWorker.child.kill();
        yield* sellerWorker.child.exitCode;
        const successfulAssortmentIssues = (issued: typeof sellerBefore) =>
          issued.filter(({ audience, outcome }) => audience === 'assortment' && outcome === 'success');
        expect(successfulAssortmentIssues(yield* runtime.shell.issuerDiagnostics())).toEqual(
          successfulAssortmentIssues(sellerBefore),
        );
        expect(yield* readCounts).toEqual([{ bindings: 0, revisions: 0, rules: 0 }]);
        yield* admin`update core.legal_entities set status='active' where tenant_id=${tenantId} and legal_entity_id=${sellerId}`;
        yield* rotateEnrollment('current');
        yield* fs.writeFileString(faultMarker, 'INTERNAL_C14 transport fault after native owner commit');
        const current = yield* submit('internal-assortment-current');
        const currentWorker = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_ASSORTMENT_POSITIVE_PROCESS',
          },
          symmyModuleKey,
        );
        const failure = (reason: string, workerDiagnostic: Effect.Effect<string>) =>
          Effect.all([
            assortmentReceiver.diagnostic,
            symmyReceiver.diagnostic,
            workerDiagnostic,
            ...ownerReaders.map(({ diagnostic }) => diagnostic),
            runtime.shell.issuerDiagnostics().pipe(
              Effect.flatMap(encodeJson),
              Effect.orElseSucceed(() => 'Issuer diagnostics unavailable'),
            ),
          ]).pipe(
            Effect.flatMap(
              (diagnostics) =>
                new SymmyC14ProductFixtureUnavailable({
                  message: `${reason}; native diagnostics: ${diagnostics.join(' | ')}`,
                }),
            ),
          );
        const lost = yield* Effect.gen(function* waitForCommittedLoss() {
          for (;;) {
            const event = Schema.decodeUnknownOption(committedLossSchema)(yield* Queue.take(assortmentReceiver.output));
            if (Option.isSome(event)) {
              return event.value;
            }
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(40),
            orElse: () =>
              failure('The Assortment owner did not commit and lose its response', currentWorker.diagnostic),
          }),
        );
        expect(lost.path).toBe(assortmentActionPath);
        const readFixture = admin<{
          action_invocation_id: string;
          binding_id: string;
          fixture_scope_version: string;
          revision_id: string;
          rule_id: string;
        }>`select
          rules.action_invocation_id, rules.stable_rule_id as rule_id,
          revisions.rule_revision_id as revision_id, bindings.applicability_binding_id as binding_id, bindings.fixture_scope_version
          from assortment.assortment_stable_rules rules
          join assortment.assortment_rule_revisions revisions
            on revisions.tenant_id=rules.tenant_id and revisions.stable_rule_id=rules.stable_rule_id
          join assortment.assortment_applicability_bindings bindings
            on bindings.tenant_id=revisions.tenant_id and bindings.rule_revision_id=revisions.rule_revision_id
          where rules.tenant_id=${tenantId} and bindings.legal_entity_id=${sellerId}
            and rules.action_invocation_id=revisions.action_invocation_id and rules.action_invocation_id=bindings.action_invocation_id`;
        const original = yield* readFixture;
        expect(original).toHaveLength(1);
        expect(original[0]?.fixture_scope_version).toBe('C14_CANONICAL_V1');
        const [unacknowledged] = yield* admin<{
          owner_request_hash: string | null;
          state: string;
        }>`select owner_request_hash,state
          from symmy_integration.job_effects where tenant_id=${tenantId} and job_id=${current.jobId}`;
        expect(unacknowledged?.owner_request_hash).toMatch(/^[0-9a-f]{64}$/u);
        expect(unacknowledged?.state).not.toBe('settled');
        yield* currentWorker.child.kill();
        yield* currentWorker.child.exitCode;
        yield* admin`update core.access_workload_bindings set status='revoked',revoked_at=clock_timestamp()
          where tenant_id=${tenantId} and principal_id=${integration.principalId}
            and workload_key in ('integration.symmy-admit','commerce.assortment.symmy-fixture-currentness')`;
        yield* fs.remove(faultMarker);
        const restarted = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_ASSORTMENT_RESTARTED_PROCESS',
          },
          symmyModuleKey,
        );
        const completed = yield* observePolicyFixtureUntil(
          poll(current.jobId),
          (job) => job.status === 'completed_all',
          failure('The original Assortment commit could not be recovered after revocation', restarted.diagnostic),
        );
        expect(completed.items).toMatchObject([{ outcome: 'accepted' }]);
        const [ledger] = yield* admin`select owner_invocation_id,state from symmy_integration.job_effects
          where tenant_id=${tenantId} and job_id=${current.jobId}`;
        expect(ledger).toEqual({ owner_invocation_id: original[0]?.action_invocation_id, state: 'settled' });
        expect(yield* readFixture).toEqual(original);
        yield* admin`update core.access_workload_bindings set status='active',revoked_at=null
          where tenant_id=${tenantId} and principal_id=${integration.principalId} and workload_key='integration.symmy-admit'`;
        yield* admin`update symmy_integration.job_routes
          set fixture_plan=fixture_plan || jsonb_build_object('sourceRouteId',${randomUUID()}::text),
          route_revision='INTERNAL_C14_ASSORTMENT_ROUTE_V3' where tenant_id=${tenantId} and route_id=${routeId}`;
        expect((yield* post('aliased-fixture-source', { fixtureId })).status).toBe(403);
      }),
    ).pipe(Effect.provide(policyFixtureServices)),
  300_000,
);
