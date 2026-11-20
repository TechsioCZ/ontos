import { randomUUID } from 'node:crypto';

import { executeCreateProductUnitWithAuthorization } from '@app/catalog/api/client';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import {
  CustomerGroupSourceAuthorityFixtureUnavailable,
  seedCustomerGroupSourceAuthority,
} from '@app/commerce-customer-context/testing/customer-group-source-authority';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { cancelOwnedSyncAdmissionFenceNative } from '@app/core-runtime/testing/source-execution-fence-native';
import { makeOwnedSystemWriterWorkloadControlNative } from '@app/core-runtime/testing/workload-binding-native';
import {
  C14InventorySourceImportSetupUnavailable,
  prepareC14InventorySourceImportNative,
} from '@app/inventory/testing/c14-source-import-native';
import { SymmyItemOutcomeSchema } from '@app/shared-contracts/symmy';
import { GatewayForbiddenProblemSchema, GatewayUnavailableProblemSchema } from '@app/shared-contracts';
import { makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { SymmyCustomerGroupRowSchema, SymmyStockRowSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { assert, expect, it } from 'effect-rstest';
import { Config, DateTime, Duration, Effect, Fiber, FileSystem, Layer, Option, Queue, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import { nameGroupDefinitionRouteReader } from './support/symmy-c14-group-definition-reader.mts';
import { prepareInternalSyncAuthority } from './support/symmy-c14-sync-authority.mts';
import { internalSyncSource } from './support/symmy-c14-sync-plans.mts';
import {
  deriveInternalStockAssertionId,
  makeInternalStockEnrollment,
  makeInternalStockRow,
  makeInternalStockSetup,
} from './support/symmy-c14-sync-stock-facts.mts';
import { installInternalC14StockDispatchBarrier } from './support/symmy-c14-stock-dispatch-barrier.mts';
import { startInternalSyncRetryTransport } from './support/symmy-c14-sync-retry-transport.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  buildProductOwner,
  nativePortList,
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
const stockResponseSchema = Schema.Struct({
  items: Schema.NonEmptyArray(
    Schema.Struct({
      ...responseSchema.fields.items.value.fields,
      itemKey: SymmyStockRowSchema.fields.itemKey,
      locationKey: SymmyStockRowSchema.fields.locationKey,
    }),
  ),
});
const groupResponseSchema = Schema.Struct({
  items: Schema.NonEmptyArray(
    Schema.Struct({ ...responseSchema.fields.items.value.fields, code: SymmyCustomerGroupRowSchema.fields.code }),
  ),
});
type JsonBody = ReturnType<typeof HttpBody.json>;
type StockRequestRow = ReturnType<typeof makeInternalStockRow>;
const stockBody = (rows: readonly StockRequestRow[]) => HttpBody.json({ stock: rows });
type GroupRequestRow = typeof SymmyCustomerGroupRowSchema.Encoded;
const groupBody = (rows: readonly GroupRequestRow[]) => HttpBody.json({ customerGroups: rows });
const groupOperation = (entrypointKey: string) => ({
  entrypointKey,
  moduleId: 'commerce.customer-context',
  schemaVersion: '1',
});
const inventoryOwner = 'commerce.inventory';
const groupAppId = 'commerce-customer-context';
const groupPath = 'customer-groups/batch';
const stockPath = 'inventory/stock/batch';
const groupCreateKey = 'INTERNAL_C14_GROUP_CREATE';
const stockRevision2Key = 'INTERNAL_C14_STOCK_REVISION_2';
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
const readOwnerLostAckWitness = (output: Queue.Queue<string>, owner: string) =>
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
          message: `The actual ${owner} receiver emitted no committed ACK-loss witness`,
        }),
    }),
  );

it.live(
  'INTERNAL_C14 actual synchronous Group and Stock routes persist native effects and recover exact receipts without jobs',
  () =>
    Effect.scoped(
      Effect.gen(function* actualSyncConformance() {
        const [catalogPort, commercePort, inventoryPort, symmyPort, retryPort, stockBarrierPort] =
          yield* nativePortList(6);
        assert.isDefined(catalogPort);
        assert.isDefined(commercePort);
        assert.isDefined(inventoryPort);
        assert.isDefined(symmyPort);
        assert.isDefined(retryPort);
        assert.isDefined(stockBarrierPort);
        const stockDispatch = yield* installInternalC14StockDispatchBarrier({
          port: stockBarrierPort,
          targetOrigin: `http://127.0.0.1:${inventoryPort}`,
        });
        const backends = {
          catalog: `http://127.0.0.1:${catalogPort}/`,
          [groupAppId]: `http://127.0.0.1:${commercePort}/`,
          inventory: `http://127.0.0.1:${stockBarrierPort}/`,
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
        // The public group row states every owner fact; the route enrollment supplies the source and its authority.
        const groupRow = {
          businessCode: 'INTERNAL_C14_SYNC_GROUP',
          code: groupRecordId,
          description: 'Explicit internal fixture Group definition',
          meaningKey: 'internal-c14.explicit-group-meaning',
          membershipCriteria: 'Only the explicitly named internal fixture customers',
          name: 'Internal synchronous Group',
          purpose: 'Internal source-owned customer classification',
        };
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
        // The route enrolls the group create and update and the definition read that fences each row on the owner.
        const groupConfiguration = {
          items: [
            {
              effects: [
                {
                  effectKey: 'customer-group-create',
                  operation: groupOperation('commerce.customer-context.create-customer-group'),
                },
                {
                  effectKey: 'customer-group-update',
                  operation: groupOperation('commerce.customer-context.update-customer-group'),
                },
                {
                  effectKey: 'customer-group-definition-read',
                  operation: groupOperation('commerce.customer-context.api.customer-group-definition-source'),
                },
              ],
              itemKey: 'customer-group',
              source: {
                entityKind: 'CUSTOMER_GROUP',
                issuerId: internalSyncSource.issuerId,
                sourceNamespace: internalSyncSource.namespace,
                sourceRecordId: groupRecordId,
              },
            },
          ],
          sourceMappingVersion: internalSyncSource.mappingVersion,
          sourceRouteId: groupLogicalRouteId,
          sourceRouteRevision: internalSyncSource.routeRevision,
        };
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,legal_entity_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
          values(${groupRouteId},${tenantId},${integration.principalId},${legalEntityId},true,array['INTERNAL_C14'],${yield* json(yield* Schema.decodeUnknownEffect(Schema.Json)(groupConfiguration))}::jsonb,${internalSyncSource.mappingVersion},'customerGroupsBatch',${internalSyncSource.routeRevision},${yield* json(groupPolicy)}::jsonb)`;
        const lifecycle = yield* json([
          {
            ...groupPolicy,
            governanceLegalEntityId: legalEntityId,
            retentionMs: 900_000,
            routeId: groupRouteId,
            targetLegalEntityId: legalEntityId,
            tenantId,
          },
          {
            ...stockPolicy,
            governanceLegalEntityId: legalEntityId,
            retentionMs: 900_000,
            routeId: stockRouteId,
            targetLegalEntityId: null,
            tenantId,
          },
        ]);
        const ownerEnvironment = { ...environment, ONTOS_SYMMY_JOB_RETENTION_POLICIES: lifecycle };
        const fs = yield* FileSystem.FileSystem;
        const faultDirectory = yield* fs.makeTempDirectoryScoped({ prefix: 'INTERNAL_C14_SYNC_ACK_' });
        const groupFaultMarker = `${faultDirectory}/group-committed-response-loss`;
        const stockFaultMarker = `${faultDirectory}/stock-committed-response-loss`;
        yield* fs.writeFileString(groupFaultMarker, 'INTERNAL_C14 transport outage after native Group commit');
        const faultByOwner = new Map([
          [
            groupAppId,
            {
              ONTOS_C14_RESPONSE_LOSS_MARKER: groupFaultMarker,
              ONTOS_C14_RESPONSE_LOSS_OPERATION: 'customer-group-create',
            },
          ],
          [
            'inventory',
            {
              ONTOS_C14_RESPONSE_LOSS_MARKER: stockFaultMarker,
              ONTOS_C14_RESPONSE_LOSS_OPERATION: 'inventory-import',
            },
          ],
        ]);
        const ownerDiagnostics: Effect.Effect<string>[] = [];
        const ownerOutput = new Map<string, Queue.Queue<string>>();
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
            environment: { ...ownerEnvironment, ...faultByOwner.get(appId) },
            port,
            prefix,
          });
          ownerDiagnostics.push(running.diagnostic);
          ownerOutput.set(appId, running.output);
        }
        // The Shell reads each code's current definition as the API-key integration principal before it admits.
        yield* nameGroupDefinitionRouteReader({
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          administratorPrincipalId: integration.issuerPrincipalId,
          commerceBaseUrl: `${backends[groupAppId]}commerce-customer-context-api`,
          compositionRevision: snapshot.composition.revision,
          readerPrincipalId: integration.principalId,
          route: groupSetupRequest.route,
          shell,
        });
        const retryTransport = yield* startInternalSyncRetryTransport({
          ownerOrigin: `http://127.0.0.1:${symmyPort}`,
          port: retryPort,
        });
        const client = yield* HttpClient.HttpClient;
        const headers = { 'x-api-key': Redacted.value(ingressKey.secret) };
        const postSynchronous = (path: string, idempotencyKey: string, body: JsonBody) =>
          Effect.gen(function* postSynchronousRoute() {
            const response = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${path}`, {
              body: yield* body,
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
            return response;
          });
        const submit = (idempotencyKey: string, rows: readonly GroupRequestRow[]) =>
          postSynchronous(groupPath, idempotencyKey, groupBody(rows)).pipe(
            Effect.flatMap((response) =>
              response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(groupResponseSchema))),
            ),
          );
        const submitStock = (idempotencyKey: string, rows: readonly StockRequestRow[]) =>
          postSynchronous(stockPath, idempotencyKey, stockBody(rows)).pipe(
            Effect.flatMap((response) =>
              response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(stockResponseSchema))),
            ),
          );
        const postStockRaw = (body: JsonBody, idempotencyKey?: string) =>
          Effect.gen(function* postStockWithoutDiagnostics() {
            return yield* client.post(`${shell.baseUrl}/api/symmy/v1/${stockPath}`, {
              body: yield* body,
              headers: idempotencyKey === undefined ? headers : { ...headers, 'idempotency-key': idempotencyKey },
            });
          });
        const lostGroupResponse = yield* submit(groupCreateKey, [groupRow]);
        expect(lostGroupResponse.items).toHaveLength(1);
        expect(lostGroupResponse.items[0].code).toBe(groupRecordId);
        expect(lostGroupResponse.items[0].outcome).toBe('not_accepted');
        expect(lostGroupResponse.items[0].effects[0].status).toBe('indeterminate');
        const groupOutput = ownerOutput.get(groupAppId);
        assert.isDefined(groupOutput);
        const lostAckWitness = yield* readOwnerLostAckWitness(groupOutput, groupAppId).pipe(
          Effect.tapError(() =>
            Effect.all([shell.gatewayDiagnostics(), shell.issuerDiagnostics(), ...ownerDiagnostics]).pipe(
              Effect.flatMap((diagnostics) =>
                Effect.logError('Synchronous Group response-loss diagnostics', diagnostics),
              ),
            ),
          ),
        );
        expect(lostAckWitness.path.endsWith('/actions/create-customer-group')).toBe(true);
        const [committedBeforeRecovery] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key='commerce.customer-context.create-customer-group' and status='succeeded'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(committedBeforeRecovery?.count).toBe(1);
        // Exercise the live composition source cache's 30-second refresh before current recovery authority is checked.
        yield* Effect.sleep(Duration.seconds(31));
        yield* groupWriter.revoke();
        yield* admin`update symmy_integration.job_routes
          set route_revision='INTERNAL_C14_GROUP_RECEIVING_R2', mapping_version='INTERNAL_C14_GROUP_RECEIVING_MAP_R2'
          where tenant_id=${tenantId} and route_id=${groupRouteId}`;
        yield* fs.remove(groupFaultMarker);
        const groupResult = yield* submit(groupCreateKey, [groupRow]);
        if (groupResult.items[0].outcome !== 'accepted') {
          const diagnostics = yield* Effect.all(ownerDiagnostics);
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: `The committed Group receipt did not recover: ${JSON.stringify(groupResult)}; gateway ${JSON.stringify(yield* shell.gatewayDiagnostics())}; owners ${diagnostics.join('\n')}`,
          });
        }
        expect(groupResult.items[0].code).toBe(groupRecordId);
        expect(groupResult.items[0].outcome).toBe('accepted');
        expect(groupResult.items[0].effects[0].status).toBe('accepted_change');
        const groupReplay = yield* submit(groupCreateKey, [groupRow]);
        expect(groupReplay).toEqual(groupResult);
        const deniedGroupWrite = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${groupPath}`, {
          body: yield* groupBody([groupRow]),
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
        // The same code with the same business code and meaning revises the group its code is bound to.
        const renamedRow = { ...groupRow, name: 'Internal synchronous Group renamed' };
        const rename = yield* submit('INTERNAL_C14_GROUP_RENAME', [renamedRow]);
        if (rename.items[0].outcome !== 'accepted') {
          const diagnostics = yield* Effect.all(ownerDiagnostics);
          return yield* new SymmyC14ProductFixtureUnavailable({
            message: `The cosmetic Group rename did not commit: ${JSON.stringify(rename)}; gateway ${JSON.stringify(yield* shell.gatewayDiagnostics())}; owners ${diagnostics.join('\n')}`,
          });
        }
        expect(rename.items[0].code).toBe(groupRecordId);
        expect(rename.items[0].outcome).toBe('accepted');
        expect(rename.items[0].effects[0].status).toBe('accepted_change');
        // The update kept the binding of the code and followed the order of its last assertion.
        expect(
          yield* admin`select customer_group_id,source_code,source_order from commerce_customer_context.customer_group_definition_source_bindings
            where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}`,
        ).toEqual([{ customer_group_id: group.customer_group_id, source_code: groupRecordId, source_order: 2 }]);
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
        const stockRow = (input: {
          readonly amount: string;
          readonly revision: string;
          readonly sourceReference: string;
        }) =>
          makeInternalStockRow({
            ...input,
            businessObservedAt: DateTime.formatIso(observedAt),
            setup,
            unitRef: unitResult.unit,
          });
        const stockRevision2 = stockRow({
          amount: '12',
          revision: '2',
          sourceReference: 'INTERNAL_C14_STOCK_ASSERTION_2',
        });
        const stockEnrollment = yield* makeInternalStockEnrollment({ setup, sourceRouteId: stockLogicalRouteId });
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
          values(${stockRouteId},${tenantId},${integration.principalId},true,array['INTERNAL_C14'],${yield* json(yield* Schema.decodeUnknownEffect(Schema.Json)(stockEnrollment))}::jsonb,${internalSyncSource.mappingVersion},'inventoryStockBatch',${internalSyncSource.routeRevision},${yield* json(stockPolicy)}::jsonb)`;
        const importCalls = admin`select count(*)::integer as count from core.action_invocations
            where tenant_id=${tenantId} and action_key='commerce.inventory.import-source-assertion'`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          Effect.map(([calls]) => calls?.count),
        );
        // Acceptance 4: one unenrolled row rejects the whole request and no owner call is made for either row.
        const substituted = yield* postStockRaw(
          stockBody([stockRevision2, { ...stockRevision2, itemKey: 'INTERNAL_C14_UNENROLLED_ITEM' }]),
          'INTERNAL_C14_STOCK_UNENROLLED_ROW',
        );
        expect(substituted.status).toBe(403);
        yield* substituted.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(GatewayForbiddenProblemSchema)));
        const unenrolledLocation = yield* postStockRaw(
          stockBody([{ ...stockRevision2, locationKey: 'INTERNAL_C14_UNENROLLED_LOCATION' }]),
          'INTERNAL_C14_STOCK_UNENROLLED_LOCATION',
        );
        expect(unenrolledLocation.status).toBe(403);
        expect(yield* importCalls).toBe(0);
        // Acceptance 6 and 5: the key is required, and the retired internal bodies are invalid on the public route.
        expect((yield* postStockRaw(stockBody([stockRevision2]))).status).toBe(428);
        expect(
          (yield* postStockRaw(
            HttpBody.json({ contractVersion: 'INTERNAL_C14', stock: [stockRevision2] }),
            'INTERNAL_C14_STOCK_VERSIONED',
          )).status,
        ).toBe(400);
        expect(
          (yield* postStockRaw(
            HttpBody.json({ stock: [{ ...stockRevision2, reservedQuantity: '1' }] }),
            'INTERNAL_C14_STOCK_RESERVED',
          )).status,
        ).toBe(400);
        expect(
          (yield* postStockRaw(HttpBody.json({ fixtureId: 'INTERNAL_C14' }), 'INTERNAL_C14_STOCK_FIXTURE')).status,
        ).toBe(400);
        expect(yield* importCalls).toBe(0);
        yield* fs.writeFileString(stockFaultMarker, 'INTERNAL_C14 transport outage after native Stock commit');
        const lostStockResponse = yield* submitStock(stockRevision2Key, [stockRevision2]);
        expect(lostStockResponse.items[0].effects).toEqual(
          expect.arrayContaining([expect.objectContaining({ owner: inventoryOwner, status: 'indeterminate' })]),
        );
        const stockOutput = ownerOutput.get('inventory');
        assert.isDefined(stockOutput);
        const stockLostAck = yield* readOwnerLostAckWitness(stockOutput, 'inventory');
        expect(stockLostAck.path.endsWith('/actions/import-source-assertion')).toBe(true);
        yield* admin`update symmy_integration.job_routes set active=false, principal_id=${integration.issuerPrincipalId}
          where tenant_id=${tenantId} and route_id=${stockRouteId}`;
        const recoveryStockRouteId = randomUUID();
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,active,fixture_ids,mapping_version,route_key,route_revision)
          values(${recoveryStockRouteId},${tenantId},${integration.principalId},true,array['INTERNAL_C14'],
            'INTERNAL_C14_STOCK_RECEIVING_MAP_R2','inventoryStockBatch','INTERNAL_C14_STOCK_RECEIVING_R2')`;
        yield* fs.remove(stockFaultMarker);
        const stockResult = yield* submitStock(stockRevision2Key, [stockRevision2]);
        yield* admin`delete from symmy_integration.job_routes where tenant_id=${tenantId} and route_id=${recoveryStockRouteId}`;
        yield* admin`update symmy_integration.job_routes
          set active=true, principal_id=${integration.principalId}
          where tenant_id=${tenantId} and route_id=${stockRouteId}`;
        if (stockResult.items[0].outcome !== 'accepted') {
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
            message: `The native Stock result was not projected as accepted: ${JSON.stringify(stockResult)}; native statuses ${JSON.stringify(nativeStatuses)}; gateway ${JSON.stringify(yield* shell.gatewayDiagnostics())}; owners ${diagnostics.join('\n')}`,
          });
        }
        // Acceptance 1: one accepted effect for the one enrolled row, answered with the keys of that row.
        expect(stockResult.items).toHaveLength(1);
        expect(stockResult.items[0]).toMatchObject({
          itemKey: stockRevision2.itemKey,
          locationKey: stockRevision2.locationKey,
          outcome: 'accepted',
        });
        expect(stockResult.items[0].effects).toEqual([
          expect.objectContaining({ owner: inventoryOwner, status: 'accepted_change' }),
        ]);
        const originalStockAdmissions =
          yield* admin`select admission_id::text from symmy_integration.sync_admissions where tenant_id=${tenantId} and route_id=${stockRouteId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(admissionRowSchema))),
          );
        expect(originalStockAdmissions).toHaveLength(1);
        const [originalStockAdmission] = originalStockAdmissions;
        assert.isDefined(originalStockAdmission);
        const stockReplay = yield* submitStock(stockRevision2Key, [stockRevision2]);
        expect(stockReplay).toEqual(stockResult);
        const fixedNativeHeader = 'INTERNAL_C14_NATIVE_STOCK_RETRY';
        yield* retryTransport.activate(fixedNativeHeader);
        expect(yield* submitStock(stockRevision2Key, [stockRevision2])).toEqual(stockResult);
        expect(yield* submitStock(stockRevision2Key, [stockRevision2])).toEqual(stockResult);
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
        // Acceptance 2: the same key with a different figure is a conflict, and only the exact retry reaches the owner.
        const changedRetry = yield* postStockRaw(
          stockBody([{ ...stockRevision2, quantity: { ...stockRevision2.quantity, amount: '13' } }]),
          stockRevision2Key,
        );
        expect(changedRetry.status).toBe(409);
        const changedRetryFingerprints = yield* retryTransport.bodyFingerprints;
        expect(changedRetryFingerprints).toHaveLength(3);
        expect(changedRetryFingerprints[2]).not.toBe(exactRetryFingerprints[0]);
        yield* retryTransport.deactivate;
        // Acceptance 3: an older revision is stale and leaves the stock figure alone.
        const staleRows = [
          stockRow({ amount: '99', revision: '1', sourceReference: 'INTERNAL_C14_STOCK_ASSERTION_1' }),
        ];
        const stale = yield* submitStock('INTERNAL_C14_STOCK_REVISION_1', staleRows);
        expect(stale.items[0].outcome).toBe('not_accepted');
        expect(stale.items[0].effects[0].status).toBe('stale');
        expect(stale.items[0]).toMatchObject({
          itemKey: stockRevision2.itemKey,
          locationKey: stockRevision2.locationKey,
        });
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
        const acceptedAssertionId = deriveInternalStockAssertionId(stockRevision2Key, 0);
        const acceptedStock = stockLedger.find(({ assertion_id }) => assertion_id === acceptedAssertionId);
        assert.isDefined(acceptedStock);
        expect(acceptedStock).toMatchObject({
          ordering_evidence_value: '2',
          proposed_amount: '12',
          status: 'ACCEPTED',
        });
        expect(acceptedStock.accepted_amount).toEqual(Option.some('12'));
        expect(acceptedStock.persisted_amount).toEqual(Option.some('12'));
        expect(acceptedStock.persisted_assertion_id).toEqual(Option.some(acceptedAssertionId));
        const staleStock = stockLedger.find(({ ordering_evidence_value }) => ordering_evidence_value === '1');
        assert.isDefined(staleStock);
        expect(staleStock).toMatchObject({ proposed_amount: '99', status: 'STALE' });
        expect(staleStock.current_assertion_id).toEqual(Option.some(acceptedAssertionId));
        expect(staleStock.persisted_assertion_id).toEqual(Option.none());
        // The admission time is stored once, with the admission: the owner imported exactly what the replays returned.
        const receivedAtFacts =
          yield* admin`select a.execution_plan #>> '{items,0,effects,0,intent,payload,items,0,receivedAt}' as admitted_at,
            l.proposal_json ->> 'receivedAt' as imported_at
            from symmy_integration.sync_admissions a, inventory.source_import_ledger l
            where a.tenant_id=${tenantId} and a.route_id=${stockRouteId}
              and a.execution_plan #>> '{items,0,effects,0,intent,payload,items,0,assertionId}' = ${acceptedAssertionId}
              and l.tenant_id=${tenantId} and l.assertion_id=${acceptedAssertionId}::uuid`.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ admitted_at: Schema.String, imported_at: Schema.String })),
              ),
            ),
          );
        expect(receivedAtFacts).toHaveLength(1);
        const [receivedAtFact] = receivedAtFacts;
        assert.isDefined(receivedAtFact);
        expect(receivedAtFact.admitted_at).toBe(receivedAtFact.imported_at);
        expect(Date.parse(receivedAtFact.admitted_at)).toBeGreaterThanOrEqual(DateTime.toEpochMillis(observedAt));
        const meaningConflict = yield* submit('INTERNAL_C14_GROUP_CHANGED_MEANING', [
          {
            ...renamedRow,
            membershipCriteria: 'A different customer classification must not replace the existing Group meaning',
          },
        ]);
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
            customerGroups: [{ code: groupRecordId, name: 'A name alone proves no Group meaning' }],
          }),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_GROUP_NAME_ONLY' },
        });
        expect(nameOnly.status).toBe(400);
        // The retired internal bodies are invalid on the public route.
        for (const [idempotencyKey, body] of [
          ['INTERNAL_C14_GROUP_VERSIONED', { contractVersion: 'INTERNAL_C14', customerGroups: [groupRow] }],
          ['INTERNAL_C14_GROUP_FIXTURE', { fixtureId: 'INTERNAL_C14' }],
        ] as const) {
          const retired = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${groupPath}`, {
            body: yield* HttpBody.json(body),
            headers: { ...headers, 'idempotency-key': idempotencyKey },
          });
          expect(retired.status).toBe(400);
        }
        // Public groups are caller payload the admission retains, so a route whose lifecycle policy is absent or matches
        // no configured retention policy refuses them before admission: no sync admission and no owner write follow.
        const groupAdmissions =
          admin`select count(*)::integer as count from symmy_integration.sync_admissions where tenant_id=${tenantId} and route_id=${groupRouteId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
            Effect.map(([admissions]) => admissions?.count),
          );
        const admittedGroups = yield* groupAdmissions;
        const unconfiguredPolicy = yield* json({ ...groupPolicy, revision: 'INTERNAL_C14_UNCONFIGURED' });
        for (const [idempotencyKey, setPolicy] of [
          [
            'INTERNAL_C14_GROUP_WITHOUT_POLICY',
            admin`update symmy_integration.job_routes set lifecycle_policy=null where tenant_id=${tenantId} and route_id=${groupRouteId}`,
          ],
          [
            'INTERNAL_C14_GROUP_UNCONFIGURED_POLICY',
            admin`update symmy_integration.job_routes set lifecycle_policy=${unconfiguredPolicy}::jsonb where tenant_id=${tenantId} and route_id=${groupRouteId}`,
          ],
        ] as const) {
          yield* setPolicy;
          const unretained = yield* client.post(`${shell.baseUrl}/api/symmy/v1/${groupPath}`, {
            body: yield* groupBody([
              {
                ...groupRow,
                businessCode: 'INTERNAL_C14_UNRETAINED',
                code: 'INTERNAL_C14_UNRETAINED',
                meaningKey: 'internal-c14.unretained-group-meaning',
              },
            ]),
            headers: { ...headers, 'idempotency-key': idempotencyKey },
          });
          // The owner refuses the admission as ineligible, which the Shell answers as unavailable, as for a revoked writer.
          expect(unretained.status).toBe(503);
          yield* unretained.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(syncUnavailableProblemSchema, { onExcessProperty: 'error' })),
          );
        }
        yield* admin`update symmy_integration.job_routes set lifecycle_policy=${yield* json(groupPolicy)}::jsonb where tenant_id=${tenantId} and route_id=${groupRouteId}`;
        expect(yield* groupAdmissions).toBe(admittedGroups);
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
        // Acceptance 1 and 2 without a lost response: a plain newer revision, then the exact replay of the same key.
        const plainKey = 'INTERNAL_C14_STOCK_PLAIN_REVISION_4';
        const plainRow = stockRow({
          amount: '14',
          revision: '4',
          sourceReference: 'INTERNAL_C14_STOCK_ASSERTION_4',
        });
        const plainRows = [plainRow];
        const plain = yield* submitStock(plainKey, plainRows);
        expect(plain.items[0]).toMatchObject({ itemKey: stockRevision2.itemKey, outcome: 'accepted' });
        expect(plain.items[0].effects).toEqual([
          expect.objectContaining({ owner: inventoryOwner, status: 'accepted_change' }),
        ]);
        expect(yield* submitStock(plainKey, plainRows)).toEqual(plain);
        expect((yield* postStockRaw(stockBody([{ ...plainRow, revision: '5' }]), plainKey)).status).toBe(409);
        const heldKey = 'INTERNAL_C14_STOCK_ROUTE_DEACTIVATED_IN_FLIGHT';
        const heldAssertionId = deriveInternalStockAssertionId(heldKey, 0);
        const heldRows = [stockRow({ amount: '13', revision: '3', sourceReference: 'INTERNAL_C14_STOCK_ASSERTION_3' })];
        yield* stockDispatch.armForAssertion(heldAssertionId);
        const heldStock = yield* Effect.forkChild(submitStock(heldKey, heldRows));
        const heldCommand = yield* stockDispatch.arrived.pipe(Effect.timeout(Duration.seconds(20)));
        expect(heldCommand.items[0]?.assertionId).toBe(heldAssertionId);
        const disabledStock = yield* admin`update symmy_integration.job_routes set active=false
          where tenant_id=${tenantId} and route_id=${stockRouteId} returning route_id`;
        expect(disabledStock).toHaveLength(1);
        yield* stockDispatch.release;
        expect(yield* stockDispatch.reply.pipe(Effect.timeout(Duration.seconds(20)))).toEqual({
          code: 'action_transaction_failed',
          status: 503,
        });
        expect((yield* Fiber.join(heldStock)).items[0].outcome).toBe('not_accepted');
        const [rejectedStockWrites] = yield* admin`select count(*)::integer as count from inventory.source_import_ledger
            where tenant_id=${tenantId} and assertion_id=${heldAssertionId}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
        );
        expect(rejectedStockWrites?.count).toBe(0);
        yield* admin`update symmy_integration.job_routes set active=true
          where tenant_id=${tenantId} and route_id=${stockRouteId}`;
        const [importsBeforeCancellation] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key='commerce.inventory.import-source-assertion' and status='succeeded'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(importsBeforeCancellation?.count).toBe(3);
        yield* stockWriter.revoke();
        yield* retryTransport.activate(fixedNativeHeader);
        expect(yield* submitStock(stockRevision2Key, [stockRevision2])).toEqual(stockResult);
        yield* retryTransport.deactivate;
        const deniedStockWrite = yield* postStockRaw(stockBody(staleRows), 'INTERNAL_C14_STOCK_REVOKED_WRITER');
        expect(deniedStockWrite.status).toBe(503);
        yield* deniedStockWrite.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(syncUnavailableProblemSchema, { onExcessProperty: 'error' })),
        );
        // The replacement route retains read access to the logical key after the backend and plan are withdrawn.
        yield* admin`update symmy_integration.job_routes set active=false, principal_id=${integration.issuerPrincipalId}
          where tenant_id=${tenantId} and route_id=${stockRouteId}`;
        const replacementStockRouteId = randomUUID();
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,active,fixture_ids,mapping_version,route_key,route_revision)
          values(${replacementStockRouteId},${tenantId},${integration.principalId},true,array['INTERNAL_C14'],
            'INTERNAL_C14_STOCK_RECEIVING_MAP_R2','inventoryStockBatch','INTERNAL_C14_STOCK_RECEIVING_R2')`;
        expect(yield* submitStock(stockRevision2Key, [stockRevision2])).toEqual(stockResult);
        const withdrawnBackend = yield* postStockRaw(
          stockBody([stockRevision2]),
          'INTERNAL_C14_STOCK_WITHDRAWN_BACKEND',
        );
        expect(withdrawnBackend.status).toBe(403);
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
        const cancelledReplay = yield* postStockRaw(stockBody([stockRevision2]), stockRevision2Key);
        expect(cancelledReplay.status).toBe(503);
        yield* cancelledReplay.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(syncUnavailableProblemSchema, { onExcessProperty: 'error' })),
        );
        const [importsAfterCancellation] =
          yield* admin`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key='commerce.inventory.import-source-assertion' and status='succeeded'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(countSchema))),
          );
        expect(importsAfterCancellation).toEqual(importsBeforeCancellation);
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(services)),
  360_000,
);
