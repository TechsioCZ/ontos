import { randomUUID } from 'node:crypto';

import { executeCreateProductUnitWithAuthorization } from '@app/catalog/api/client';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { CustomerGroupRefSchema } from '@app/commerce-customer-context/resources/customer-group';
import {
  CustomerGroupSourceAuthorityFixtureUnavailable,
  seedCustomerGroupSourceAuthority,
} from '@app/commerce-customer-context/testing/customer-group-source-authority';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { cancelOwnedSyncAdmissionFenceNative } from '@app/core-runtime/testing/source-execution-fence-native';
import { makeOwnedSystemWriterWorkloadControlNative } from '@app/core-runtime/testing/workload-binding-native';
import { ImportSourceAssertionPayloadSchema } from '@app/inventory/source-import';
import {
  C14InventorySourceImportSetupUnavailable,
  prepareC14InventorySourceImportNative,
} from '@app/inventory/testing/c14-source-import-native';
import { SymmyItemOutcomeSchema } from '@app/shared-contracts/symmy';
import { GatewayUnavailableProblemSchema } from '@app/shared-contracts';
import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { assert, expect, it } from 'effect-rstest';
import { Config, DateTime, Duration, Effect, FileSystem, Layer, Option, Queue, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { prepareInternalSyncAuthority } from './support/symmy-c14-sync-authority.mts';
import {
  internalSyncSource,
  makeInternalGroupCreatePlan,
  makeInternalGroupUpdatePlan,
  makeInternalStockPlan,
} from './support/symmy-c14-sync-plans.mts';
import { internalStockBackendId, makeInternalStockSetup } from './support/symmy-c14-sync-stock-facts.mts';
import { startInternalSyncRetryTransport } from './support/symmy-c14-sync-retry-transport.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  buildProductOwner,
  nativePort,
  productComposition,
  startProductOwner,
} from './support/symmy-c14-product-runtime.mts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const responseSchema = Schema.Struct({
  items: Schema.NonEmptyArray(
    Schema.Struct({
      ...SymmyItemOutcomeSchema.fields,
      outcome: Schema.Literals(['accepted', 'partial', 'not_accepted']),
    }),
  ),
});
const groupAppId = 'commerce-customer-context';
const groupPath = 'customer-groups/batch';
const stockPath = 'inventory/stock/batch';
const groupCreateKey = 'INTERNAL_C14_GROUP_CREATE';
const stockRevision2Key = 'INTERNAL_C14_STOCK_REVISION_2';
const stockRecordId = 'INTERNAL_C14_STOCK_RECORD';
const fixturePurpose = 'implementation-1096-registered-workload-gateway';
const countSchema = Schema.Struct({ count: Schema.Int });
const admissionRowSchema = Schema.Struct({ admission_id: Schema.String.check(Schema.isUUID()) });
const invocationRowSchema = Schema.Struct({ action_invocation_id: Schema.String.check(Schema.isUUID()) });
const syncUnavailableProblemSchema = Schema.Union([
  GatewayUnavailableProblemSchema,
  makeRetryableProblemDetailsSchema('SymmyUnavailableProblem', 503),
]);
const nativeGroupSchema = Schema.Struct({
  customer_group_id: Schema.String.check(Schema.isUUID()),
  revision: Schema.Int,
});
const stockLedgerSchema = Schema.Struct({
  accepted_amount: Schema.OptionFromNullOr(Schema.String),
  assertion_id: Schema.String,
  current_assertion_id: Schema.OptionFromNullOr(Schema.String),
  ordering_evidence_value: Schema.String,
  persisted_amount: Schema.OptionFromNullOr(Schema.String),
  persisted_assertion_id: Schema.OptionFromNullOr(Schema.String),
  proposed_amount: Schema.String,
  status: Schema.String,
});
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const lostAckWitnessSchema = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal(200),
  type: Schema.Literal('committed-response-lost'),
});
const readGroupLostAckWitness = (output: Queue.Queue<string>) =>
  Effect.gen(function* readNativeLostAckWitness() {
    for (;;) {
      const witness = Schema.decodeUnknownOption(Schema.fromJsonString(lostAckWitnessSchema))(
        yield* Queue.take(output),
      );
      if (Option.isSome(witness)) {
        return witness.value;
      }
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () =>
        new SymmyC14ProductFixtureUnavailable({
          message: 'The actual Group receiver emitted no committed ACK-loss witness',
        }),
    }),
  );

it.live(
  'INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs',
  () =>
    Effect.scoped(
      Effect.gen(function* actualSyncConformance() {
        const ports = new Set<number>();
        while (ports.size < 5) {
          ports.add(yield* nativePort);
        }
        const [catalogPort, commercePort, inventoryPort, symmyPort, retryPort] = [...ports];
        assert.isDefined(catalogPort);
        assert.isDefined(commercePort);
        assert.isDefined(inventoryPort);
        assert.isDefined(symmyPort);
        assert.isDefined(retryPort);
        const backends = {
          catalog: `http://127.0.0.1:${catalogPort}/`,
          [groupAppId]: `http://127.0.0.1:${commercePort}/`,
          inventory: `http://127.0.0.1:${inventoryPort}/`,
          'symmy-integration': `http://127.0.0.1:${retryPort}/`,
        };
        const { contracts, snapshot } = yield* productComposition(backends);
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: fixturePurpose,
        });
        const authority = yield* prepareInternalSyncAuthority(isolated, snapshot);
        const { admin, environment, ingressKey, integration, legalEntityId, shell, systemPrincipalId, tenantId } =
          authority;
        const spiceEnvironment = yield* Config.all({
          SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
          SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
          SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
        });
        yield* grantTestTenantRoleAccess({
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          holders: [
            { capabilityKeys: ['commerce.catalog.product-unit.create'], principalId: integration.issuerPrincipalId },
          ],
          legalEntityIds: [legalEntityId],
          spiceDb: yield* liveFixtureSpiceDb(spiceEnvironment),
          tenantId,
        });
        const writerControlInput = {
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          ownedDatabase: isolated,
          purpose: fixturePurpose,
          systemPrincipalId,
          tenantId,
        } as const;
        const groupWriter = yield* makeOwnedSystemWriterWorkloadControlNative({
          ...writerControlInput,
          workloadKey: 'commerce.customer-context.source-write',
        });
        const stockWriter = yield* makeOwnedSystemWriterWorkloadControlNative({
          ...writerControlInput,
          workloadKey: 'commerce.inventory.source-write',
        });
        const groupRouteId = randomUUID();
        const stockRouteId = randomUUID();
        const groupLogicalRouteId = randomUUID();
        const stockLogicalRouteId = randomUUID();
        const groupRecordId = 'INTERNAL_C14_SYNC_GROUP';
        const groupSource = {
          definitionEvidence: {
            kind: 'SOURCE_RECORD' as const,
            reference: groupRecordId,
            revision: '1',
          },
          effectId: randomUUID(),
          issuer: internalSyncSource.issuerId,
          mappingRevision: internalSyncSource.mappingVersion,
          namespace: internalSyncSource.namespace,
          order: 1,
          recordId: groupRecordId,
          revision: '1',
          route: { id: groupLogicalRouteId, revision: internalSyncSource.routeRevision },
          sourceCode: groupRecordId,
        };
        const groupPayload = {
          businessCode: 'INTERNAL_C14_SYNC_GROUP',
          description: 'Explicit internal fixture Group definition',
          initialState: 'ACTIVE' as const,
          meaningKey: 'internal-c14.explicit-group-meaning',
          membershipCriteria: 'Only the explicitly named internal fixture customers',
          name: 'Internal synchronous Group',
          purpose: 'Internal source-owned customer classification',
          reason: 'INTERNAL_C14 explicit governed Group definition',
          source: groupSource,
        };
        const groupPlan = yield* makeInternalGroupCreatePlan(
          { occurrenceId: randomUUID(), recordId: groupRecordId },
          groupPayload,
        );
        const groupSetupRequest = {
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          fixture: isolated,
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          route: {
            active: true,
            issuer: internalSyncSource.issuerId,
            legalEntityId,
            mappingRevision: internalSyncSource.mappingVersion,
            namespace: internalSyncSource.namespace,
            principalId: systemPrincipalId,
            routeId: groupLogicalRouteId,
            routeRevision: internalSyncSource.routeRevision,
            tenantId,
          },
        };
        for (const refusedSetup of [
          { ...groupSetupRequest, fixture: { ...isolated } },
          {
            ...groupSetupRequest,
            adminConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
          },
          { ...groupSetupRequest, operatorPrincipalId: systemPrincipalId },
          { ...groupSetupRequest, route: { ...groupSetupRequest.route, principalId: randomUUID() } },
        ]) {
          const refused = yield* seedCustomerGroupSourceAuthority(refusedSetup).pipe(Effect.flip);
          expect(Schema.is(CustomerGroupSourceAuthorityFixtureUnavailable)(refused)).toBe(true);
        }
        yield* seedCustomerGroupSourceAuthority(groupSetupRequest);
        const groupPolicy = { policyId: 'INTERNAL_C14_GROUP_SYNC_RETENTION', revision: '1' };
        const stockPolicy = { policyId: 'INTERNAL_C14_STOCK_SYNC_RETENTION', revision: '1' };
        const encodedGroup = Schema.encodeSync(SymmyInternalExecutionPlanSchema)(groupPlan);
        const groupConfiguration = {
          ...encodedGroup,
          items: encodedGroup.items.map((item) => ({
            ...item,
            effects: [
              ...item.effects,
              {
                effectKey: 'customer-group-update',
                operation: {
                  entrypointKey: 'commerce.customer-context.update-customer-group',
                  moduleId: 'commerce.customer-context',
                  schemaVersion: '1',
                },
              },
            ],
          })),
          sourceRouteId: groupLogicalRouteId,
        };
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,legal_entity_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
          values(${groupRouteId},${tenantId},${integration.principalId},${legalEntityId},true,array['INTERNAL_C14'],${yield* json(yield* Schema.decodeUnknownEffect(Schema.Json)(groupConfiguration))}::jsonb,${internalSyncSource.mappingVersion},'customerGroupsBatch',${internalSyncSource.routeRevision},${yield* json(groupPolicy)}::jsonb)`;
        const lifecycle = yield* json([
          {
            ...groupPolicy,
            governanceLegalEntityId: legalEntityId,
            retentionMs: 60_000,
            routeId: groupRouteId,
            targetLegalEntityId: legalEntityId,
            tenantId,
          },
          {
            ...stockPolicy,
            governanceLegalEntityId: legalEntityId,
            retentionMs: 60_000,
            routeId: stockRouteId,
            targetLegalEntityId: null,
            tenantId,
          },
        ]);
        const ownerEnvironment = { ...environment, ONTOS_SYMMY_JOB_RETENTION_POLICIES: lifecycle };
        const fs = yield* FileSystem.FileSystem;
        const faultDirectory = yield* fs.makeTempDirectoryScoped({ prefix: 'INTERNAL_C14_SYNC_ACK_' });
        const groupFaultMarker = `${faultDirectory}/group-committed-response-loss`;
        yield* fs.writeFileString(groupFaultMarker, 'INTERNAL_C14 transport outage after native Group commit');
        const ownerDiagnostics: Effect.Effect<string>[] = [];
        let groupOutput: Queue.Queue<string> | undefined;
        for (const [appId, port, prefix] of [
          ['catalog', catalogPort, '/catalog-api'],
          [groupAppId, commercePort, '/commerce-customer-context-api'],
          ['inventory', inventoryPort, '/inventory-api'],
          ['symmy-integration', symmyPort, '/symmy-integration-api'],
        ] as const) {
          const contract = contracts.find(({ deployment }) => deployment.appId === appId);
          assert.isOk(contract);
          const running = yield* startProductOwner({
            artifacts: yield* buildProductOwner(contract),
            contract,
            environment:
              appId === groupAppId
                ? {
                    ...ownerEnvironment,
                    ONTOS_C14_RESPONSE_LOSS_MARKER: groupFaultMarker,
                    ONTOS_C14_RESPONSE_LOSS_OPERATION: 'customer-group-create',
                  }
                : ownerEnvironment,
            port,
            prefix,
          });
          ownerDiagnostics.push(running.diagnostic);
          if (appId === groupAppId) {
            groupOutput = running.output;
          }
        }
        const retryTransport = yield* startInternalSyncRetryTransport({
          ownerOrigin: `http://127.0.0.1:${symmyPort}`,
          port: retryPort,
        });
        const client = yield* HttpClient.HttpClient;
        const headers = { 'x-api-key': Redacted.value(ingressKey.secret) };
        const submit = (
          path: 'customer-groups/batch' | 'inventory/stock/batch',
          idempotencyKey: string,
          plan: typeof SymmyInternalExecutionPlanSchema.Type,
        ) =>
          Effect.gen(function* submitSynchronousRoute() {
            const response = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${path}`, {
              body: yield* HttpBody.json({
                contractVersion: 'INTERNAL_C14',
                plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(plan),
              }),
              headers: { ...headers, 'idempotency-key': idempotencyKey },
            });
            if (response.status !== 200) {
              const gatewayProblems = yield* shell.gatewayDiagnostics();
              const issuerProblems = yield* shell.issuerDiagnostics();
              const requestProblems = yield* shell.requestDiagnostics();
              const diagnostics = yield* Effect.all(ownerDiagnostics);
              return yield* new SymmyC14ProductFixtureUnavailable({
                message: `Synchronous ${path} returned ${response.status}; transport ${JSON.stringify(yield* retryTransport.diagnostics)}; gateway ${JSON.stringify(gatewayProblems)}; issuer ${JSON.stringify(issuerProblems)}; requests ${JSON.stringify(requestProblems)}; owners ${diagnostics.join('\n')}`,
              });
            }
            return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(responseSchema)));
          });
        const lostGroupResponse = yield* submit(groupPath, groupCreateKey, groupPlan);
        expect(lostGroupResponse.items[0].outcome).toBe('not_accepted');
        expect(lostGroupResponse.items[0].effects[0].status).toBe('indeterminate');
        assert.isDefined(groupOutput);
        const lostAckWitness = yield* readGroupLostAckWitness(groupOutput);
        expect(lostAckWitness.path.endsWith('/actions/create-customer-group')).toBe(true);
        const [committedBeforeRecovery] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key='commerce.customer-context.create-customer-group' and status='succeeded'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(committedBeforeRecovery?.count).toBe(1);
        // Exercise the live composition source cache's 30-second refresh before current recovery authority is checked.
        yield* Effect.sleep(Duration.seconds(31));
        yield* groupWriter.revoke();
        yield* fs.remove(groupFaultMarker);
        const groupResult = yield* submit(groupPath, groupCreateKey, groupPlan);
        if (groupResult.items[0].outcome !== 'accepted') {
          const diagnostics = yield* Effect.all(ownerDiagnostics);
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: `The committed Group receipt did not recover: ${JSON.stringify(groupResult)}; gateway ${JSON.stringify(yield* shell.gatewayDiagnostics())}; owners ${diagnostics.join('\n')}`,
          });
        }
        expect(groupResult.items[0].outcome).toBe('accepted');
        expect(groupResult.items[0].effects[0].status).toBe('accepted_change');
        const groupReplay = yield* submit(groupPath, groupCreateKey, groupPlan);
        expect(groupReplay).toEqual(groupResult);
        const deniedGroupPlan = yield* makeInternalGroupCreatePlan(
          { occurrenceId: randomUUID(), recordId: groupRecordId },
          groupPayload,
        );
        const deniedGroupWrite = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${groupPath}`, {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(deniedGroupPlan),
          }),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_GROUP_REVOKED_WRITER' },
        });
        expect(deniedGroupWrite.status).toBe(503);
        yield* deniedGroupWrite.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(syncUnavailableProblemSchema, { onExcessProperty: 'error' })),
        );
        const reboundGroupWriter = yield* groupWriter.rebind();
        expect(reboundGroupWriter.bindingId).not.toBe(groupWriter.originalBinding.bindingId);
        expect(reboundGroupWriter.incarnation).not.toBe(groupWriter.originalBinding.incarnation);
        const groups =
          yield* admin`select customer_group_id,current_revision as revision from commerce_customer_context.customer_groups where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(nativeGroupSchema))),
          );
        expect(groups).toHaveLength(1);
        const [group] = groups;
        assert.isDefined(group);
        expect(group.revision).toBe(1);
        const groupRef = yield* Schema.decodeUnknownEffect(CustomerGroupRefSchema)({
          moduleId: 'commerce.customer-context',
          resourceId: group.customer_group_id,
          resourceType: 'commerce.customer-context.customer-group',
          tenantId,
        });
        const renamePlan = yield* makeInternalGroupUpdatePlan(
          { occurrenceId: randomUUID(), recordId: groupRecordId },
          {
            description: groupPayload.description,
            expectedRevision: 1,
            groupRef,
            membershipCriteria: groupPayload.membershipCriteria,
            name: 'Internal synchronous Group renamed',
            purpose: groupPayload.purpose,
            reason: 'INTERNAL_C14 cosmetic rename preserves Group meaning',
            source: { ...groupSource, order: 2, revision: '2' },
          },
        );
        const rename = yield* submit(groupPath, 'INTERNAL_C14_GROUP_RENAME', renamePlan);
        if (rename.items[0].outcome !== 'accepted') {
          const diagnostics = yield* Effect.all(ownerDiagnostics);
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: `The cosmetic Group rename did not commit: ${JSON.stringify(rename)}; gateway ${JSON.stringify(yield* shell.gatewayDiagnostics())}; owners ${diagnostics.join('\n')}`,
          });
        }
        expect(rename.items[0].outcome).toBe('accepted');
        expect(rename.items[0].effects[0].status).toBe('accepted_change');
        const unitContext = yield* shell.issueFixtureSetupGateway({ audience: 'catalog' });
        const unitPayload = {
          code: 'INTERNAL_C14_SYNC_UNIT',
          evidenceRefs: ['INTERNAL_C14_EXPLICIT_NATIVE_STOCK_UNIT'],
          label: 'Internal Stock whole unit',
          reason: 'INTERNAL_C14 explicitly declared native Stock Unit',
          rule: { rounding: 'HALF_UP' as const, step: '1' },
          unitRef: yield* Schema.decodeUnknownEffect(ProductUnitRefSchema)({
            moduleId: 'commerce.catalog',
            resourceId: randomUUID(),
            resourceType: 'commerce.catalog.product-unit',
            tenantId,
          }),
        };
        const unitResult = yield* executeCreateProductUnitWithAuthorization(
          unitPayload,
          `Bearer ${unitContext.token}`,
          randomUUID(),
          {
            baseUrl: `${backends.catalog}catalog-api`,
            compositionRevision: snapshot.composition.revision,
            idempotencyKey: 'INTERNAL_C14_SYNC_UNIT_CREATE',
          },
        );
        if (!('unit' in unitResult)) {
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: 'The native Unit setup returned a proposal instead of a committed Unit',
          });
        }
        const observedAt = yield* DateTime.now;
        const selectedAt = DateTime.formatIso(DateTime.subtract(observedAt, { seconds: 5 }));
        const setup = yield* makeInternalStockSetup({ selectedAt, tenantId, unitRef: unitResult.unit });
        const stockSetupRequest = {
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          ownedDatabase: isolated,
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
          setup,
          tenantId,
        };
        const wrongOperator = yield* prepareC14InventorySourceImportNative({
          ...stockSetupRequest,
          operatorProviderUserId: randomUUID(),
        }).pipe(Effect.flip);
        expect(Schema.is(C14InventorySourceImportSetupUnavailable)(wrongOperator)).toBe(true);
        const wrongRuntime = yield* prepareC14InventorySourceImportNative({
          ...stockSetupRequest,
          runtimeConnectionString: Redacted.make(isolated.connections.admin.connectionString),
        }).pipe(Effect.flip);
        expect(Schema.is(C14InventorySourceImportSetupUnavailable)(wrongRuntime)).toBe(true);
        yield* prepareC14InventorySourceImportNative(stockSetupRequest);
        const stockProposal = {
          assertionId: randomUUID(),
          businessObservedAt: DateTime.formatIso(observedAt),
          coverage: [],
          customerConfigurationId: setup.configuration.customerConfigurationId,
          factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND' as const,
          issuer: setup.itemCorrelation.externalKey.issuer,
          itemExternalKey: setup.itemCorrelation.externalKey,
          locationExternalKey: setup.locationCorrelation.externalKey,
          orderingEvidence: { _tag: 'SOURCE_REVISION' as const, revision: '2' },
          ownerEvidenceRef: 'INTERNAL_C14_EXPLICIT_SOURCE_REVISION_2',
          positionRef: setup.stockPosition.ref,
          quantity: { amount: '12', unitRef: unitResult.unit },
          receivedAt: DateTime.formatIso(observedAt),
          sourceReference: 'INTERNAL_C14_STOCK_ASSERTION_2',
        };
        const stockPayload = yield* Schema.decodeUnknownEffect(ImportSourceAssertionPayloadSchema)({
          authorizationTargetRef: setup.stockPosition.ref,
          items: [stockProposal],
        });
        const stockOccurrenceId = randomUUID();
        const stockPlan = yield* makeInternalStockPlan(
          { occurrenceId: stockOccurrenceId, recordId: stockRecordId },
          stockPayload,
          true,
        );
        const stockConfiguration = {
          ...Schema.encodeSync(SymmyInternalExecutionPlanSchema)(stockPlan),
          inventoryBackendId: internalStockBackendId,
          sourceRouteId: stockLogicalRouteId,
        };
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
          values(${stockRouteId},${tenantId},${integration.principalId},true,array['INTERNAL_C14'],${yield* json(yield* Schema.decodeUnknownEffect(Schema.Json)(stockConfiguration))}::jsonb,${internalSyncSource.mappingVersion},'inventoryStockBatch',${internalSyncSource.routeRevision},${yield* json(stockPolicy)}::jsonb)`;
        const otherAssertion = yield* makeInternalStockPlan(
          { occurrenceId: stockOccurrenceId, recordId: stockRecordId },
          { ...stockPayload, items: [{ ...stockProposal, assertionId: randomUUID() }] },
          true,
        );
        const substituted = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${stockPath}`, {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(otherAssertion),
          }),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_STOCK_WRONG_ASSERTION' },
        });
        expect(substituted.status).toBe(403);
        const stockResult = yield* submit(stockPath, stockRevision2Key, stockPlan);
        if (stockResult.items[0].outcome !== 'partial') {
          const diagnostics = yield* Effect.all(ownerDiagnostics);
          const nativeStatuses =
            yield* admin`select status,outcome_json ->> 'reason' as reason from inventory.source_import_ledger where tenant_id=${tenantId} and position_id=${setup.stockPosition.ref.resourceId}`.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Array(
                    Schema.Struct({ reason: Schema.OptionFromNullOr(Schema.String), status: Schema.String }),
                  ),
                ),
              ),
            );
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: `The native Stock result was not projected as partial: ${JSON.stringify(stockResult)}; native statuses ${JSON.stringify(nativeStatuses)}; gateway ${JSON.stringify(yield* shell.gatewayDiagnostics())}; owners ${diagnostics.join('\n')}`,
          });
        }
        expect(stockResult.items[0].outcome).toBe('partial');
        expect(stockResult.items[0].effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ owner: 'commerce.inventory', status: 'accepted_change' }),
            expect.objectContaining({ reason: 'unsupported_meaning', status: 'unsupported' }),
          ]),
        );
        const originalStockAdmissions =
          yield* admin`select admission_id::text from symmy_integration.sync_admissions where tenant_id=${tenantId} and route_id=${stockRouteId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(admissionRowSchema))),
          );
        expect(originalStockAdmissions).toHaveLength(1);
        const [originalStockAdmission] = originalStockAdmissions;
        assert.isDefined(originalStockAdmission);
        const stockReplay = yield* submit(stockPath, stockRevision2Key, stockPlan);
        expect(stockReplay).toEqual(stockResult);
        const fixedNativeHeader = 'INTERNAL_C14_NATIVE_STOCK_RETRY';
        yield* retryTransport.activate(fixedNativeHeader);
        expect(yield* submit(stockPath, stockRevision2Key, stockPlan)).toEqual(stockResult);
        expect(yield* submit(stockPath, stockRevision2Key, stockPlan)).toEqual(stockResult);
        const exactRetryFingerprints = yield* retryTransport.bodyFingerprints;
        expect(exactRetryFingerprints).toHaveLength(2);
        expect(new Set(exactRetryFingerprints).size).toBe(1);
        const [nativeReplayAnchor] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key='integration.symmy.admit-symmy-sync' and idempotency_key=${fixedNativeHeader}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(nativeReplayAnchor?.count).toBe(1);
        const [nativeReplayInvocation] =
          yield* admin`select action_invocation_id::text from core.action_invocations where tenant_id=${tenantId} and action_key='integration.symmy.admit-symmy-sync' and idempotency_key=${fixedNativeHeader}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(invocationRowSchema))),
          );
        assert.isDefined(nativeReplayInvocation);
        expect(nativeReplayInvocation.action_invocation_id).not.toBe(originalStockAdmission.admission_id);
        const changedStockPayload = yield* Schema.decodeUnknownEffect(ImportSourceAssertionPayloadSchema)({
          authorizationTargetRef: setup.stockPosition.ref,
          items: [{ ...stockProposal, quantity: { amount: '13', unitRef: unitResult.unit } }],
        });
        const changedStockPlan = yield* makeInternalStockPlan(
          { occurrenceId: stockOccurrenceId, recordId: stockRecordId },
          changedStockPayload,
          true,
        );
        const changedRetry = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${stockPath}`, {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(changedStockPlan),
          }),
          headers: { ...headers, 'idempotency-key': stockRevision2Key },
        });
        expect(changedRetry.status).toBe(409);
        const changedRetryFingerprints = yield* retryTransport.bodyFingerprints;
        expect(changedRetryFingerprints).toHaveLength(3);
        expect(changedRetryFingerprints[2]).not.toBe(exactRetryFingerprints[0]);
        yield* retryTransport.deactivate;
        const stalePayload = yield* Schema.decodeUnknownEffect(ImportSourceAssertionPayloadSchema)({
          authorizationTargetRef: setup.stockPosition.ref,
          items: [
            {
              ...stockProposal,
              assertionId: randomUUID(),
              orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '1' },
              ownerEvidenceRef: 'INTERNAL_C14_EXPLICIT_SOURCE_REVISION_1',
              quantity: { amount: '99', unitRef: unitResult.unit },
              sourceReference: 'INTERNAL_C14_STOCK_ASSERTION_1',
            },
          ],
        });
        const stalePlan = yield* makeInternalStockPlan(
          { occurrenceId: randomUUID(), recordId: stockRecordId },
          stalePayload,
          false,
        );
        const staleConfiguration = {
          ...Schema.encodeSync(SymmyInternalExecutionPlanSchema)(stalePlan),
          inventoryBackendId: internalStockBackendId,
          sourceRouteId: stockLogicalRouteId,
        };
        yield* admin`update symmy_integration.job_routes
          set fixture_plan = ${yield* json(yield* Schema.decodeUnknownEffect(Schema.Json)(staleConfiguration))}::jsonb
          where tenant_id = ${tenantId} and route_id = ${stockRouteId}`;
        const stale = yield* submit(stockPath, 'INTERNAL_C14_STOCK_REVISION_1', stalePlan);
        expect(stale.items[0].outcome).toBe('not_accepted');
        expect(stale.items[0].effects[0].status).toBe('stale');
        // Operator observation of committed owner facts; import leaves the base Position snapshot alone.
        const stockLedger = yield* admin`select l.assertion_id::text, l.status, l.ordering_evidence_value,
            l.proposal_json #>> '{quantity,amount}' as proposed_amount,
            l.outcome_json #>> '{postEffectOnHand,amount}' as accepted_amount,
            l.outcome_json ->> 'currentAssertionId' as current_assertion_id,
            a.assertion_id::text as persisted_assertion_id, a.quantity_amount as persisted_amount
            from inventory.source_import_ledger l left join inventory.source_assertions a
              on a.tenant_id=l.tenant_id and a.assertion_id=l.assertion_id
            where l.tenant_id=${tenantId} and l.position_id=${setup.stockPosition.ref.resourceId}
              and l.customer_configuration_id=${setup.configuration.customerConfigurationId}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(stockLedgerSchema))),
        );
        expect(stockLedger).toHaveLength(2);
        const acceptedStock = stockLedger.find(({ assertion_id }) => assertion_id === stockProposal.assertionId);
        assert.isDefined(acceptedStock);
        expect(acceptedStock).toMatchObject({
          ordering_evidence_value: '2',
          proposed_amount: '12',
          status: 'ACCEPTED',
        });
        expect(acceptedStock.accepted_amount).toEqual(Option.some('12'));
        expect(acceptedStock.persisted_amount).toEqual(Option.some('12'));
        expect(acceptedStock.persisted_assertion_id).toEqual(Option.some(stockProposal.assertionId));
        const staleStock = stockLedger.find(({ ordering_evidence_value }) => ordering_evidence_value === '1');
        assert.isDefined(staleStock);
        expect(staleStock).toMatchObject({ proposed_amount: '99', status: 'STALE' });
        expect(staleStock.current_assertion_id).toEqual(Option.some(stockProposal.assertionId));
        expect(staleStock.persisted_assertion_id).toEqual(Option.none());
        const changedMeaningPlan = yield* makeInternalGroupUpdatePlan(
          { occurrenceId: randomUUID(), recordId: groupRecordId },
          {
            description: groupPayload.description,
            expectedRevision: 2,
            groupRef,
            membershipCriteria: 'A different customer classification must not replace the existing Group meaning',
            name: 'Internal synchronous Group renamed',
            purpose: groupPayload.purpose,
            reason: 'INTERNAL_C14 explicit conflicting source meaning',
            source: {
              ...groupSource,
              definitionEvidence: { ...groupSource.definitionEvidence, revision: '3' },
              order: 3,
              revision: '3',
            },
          },
        );
        const meaningConflict = yield* submit(groupPath, 'INTERNAL_C14_GROUP_CHANGED_MEANING', changedMeaningPlan);
        expect(meaningConflict.items[0].outcome).toBe('not_accepted');
        if (meaningConflict.items[0].effects[0].status !== 'conflict') {
          const diagnostics = yield* Effect.all(ownerDiagnostics);
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: `The changed Group meaning was not classified as a conflict: ${JSON.stringify(meaningConflict)}; gateway ${JSON.stringify(yield* shell.gatewayDiagnostics())}; owners ${diagnostics.join('\n')}`,
          });
        }
        expect(meaningConflict.items[0].effects[0].status).toBe('conflict');
        const [unchangedMeaning] =
          yield* admin`select customer_group_id,current_revision as revision from commerce_customer_context.customer_groups where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(nativeGroupSchema))),
          );
        expect(unchangedMeaning).toEqual({ customer_group_id: group.customer_group_id, revision: 2 });
        const nameOnly = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${groupPath}`, {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: {
              ...encodedGroup,
              items: encodedGroup.items.map((item) => ({
                ...item,
                effects: item.effects.map((effect) => ({
                  ...effect,
                  intent: { _tag: 'CustomerGroupCreate', payload: { name: 'A name alone proves no Group meaning' } },
                })),
              })),
            },
          }),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_GROUP_NAME_ONLY' },
        });
        expect(nameOnly.status).toBe(400);
        const [jobs] =
          yield* admin`select count(*)::integer as count from symmy_integration.import_jobs where tenant_id=${tenantId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(jobs?.count).toBe(0);
        const [ownerCreates] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key='commerce.customer-context.create-customer-group'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(ownerCreates?.count).toBe(1);
        const [reservationWrites] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key='commerce.inventory.create-inventory-reservation'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(reservationWrites?.count).toBe(0);
        const [implicitGroupEffects] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and (action_key like 'commerce.pricing.%' or action_key like 'pricing.price-group-catalog.%' or action_key in ('commerce.customer-context.apply-customer-group-membership-source','commerce.customer-context.assign-customer-price-group','commerce.customer-context.assign-counterparty-price-group'))`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(implicitGroupEffects?.count).toBe(0);
        const [importsBeforeCancellation] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key='commerce.inventory.import-source-assertion'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(importsBeforeCancellation?.count).toBe(2);
        yield* stockWriter.revoke();
        yield* retryTransport.activate(fixedNativeHeader);
        expect(yield* submit(stockPath, stockRevision2Key, stockPlan)).toEqual(stockResult);
        yield* retryTransport.deactivate;
        const deniedStockPlan = yield* makeInternalStockPlan(
          { occurrenceId: randomUUID(), recordId: stockRecordId },
          stockPayload,
          true,
        );
        const deniedStockWrite = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${stockPath}`, {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(deniedStockPlan),
          }),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_STOCK_REVOKED_WRITER' },
        });
        expect(deniedStockWrite.status).toBe(503);
        yield* deniedStockWrite.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(syncUnavailableProblemSchema, { onExcessProperty: 'error' })),
        );
        // This is an explicit Core-owned TEST fault, not evidence of executing a real Privacy measure.
        yield* cancelOwnedSyncAdmissionFenceNative({
          admissionId: originalStockAdmission.admission_id,
          expectedLegalEntityId: null,
          expectedOriginalIntegrationPrincipalId: integration.principalId,
          ownedDatabase: isolated,
          purpose: fixturePurpose,
          tenantId,
        });
        yield* retryTransport.activate(fixedNativeHeader);
        const cancelledReplay = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${stockPath}`, {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(stockPlan),
          }),
          headers: { ...headers, 'idempotency-key': stockRevision2Key },
        });
        expect(cancelledReplay.status).toBe(503);
        yield* cancelledReplay.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(syncUnavailableProblemSchema, { onExcessProperty: 'error' })),
        );
        const [importsAfterCancellation] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key='commerce.inventory.import-source-assertion'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(importsAfterCancellation).toEqual(importsBeforeCancellation);
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(services)),
  240_000,
);
