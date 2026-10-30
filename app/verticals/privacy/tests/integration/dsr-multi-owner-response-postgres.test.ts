import { Reactivity } from 'effect/reactivity';
import { PgClient } from '@effect/sql-pg';
import {
  ActionAlreadyCommitted,
  ActiveApplicationCompositionSnapshotSchema,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
  ReadRuntime,
  TrustedPrincipalContextSchema,
  canonicalizeApplicationComposition,
  makeContextPermissionRelationshipMutationLive,
  OntosModuleDeploymentContractSchema,
  runAction,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { createHash } from 'node:crypto';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Result,
  Schema,
} from 'effect';
import { expect, it } from 'effect-rstest';
import { createHttpApiHandler } from '@modern-js/bff-effect/effect-edge';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { makePrivacyApiRuntime } from '../../api/index.ts';
import { dsrTestStorageGuards, makeDsrObligationNative } from '../support/dsr-obligation-native.ts';
import { executeDsrCasesWithAuthorization } from '../../src/api/dsr-cases-client.ts';
import { executeRecordDsrResponseWithAuthorization } from '../../src/api/record-dsr-response-action-client.ts';

import { DsrDeliveryAccessAuthorityResultSchema } from '../../shared/domain/dsr-delivery-access.ts';
import {
  DsrCaseRequestSchema,
  DsrIntakeReceiptSchema,
  DsrOwnerInventoryAuthorityResultSchema,
  DsrOwnerTaskAuthorityResultSchema,
  DsrSubstantiveDecisionAuthorityResultSchema,
} from '../../shared/domain/privacy-dsr.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createDsrCaseAction, DsrIntakeReceiptAuthority } from '../../src/actions/create-dsr-case.action.ts';
import { DsrDeliveryAccessAuthority } from '../../src/actions/dsr-delivery-access-authority.ts';
import { issueDsrDeliveryAccessAction } from '../../src/actions/issue-dsr-delivery-access.action.ts';
import { DsrOwnerInventoryAuthority } from '../../src/actions/privacy-dsr-owner-inventory-authority.ts';
import { DsrOwnerTaskAuthority } from '../../src/actions/privacy-dsr-owner-task-authority.ts';
import { DsrSubstantiveDecisionAuthority } from '../../src/actions/privacy-dsr-substantive-decision-authority.ts';
import {
  recordDsrDeliveryEvidenceAction,
  DsrDeliveryAuthority,
} from '../../src/actions/record-dsr-delivery-evidence.action.ts';
import { recordDsrResponseAction } from '../../src/actions/record-dsr-response.action.ts';
import { recordDsrSubstantiveDecisionAction } from '../../src/actions/record-dsr-substantive-decision.action.ts';
import { updateDsrCaseAction } from '../../src/actions/update-dsr-case.action.ts';
import { upsertDsrOwnerTaskAction } from '../../src/actions/upsert-dsr-owner-task.action.ts';
import { dsrCasesRead } from '../../src/api/dsr-cases.read.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const makeDsrIsolation = Effect.fn('DsrMultiOwner.makeIsolation')(function* makeDsrIsolation() {
  const base = yield* makeApplicationCompositionSnapshotFixture(
    [ultramodernApiMarker.appId],
    ultramodernApiMarker.buildMarker,
  );
  const modules = yield* Effect.forEach(
    base.composition.modules,
    Effect.fn('DsrMultiOwner.module')(function* module(entry) {
      const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
        entry.contractDocument,
      );
      const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))({
        ...contract,
        manifest: { ...contract.manifest, module: { ...contract.manifest.module, id: 'privacy.core' } },
      });
      const sha256 = digest(contractDocument);
      return {
        ...entry,
        contract: { ...entry.contract, sha256 },
        contractDocument,
        moduleId: 'privacy.core',
        publicContract: { ...entry.publicContract, id: 'privacy.core', sha256 },
      };
    }),
    { concurrency: 1 },
  );
  const composition = { ...base.composition, modules };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: {
      ...composition,
      revision: digest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
    },
  });
  const owned = yield* makeDsrObligationNative(snapshot);
  return { ...owned, snapshot };
});

const actionKeys = [
  createDsrCaseAction,
  recordDsrSubstantiveDecisionAction,
  upsertDsrOwnerTaskAction,
  recordDsrResponseAction,
  issueDsrDeliveryAccessAction,
  recordDsrDeliveryEvidenceAction,
  updateDsrCaseAction,
].map(({ descriptor }) => descriptor.actionKey);
const testOwnerA = 'TEST.owner-a';
const testOwnerB = 'TEST.owner-b';
const testController = 'TEST.controller';
const authorityFailure = () =>
  new PrivacyOperationPersistenceError({
    code: 'privacy_operation_persistence_unavailable',
    reason: 'Exact TEST DSR authority precondition was not satisfied',
  });

const makeDsrNative = Effect.fn('DsrMultiOwner.makeNative')(function* makeDsrNative(
  requiredOwners: readonly string[],
  receivedAt: string,
  obligationCount: 1 | 2 = 1,
) {
  const { isolated, makeRedemption, snapshot } = yield* makeDsrIsolation();
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys,
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleAccess: 'configured-modules',
      moduleKeys: ['privacy.core'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (value) => value.close().pipe(Effect.orDie),
  );
  const coreEvidenceServices = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceServices));
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    ...fixture.manager,
    legalEntityId: fixture.legalEntityId,
  });
  const caseRef = `dsr:${yield* nextId}`;
  const obligationRef = `obligation:${yield* nextId}`;
  const exactScopeRefs = [`scope:${yield* nextId}`];
  const subjectRef = `TEST.subject:${yield* nextId}`;
  const request = yield* Schema.decodeUnknownEffect(DsrCaseRequestSchema)({
    caseRef,
    controllerObligations: Array.from({ length: obligationCount }, (_, index) => ({
      controllerRef: testController,
      exactScopeRefs: index === 0 ? exactScopeRefs : [`${exactScopeRefs[0]}:second`],
      obligationRef: index === 0 ? obligationRef : `${obligationRef}:second`,
      requestedRights: ['ACCESS'],
    })),
    intakeClaimRef: `TEST.intake:${caseRef}`,
    requestedRights: ['ACCESS'],
    requester: { kind: 'RESOLVED', subjectRef },
    subjectRefs: [subjectRef],
    unresolvedParts: [],
  });
  const status = yield* Ref.make<'PENDING' | 'SUCCEEDED'>('SUCCEEDED');
  const inventoryMode = yield* Ref.make<'valid' | 'duplicate' | 'foreign' | 'unavailable'>('valid');
  const accessId = `TEST.access:${caseRef}`;
  const outputRef = `TEST.output:${caseRef}`;
  const evidenceRef = `TEST.delivery:${caseRef}`;
  const deliveryClaimRef = `TEST.delivery-claim:${caseRef}`;
  const requestRef = `TEST.access-request:${caseRef}`;
  const deliveredAt = yield* Ref.make(receivedAt);
  const assertScope = (scope: {
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) =>
    scope.tenantId === fixture.tenantId &&
    scope.legalEntityId === fixture.legalEntityId &&
    scope.principalId === principal.principalId
      ? Effect.void
      : Effect.fail(authorityFailure());
  const matchesObligation = (value: {
    readonly caseRef: string;
    readonly controllerRef: string;
    readonly exactScopeRefs: readonly string[];
    readonly right: string;
  }) =>
    value.caseRef === caseRef &&
    value.controllerRef === testController &&
    value.right === 'ACCESS' &&
    request.controllerObligations.some(
      (obligation) =>
        value.exactScopeRefs.length === obligation.exactScopeRefs.length &&
        value.exactScopeRefs.every((scopeRef) => obligation.exactScopeRefs.includes(scopeRef)),
    );
  // TEST-only authoritative leaves: no production provider/owner execution is claimed.
  // The real registered Actions, collector, native factories, RLS and permission checks remain in use.
  const authorities = Layer.mergeAll(
    Layer.succeed(DsrIntakeReceiptAuthority, {
      resolve: Effect.fn('DsrMultiOwner.TEST.intake')(function* intake(value, scope) {
        yield* assertScope(scope);
        if (value.caseRef !== request.caseRef || value.intakeClaimRef !== request.intakeClaimRef) {
          return yield* Effect.fail(authorityFailure());
        }
        return yield* Schema.decodeUnknownEffect(DsrIntakeReceiptSchema)({
          caseRef,
          controllerReceipts: request.controllerObligations.map((obligation) => ({
            ...obligation,
            receiptBasisRef: `TEST.receipt:${obligation.obligationRef}`,
            receivedAt,
          })),
          intakeClaimRef: request.intakeClaimRef,
          originalReceivedAt: receivedAt,
          requestedRights: request.requestedRights,
        }).pipe(Effect.mapError(authorityFailure));
      }),
    }),
    Layer.succeed(DsrSubstantiveDecisionAuthority, {
      resolve: Effect.fn('DsrMultiOwner.TEST.decision')(function* decision(value, scope) {
        yield* assertScope(scope);
        if (!matchesObligation(value)) {
          return yield* Effect.fail(authorityFailure());
        }
        return yield* Schema.decodeUnknownEffect(DsrSubstantiveDecisionAuthorityResultSchema)({
          asOf: scope.asOf,
          decision: {
            ...value,
            authorityRef: 'TEST.decision-authority',
            decidedAt: scope.asOf,
            decisionEvidenceRefs: [`TEST.decision-evidence:${value.decisionRef}`],
            outcome: 'GRANTED',
            ownerExecutionRequired: true,
            policyRef: 'TEST.policy',
            policyVersion: 'TEST.v1',
            provenanceRef: `TEST.provenance:${value.decisionRef}`,
            reasonRef: 'TEST.grant',
          },
          legalEntityId: scope.legalEntityId,
          status: 'CURRENT',
          tenantId: scope.tenantId,
        }).pipe(Effect.mapError(authorityFailure));
      }),
    }),
    Layer.succeed(DsrOwnerTaskAuthority, {
      resolve: Effect.fn('DsrMultiOwner.TEST.task')(function* task(value, scope) {
        yield* assertScope(scope);
        if (!matchesObligation(value) || !requiredOwners.includes(value.ownerModuleId)) {
          return yield* Effect.fail(authorityFailure());
        }
        const taskStatus = yield* Ref.get(status);
        const receiptRef = taskStatus === 'SUCCEEDED' ? `TEST.receipt:${value.taskRef}` : null;
        return yield* Schema.decodeUnknownEffect(DsrOwnerTaskAuthorityResultSchema)({
          authorityRef: `TEST.authority:${value.ownerModuleId}`,
          evidenceRefs: [`TEST.evidence:${value.taskRef}`],
          legalEntityId: scope.legalEntityId,
          receiptRef,
          task: { ...value, outcomeRef: receiptRef, status: taskStatus },
          tenantId: scope.tenantId,
        }).pipe(Effect.mapError(authorityFailure));
      }),
    }),
    Layer.succeed(DsrOwnerInventoryAuthority, {
      resolve: Effect.fn('DsrMultiOwner.TEST.inventory')(function* inventory(value, scope) {
        yield* assertScope(scope);
        const mode = yield* Ref.get(inventoryMode);
        if (value !== caseRef || mode === 'unavailable') {
          return yield* Effect.fail(authorityFailure());
        }
        const entries = request.controllerObligations.flatMap((obligation) =>
          requiredOwners.map((ownerModuleId) => ({
            caseRef,
            controllerRef: testController,
            exactScopeRefs: obligation.exactScopeRefs,
            obligationRef: obligation.obligationRef,
            ownerModuleId,
            right: 'ACCESS',
          })),
        );
        return yield* Schema.decodeUnknownEffect(DsrOwnerInventoryAuthorityResultSchema)({
          authorityRef: 'TEST.inventory-authority',
          caseRef,
          complete: true,
          entries: mode === 'duplicate' ? [...entries, ...entries] : entries,
          evidenceRefs: ['TEST.inventory-evidence'],
          legalEntityId: scope.legalEntityId,
          observedAt: receivedAt,
          revision: 'TEST.inventory.v1',
          tenantId: mode === 'foreign' ? '00000000-0000-4000-8000-000000000099' : scope.tenantId,
        }).pipe(Effect.mapError(authorityFailure));
      }),
    }),
    Layer.succeed(DsrDeliveryAccessAuthority, {
      resolve: Effect.fn('DsrMultiOwner.TEST.access')(function* access(value, scope) {
        yield* assertScope(scope);
        if (value !== requestRef) {
          return yield* Effect.fail(authorityFailure());
        }
        const expiresAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(scope.asOf), { hours: 1 }));
        return yield* Schema.decodeUnknownEffect(DsrDeliveryAccessAuthorityResultSchema)({
          access: {
            accessId,
            caseRef,
            channel: 'TEST.secure-delivery',
            controllerRef: testController,
            deliveryOutputRef: outputRef,
            deliveryOutputRevision: 1,
            deliveryScopeRefs: [obligationRef],
            effectiveFrom: scope.asOf,
            expiresAt,
            idempotencyKey: `TEST.access-key:${caseRef}`,
            issuedAt: scope.asOf,
            policyRef: 'TEST.delivery-policy',
            recipientRef: subjectRef,
            representationRef: 'TEST.self',
            revocationReason: null,
            revokedAt: null,
            supersedesAccessRef: null,
          },
          actionInvocationId: scope.actionInvocationId,
          authorityRef: 'TEST.access-authority',
          caseRef,
          controllerRef: testController,
          evidenceRefs: ['TEST.access-evidence'],
          issuedAt: scope.asOf,
          legalEntityId: scope.legalEntityId,
          receiptRef: `TEST.access-receipt:${caseRef}`,
          tenantId: scope.tenantId,
        }).pipe(Effect.mapError(authorityFailure));
      }),
    }),
    Layer.succeed(DsrDeliveryAuthority, {
      resolve: Effect.fn('DsrMultiOwner.TEST.delivery')(function* delivery(value, scope) {
        yield* assertScope(scope);
        if (value.accessId !== accessId || value.deliveryClaimRef !== deliveryClaimRef) {
          return yield* Effect.fail(authorityFailure());
        }
        return {
          accessId,
          caseRef,
          channel: 'TEST.secure-delivery',
          deliveryOutputRef: outputRef,
          deliveryOutputRevision: 1,
          deliveryScopeRefs: [obligationRef],
          evidenceId: evidenceRef,
          occurredAt: yield* Ref.get(deliveredAt),
          outcome: 'SUCCESSFUL_DELIVERY' as const,
          policyRef: 'TEST.delivery-policy',
          providerReference: deliveryClaimRef,
          reason: 'TEST secure availability receipt for this exact recipient/output',
          recipientRef: subjectRef,
          representationRef: 'TEST.self',
        };
      }),
    }),
  );
  const context = yield* Layer.build(Layer.mergeAll(fixture.layer, authorities, NodeCrypto.layer));
  // Deferred native factories and HTTP requests use this exported context, not setup's ambient services.
  const exportedContextCrypto = Context.get(context, Crypto.Crypto);
  const exportedContextId = yield* exportedContextCrypto.randomUUIDv4();
  expect(Schema.is(Schema.String.check(Schema.isUUID()))(exportedContextId)).toBe(true);
  const permissions = yield* makeContextPermissionRelationshipMutationLive();
  const target = { moduleId: 'privacy.core', permission: 'privacy.dsr.read' };
  yield* permissions.mutate({
    legalEntityId: fixture.legalEntityId,
    operation: 'grant',
    principal,
    target,
    tenantId: fixture.tenantId,
  });
  yield* Effect.addFinalizer(() =>
    permissions
      .mutate({
        legalEntityId: fixture.legalEntityId,
        operation: 'revoke',
        principal,
        target,
        tenantId: fixture.tenantId,
      })
      .pipe(Effect.orDie),
  );
  const transport = Effect.fn('DsrMultiOwner.transport')(function* transport(idempotencyKey?: string) {
    return {
      correlationId: yield* nextId,
      idempotencyKey: idempotencyKey ?? (yield* nextId),
      targetModuleKey: 'privacy.core',
    };
  });
  const read = Effect.fn('DsrMultiOwner.publicWorkflowRead')(function* read() {
    const runtime = yield* ReadRuntime;
    return yield* runtime.runRead({
      input: { caseRefs: [caseRef] },
      principal,
      registration: dsrCasesRead,
      transport: { correlationId: yield* nextId },
    });
  });
  const create = Effect.fn('DsrMultiOwner.create')(function* create() {
    return yield* runAction({
      payload: { request },
      principal,
      registration: createDsrCaseAction,
      transport: yield* transport(),
    });
  });
  const decide = Effect.fn('DsrMultiOwner.decide')(function* decide(index = 0) {
    return yield* runAction({
      payload: {
        request: {
          caseRef,
          controllerRef: testController,
          decisionRef: index === 0 ? `TEST.decision:${caseRef}` : `TEST.decision:${caseRef}:second`,
          exactScopeRefs: request.controllerObligations[index].exactScopeRefs,
          right: 'ACCESS',
        },
      },
      principal,
      registration: recordDsrSubstantiveDecisionAction,
      transport: yield* transport(),
    });
  });
  const recordTask = Effect.fn('DsrMultiOwner.recordTask')(function* recordTask(
    ownerModuleId: string,
    suffix = ownerModuleId,
    index = 0,
  ) {
    return yield* runAction({
      payload: {
        request: {
          caseRef,
          controllerRef: testController,
          exactScopeRefs: request.controllerObligations[index].exactScopeRefs,
          idempotencyKey: `TEST.task-key:${caseRef}:${suffix}`,
          ownerModuleId,
          right: 'ACCESS',
          taskRef: `TEST.task:${caseRef}:${suffix}`,
        },
      },
      principal,
      registration: upsertDsrOwnerTaskAction,
      transport: yield* transport(),
    });
  });
  const respond = Effect.fn('DsrMultiOwner.respond')(function* respond(
    final: boolean,
    idempotencyKey: string,
    deliveryEvidenceRef: string | null = null,
  ) {
    return yield* runAction({
      payload: {
        response: {
          caseRef,
          decisionRefs: [`TEST.decision:${caseRef}`],
          deliveryEvidenceRef,
          final,
          responseRef: `TEST.response:${idempotencyKey}`,
          scopeRefs: [obligationRef],
        },
      },
      principal,
      registration: recordDsrResponseAction,
      transport: yield* transport(idempotencyKey),
    });
  });
  const deliver = Effect.fn('DsrMultiOwner.deliver')(function* deliver() {
    const issuedAccess = yield* runAction({
      payload: { requestRef },
      principal,
      registration: issueDsrDeliveryAccessAction,
      transport: yield* transport(),
    });
    // TEST secure availability begins at the actual retained access issuance, never before it.
    yield* Ref.set(deliveredAt, issuedAccess.issuedAt);
    return yield* runAction({
      payload: { accessId, deliveryClaimRef },
      principal,
      registration: recordDsrDeliveryEvidenceAction,
      transport: yield* transport(),
    });
  });
  const close = Effect.fn('DsrMultiOwner.close')(function* close(nextStatus: 'RESPONDED' | 'CLOSED') {
    return yield* runAction({
      payload: { expectedUpdatedAt: null, mutation: { caseRef, status: nextStatus } },
      principal,
      registration: updateDsrCaseAction,
      transport: yield* transport(),
    });
  });
  return {
    caseRef,
    close,
    context,
    coreEvidenceExecutor,
    create,
    decide,
    deliver,
    deliveredAt,
    evidenceRef,
    fixture,
    inventoryMode,
    isolated,
    makeRedemption,
    obligationRef,
    principal,
    read,
    recordTask,
    respond,
    snapshot,
    status,
    transport,
  };
});

const makeDsrHttp = Effect.fn('DsrMultiOwner.makeHttp')(function* makeDsrHttp(
  native: Effect.Success<ReturnType<typeof makeDsrNative>>,
) {
  const sourceContext = yield* Layer.build(NodeHttpServer.layerTest);
  const source = Context.get(sourceContext, HttpServer.HttpServer);
  const snapshotJson = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
    native.snapshot,
  );
  yield* source.serve(Effect.succeed(HttpServerResponse.text(snapshotJson, { contentType: 'application/json' })));
  const sourceAddress = source.address;
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(sourceAddress)) {
    return yield* Effect.fail(authorityFailure());
  }
  const pair = yield* Effect.tryPromise({ catch: authorityFailure, try: async () => await generateKeyPair('EdDSA') });
  const publicKey = yield* Effect.tryPromise({
    catch: authorityFailure,
    try: async () => await exportJWK(pair.publicKey),
  });
  const kid = 'TEST.dsr-key';
  const issuer = 'https://TEST.dsr-issuer.example';
  const configuration = Layer.succeed(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown({
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${sourceAddress.port}/active`,
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicKey, alg: 'EdDSA', kid, use: 'sig' }] }),
    }),
  );
  const redemption = yield* native.makeRedemption();
  const runtime = makePrivacyApiRuntime(
    Layer.succeed(ReadRuntime, Context.get(native.context, ReadRuntime)),
    Layer.succeedContext(native.context),
    redemption,
  );
  const handler = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createHttpApiHandler({ api: runtime.api, layer: runtime.layer.pipe(Layer.provide(configuration)) }),
    ),
    (value) => Effect.promise(async () => await value.dispose()),
  );
  const serverContext = yield* Layer.build(NodeHttpServer.layerTest);
  const server = Context.get(serverContext, HttpServer.HttpServer);
  yield* server.serve(
    Effect.gen(function* serveRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        catch: authorityFailure,
        try: async () => await handler.handler(webRequest),
      });
      return HttpServerResponse.fromWeb(response);
    }),
  );
  const { address } = server;
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
    return yield* Effect.fail(authorityFailure());
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const authorize = Effect.fn('DsrMultiOwner.freshGatewayAssertion')(function* authorize() {
    const jti = yield* nextId;
    const token = yield* Effect.tryPromise({
      catch: authorityFailure,
      try: async () =>
        await new SignJWT({
          compositionRevision: native.snapshot.composition.revision,
          principal: native.principal,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience('privacy')
          .setSubject(native.principal.principalId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .setJti(jti)
          .sign(pair.privateKey),
    });
    return `Bearer ${token}`;
  });
  const read = Effect.fn('DsrMultiOwner.mountedWorkflow')(function* read() {
    return yield* executeDsrCasesWithAuthorization({ caseRefs: [native.caseRef] }, yield* authorize(), yield* nextId, {
      baseUrl,
      compositionRevision: native.snapshot.composition.revision,
    }).pipe(Effect.provide(FetchHttpClient.layer));
  });
  const respond = Effect.fn('DsrMultiOwner.mountedResponse')(function* respond(idempotencyKey: string) {
    return yield* executeRecordDsrResponseWithAuthorization(
      {
        response: {
          caseRef: native.caseRef,
          decisionRefs: [`TEST.decision:${native.caseRef}`],
          deliveryEvidenceRef: Option.none(),
          final: false,
          responseRef: `TEST.http-response:${idempotencyKey}`,
          scopeRefs: [native.obligationRef],
        },
      },
      yield* authorize(),
      yield* nextId,
      { baseUrl, compositionRevision: native.snapshot.composition.revision, idempotencyKey },
    ).pipe(Effect.provide(FetchHttpClient.layer));
  });
  return { read, respond };
});

it('rejects mismatched TEST endpoint metadata, elevated native identities and surplus privileges without I/O', () => {
  const database = 'ontos_test_party_gateway_TESTcreated';
  const admin = {
    hash: '',
    hostname: '127.0.0.1',
    pathname: `/${database}`,
    port: '5432',
    protocol: 'postgresql:',
    queryKeys: [],
    username: 'postgres',
  };
  const runtime = { ...admin, username: 'ontos_runtime' };
  expect(dsrTestStorageGuards.endpoints(admin, runtime, database)).toBe(true);
  for (const invalid of [
    { ...runtime, hostname: 'foreign.example' },
    { ...runtime, hostname: 'localhost' },
    { ...runtime, port: '5433' },
    { ...runtime, pathname: '/source' },
    { ...runtime, protocol: 'https:' },
    { ...runtime, username: admin.username },
    { ...runtime, username: 'not a role' },
    { ...runtime, queryKeys: ['host'] },
    { ...runtime, queryKeys: ['options'] },
    { ...runtime, hash: '#redirect' },
  ]) {
    expect(dsrTestStorageGuards.endpoints(admin, invalid, database)).toBe(false);
  }
  expect(
    dsrTestStorageGuards.endpoints(
      { ...admin, hostname: 'foreign.example' },
      { ...runtime, hostname: 'foreign.example' },
      database,
    ),
  ).toBe(false);
  expect(dsrTestStorageGuards.endpoints(admin, runtime, 'source')).toBe(false);
  const adminFacts = { bypass: true, database, effectiveRole: 'postgres', sessionRole: 'postgres', superuser: true };
  const runtimeFacts = {
    bypass: false,
    database,
    effectiveRole: 'ontos_runtime',
    sessionRole: 'ontos_runtime',
    superuser: false,
  };
  expect(dsrTestStorageGuards.roles(adminFacts, runtimeFacts, database, 'postgres', 'ontos_runtime')).toBe(true);
  for (const invalid of [
    { ...runtimeFacts, superuser: true },
    { ...runtimeFacts, bypass: true },
    { ...runtimeFacts, database: 'source' },
    { ...runtimeFacts, effectiveRole: 'postgres' },
    { ...runtimeFacts, sessionRole: 'postgres' },
  ]) {
    expect(dsrTestStorageGuards.roles(adminFacts, invalid, database, 'postgres', 'ontos_runtime')).toBe(false);
  }
  expect(
    dsrTestStorageGuards.roles(
      { ...adminFacts, database: 'foreign' },
      runtimeFacts,
      database,
      'postgres',
      'ontos_runtime',
    ),
  ).toBe(false);
  const allowed = {
    delete: false,
    insert: true,
    references: false,
    select: true,
    trigger: false,
    truncate: false,
    update: false,
  };
  expect(dsrTestStorageGuards.privileges(allowed)).toBe(true);
  for (const privilege of ['delete', 'references', 'trigger', 'truncate', 'update'] as const) {
    expect(dsrTestStorageGuards.privileges({ ...allowed, [privilege]: true })).toBe(false);
  }
  expect(dsrTestStorageGuards.privileges({ ...allowed, insert: false })).toBe(false);
  expect(dsrTestStorageGuards.privileges({ ...allowed, select: false })).toBe(false);
});

it.live(
  'persists both required owners of one obligation and gates final response, delivery, closure and replay',
  () =>
    Effect.gen(function* completeMultiOwner() {
      const native = yield* makeDsrNative([testOwnerA, testOwnerB], DateTime.formatIso(yield* DateTime.now));
      yield* Effect.gen(function* registeredWorkflow() {
        yield* native.create();
        yield* native.decide();
        const taskA = yield* native.recordTask(testOwnerA);
        const responseKey = yield* nextId;
        const missingB = yield* native.respond(false, responseKey).pipe(Effect.flip);
        expect(missingB).toMatchObject({ code: 'privacy_operation_conflict' });
        expect((yield* native.read()).items[0].responses).toEqual([]);
        const taskB = yield* native.recordTask(testOwnerB);
        expect(taskA.taskRef).not.toBe(taskB.taskRef);
        expect(taskA.idempotencyKey).not.toBe(taskB.idempotencyKey);
        expect(taskA.outcomeRef).not.toEqual(taskB.outcomeRef);
        const interim = yield* native.respond(false, responseKey);
        expect(interim.final).toBe(false);
        const workflow = yield* native.read();
        expect(workflow.items[0].tasks).toHaveLength(2);
        expect(workflow.items[0].decisions).toHaveLength(1);
        expect(workflow.items[0].responses).toEqual([interim]);
        expect(new Set(workflow.items[0].tasks.map(({ ownerModuleId }) => ownerModuleId))).toEqual(
          new Set([testOwnerA, testOwnerB]),
        );
        const noDelivery = yield* native.respond(true, yield* nextId).pipe(Effect.flip);
        expect(noDelivery).toMatchObject({ code: 'privacy_operation_conflict' });
        const prematureClose = yield* native.close('CLOSED').pipe(Effect.flip);
        expect(prematureClose).toMatchObject({ code: 'privacy_operation_conflict' });
        yield* native.deliver();
        const finalKey = yield* nextId;
        const final = yield* native.respond(true, finalKey, native.evidenceRef);
        const retained = yield* native.read();
        expect(retained.items[0].responses).toEqual([interim, final]);
        const beforeReplay = yield* native.fixture.evidence(native.coreEvidenceExecutor);
        const replay = yield* native.respond(true, finalKey, native.evidenceRef).pipe(Effect.flip);
        expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
        const afterReplay = yield* native.fixture.evidence(native.coreEvidenceExecutor);
        expect(afterReplay.invocations).toEqual(beforeReplay.invocations);
        expect(afterReplay.audits).toEqual(beforeReplay.audits);
        expect(afterReplay.events).toEqual(beforeReplay.events);
        expect(afterReplay.outbox).toEqual(beforeReplay.outbox);
        expect((yield* native.read()).items[0].responses).toEqual(retained.items[0].responses);
        yield* native.close('RESPONDED');
        yield* native.close('CLOSED');
        expect((yield* native.read()).items[0].caseRecord.status).toBe('CLOSED');
        expect((yield* native.read()).items[0].tasks).toEqual(retained.items[0].tasks);
      }).pipe(Effect.provideContext(native.context));
    }).pipe(Effect.provide(nativeServices)),
  120_000,
);

it.live(
  'retains incomplete interim work and rejects conflicting or foreign multi-owner evidence',
  () =>
    Effect.gen(function* incompleteMultiOwner() {
      const native = yield* makeDsrNative([testOwnerA, testOwnerB], DateTime.formatIso(yield* DateTime.now));
      yield* Effect.gen(function* registeredNegatives() {
        yield* native.create();
        yield* native.decide();
        yield* native.recordTask(testOwnerA);
        yield* Ref.set(native.status, 'PENDING');
        yield* native.recordTask(testOwnerB);
        const interim = yield* native.respond(false, yield* nextId);
        expect(interim.final).toBe(false);
        yield* native.deliver();
        const incomplete = yield* native.respond(true, yield* nextId, native.evidenceRef).pipe(Effect.flip);
        expect(incomplete).toMatchObject({ code: 'privacy_operation_conflict' });
        expect((yield* native.read()).items[0].responses).toEqual([interim]);
        for (const mode of ['duplicate', 'foreign', 'unavailable'] as const) {
          yield* Ref.set(native.inventoryMode, mode);
          const refused = yield* native.respond(false, yield* nextId).pipe(Effect.flip);
          expect(refused).toMatchObject({
            code: mode === 'unavailable' ? 'privacy_operation_persistence_unavailable' : 'privacy_action_rejected',
          });
          expect((yield* native.read()).items[0].responses).toEqual([interim]);
        }
        yield* Ref.set(native.inventoryMode, 'valid');
        yield* Ref.set(native.status, 'SUCCEEDED');
        yield* native.recordTask(testOwnerB);
        yield* native.recordTask(testOwnerB, 'competing-task');
        const competing = yield* native.respond(false, yield* nextId).pipe(Effect.flip);
        expect(competing).toMatchObject({ code: 'privacy_operation_conflict' });
        const denied = yield* runAction({
          payload: {
            response: {
              caseRef: native.caseRef,
              decisionRefs: [`TEST.decision:${native.caseRef}`],
              deliveryEvidenceRef: null,
              final: false,
              responseRef: 'TEST.denied',
              scopeRefs: [native.obligationRef],
            },
          },
          principal: { ...native.fixture.legalEntityOnly, legalEntityId: native.fixture.legalEntityId },
          registration: recordDsrResponseAction,
          transport: yield* native.transport(),
        }).pipe(Effect.flip);
        expect(denied).toMatchObject({ code: 'action_permission_denied' });
        expect((yield* native.read()).items[0].responses).toEqual([interim]);
      }).pipe(Effect.provideContext(native.context));
    }).pipe(Effect.provide(nativeServices)),
  120_000,
);

it.live(
  'accepts multi-owner response over actual generated HTTP receiving and returns retained workflow',
  () =>
    Effect.gen(function* publicMultiOwner() {
      const native = yield* makeDsrNative([testOwnerA, testOwnerB], DateTime.formatIso(yield* DateTime.now));
      yield* Effect.gen(function* publicWorkflow() {
        yield* native.create();
        yield* native.decide();
        yield* native.recordTask(testOwnerA);
        yield* native.recordTask(testOwnerB);
        const http = yield* makeDsrHttp(native);
        const response = yield* http.respond(yield* nextId);
        const retained = yield* http.read();
        expect(retained.items[0].responses).toEqual([response]);
        expect(retained.items[0].tasks).toHaveLength(2);
        expect(retained.items[0].decisions).toHaveLength(1);
      }).pipe(Effect.provideContext(native.context));
    }).pipe(Effect.provide(nativeServices)),
  120_000,
);

it.live(
  'keeps single-owner responses and scoped responses among distinct obligations under the same Controller',
  () =>
    Effect.gen(function* separateObligations() {
      const native = yield* makeDsrNative([testOwnerA], DateTime.formatIso(yield* DateTime.now), 2);
      yield* Effect.gen(function* scopedResponse() {
        yield* native.create();
        yield* native.decide();
        yield* native.recordTask(testOwnerA);
        const firstResponse = yield* native.respond(false, yield* nextId);
        expect(firstResponse.scopeRefs).toEqual([native.obligationRef]);
        expect((yield* native.read()).items[0].caseRecord.controllerObligations).toHaveLength(2);
        expect((yield* native.read()).items[0].responses).toEqual([firstResponse]);
        yield* native.decide(1);
        yield* native.recordTask(testOwnerA, 'second-obligation', 1);
        const nextResponse = yield* native.respond(false, yield* nextId);
        const retained = yield* native.read();
        expect(retained.items[0].tasks).toHaveLength(2);
        expect(retained.items[0].decisions).toHaveLength(2);
        expect(retained.items[0].responses).toEqual([firstResponse, nextResponse]);
      }).pipe(Effect.provideContext(native.context));
    }).pipe(Effect.provide(nativeServices)),
  120_000,
);

it.live(
  'TEST native redemption serializes duplicates, preserves replay across restart and retains typed store failure',
  () =>
    Effect.gen(function* nativeRedemption() {
      const { makeRedemption } = yield* makeDsrIsolation();
      const jti = yield* nextId;
      const expiresAtEpochSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000) + 300;
      const input = { audience: 'privacy', expiresAtEpochSeconds, issuer: 'TEST.issuer', jti };
      const closedService = yield* Effect.scoped(
        Effect.gen(function* firstStorageScope() {
          const layer = yield* makeRedemption();
          const service = Context.get(yield* Layer.build(layer), GatewayAssertionRedemptionService);
          const raced = yield* Effect.all(
            [Effect.result(service.consume(input)), Effect.result(service.consume(input))],
            { concurrency: 2 },
          );
          expect(raced.filter(Result.isSuccess)).toHaveLength(1);
          expect(
            raced.filter(Result.isFailure).every(({ failure }) => Schema.is(GatewayAssertionReplayError)(failure)),
          ).toBe(true);
          yield* service.consume({ ...input, audience: 'TEST.other-audience' });
          yield* service.consume({ ...input, issuer: 'TEST.other-issuer' });
          const expiredJti = yield* nextId;
          const expired = yield* service
            .consume({ ...input, expiresAtEpochSeconds: 0, jti: expiredJti })
            .pipe(Effect.flip);
          expect(Schema.is(GatewayAssertionReplayError)(expired)).toBe(true);
          yield* service.consume({ ...input, jti: expiredJti });
          return service;
        }),
      );
      const unavailable = yield* closedService.consume({ ...input, jti: yield* nextId }).pipe(Effect.flip);
      expect(Schema.is(GatewayAssertionRedemptionUnavailableError)(unavailable)).toBe(true);
      const reopened = Context.get(yield* Layer.build(yield* makeRedemption()), GatewayAssertionRedemptionService);
      const replay = yield* reopened.consume(input).pipe(Effect.flip);
      expect(Schema.is(GatewayAssertionReplayError)(replay)).toBe(true);
    }).pipe(Effect.provide(nativeServices)),
  120_000,
);
