import {
  ActiveApplicationCompositionSnapshotSchema,
  ContextAccess,
  CorePersistenceLive,
  DatabaseConfig,
  InstalledModuleCatalogService,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  buildInstalledModuleCatalog,
  changeTenantModuleStateAction,
  makeContextAccessLive,
  parseDatabaseConfig,
  runAction,
  ReadRuntime,
  TrustedPrincipalContextSchema,
  canonicalizeApplicationComposition,
  makeContextPermissionRelationshipMutationLive,
  OntosModuleDeploymentContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import {
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { createHash } from 'node:crypto';
import {
  Array as EffectArray,
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Redacted,
  Ref,
  Schema,
} from 'effect';
import { expect, it } from 'effect-rstest';
import { createHttpApiHandler } from '@modern-js/bff-effect/effect-edge';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { makePrivacyApiRuntime } from '../../api/index.ts';
import { makeDsrObligationNative } from '../support/dsr-obligation-native.ts';
import { executeDsrCasesWithAuthorization } from '../../src/api/dsr-cases-client.ts';
import { executeCreateDsrCaseWithAuthorization } from '../../src/api/create-dsr-case-action-client.ts';
import { executeRecordDsrDeadlineWithAuthorization } from '../../src/api/record-dsr-deadline-action-client.ts';
import {
  DsrCaseRequestSchema,
  DsrIntakeReceiptSchema,
  DsrDeadlinePolicySchema,
} from '../../shared/domain/privacy-dsr.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createDsrCaseAction, DsrIntakeReceiptAuthority } from '../../src/actions/create-dsr-case.action.ts';
import { recordDsrDeadlineAction, DsrDeadlineAuthority } from '../../src/actions/record-dsr-deadline.action.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const makeDsrIsolation = Effect.fn('DsrExactDeadline.makeIsolation')(function* makeDsrIsolation() {
  const base = yield* makeApplicationCompositionSnapshotFixture(
    [ultramodernApiMarker.appId],
    ultramodernApiMarker.buildMarker,
  );
  const modules = yield* Effect.forEach(
    base.composition.modules,
    Effect.fn('DsrExactDeadline.module')(function* module(entry) {
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
  const owned = yield* makeDsrObligationNative(snapshot, 'stabilization-1271-exact-obligation-deadline');
  return { ...owned, snapshot };
});

const testController = 'TEST.controller';
const authorityFailure = () =>
  new PrivacyOperationPersistenceError({
    code: 'privacy_operation_persistence_unavailable',
    reason: 'Exact TEST DSR deadline precondition was not satisfied',
  });

const makeDsrNative = Effect.fn('DsrExactDeadline.makeNative')(function* makeDsrNative(
  reverse: boolean,
  distinctTimes: boolean,
  count: 1 | 2 = 2,
  owned?: Effect.Success<ReturnType<typeof makeDsrIsolation>>,
) {
  const { isolated, makeRedemption, snapshot } = owned ?? (yield* makeDsrIsolation());
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [
        createDsrCaseAction.descriptor.actionKey,
        recordDsrDeadlineAction.descriptor.actionKey,
        changeTenantModuleStateAction.descriptor.actionKey,
      ],
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['privacy'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      managerIdentityAdmin: true,
      moduleAccess: 'configured-modules',
      moduleKeys: ['privacy.core'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (value) => value.close().pipe(Effect.orDie),
  );
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    ...fixture.manager,
    legalEntityId: fixture.legalEntityId,
  });
  const caseRef = `dsr:${yield* nextId}`;
  const receivedAt = DateTime.formatIso(yield* DateTime.now);
  const secondReceivedAt = distinctTimes
    ? DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(receivedAt), { hours: 1 }))
    : receivedAt;
  // These are explicit TEST intake claims, not production legal-policy decisions.
  const receipts = Array.from({ length: count }, (_, index) => ({
    controllerRef: testController,
    exactScopeRefs: [`TEST.scope:${caseRef}:${index}`],
    obligationRef: `TEST.obligation:${caseRef}:${index}`,
    receiptBasisRef: `TEST.receipt:${caseRef}:${index}`,
    receivedAt: index === 0 ? receivedAt : secondReceivedAt,
    requestedRights: ['ACCESS'],
  }));
  const ordered = reverse ? EffectArray.reverse(receipts) : receipts;
  const request = yield* Schema.decodeUnknownEffect(DsrCaseRequestSchema)({
    caseRef,
    controllerObligations: ordered.map(({ receiptBasisRef: _basis, receivedAt: _time, ...obligation }) => obligation),
    intakeClaimRef: `TEST.intake:${caseRef}`,
    requestedRights: ['ACCESS'],
    requester: { kind: 'RESOLVED', subjectRef: `TEST.subject:${caseRef}` },
    subjectRefs: [],
    unresolvedParts: [],
  });
  const mode = yield* Ref.make<
    'valid' | 'wrong-case' | 'wrong-controller' | 'wrong-obligation' | 'wrong-basis' | 'wrong-time' | 'unavailable'
  >('valid');
  const policy = yield* Schema.decodeUnknownEffect(DsrDeadlinePolicySchema)({
    calendar: 'UTC_CALENDAR_MONTH',
    months: 1,
    policyRef: 'TEST.deadline-policy',
    policyVersion: 'TEST.v1',
  });
  const deadlineAuthorityCalls = yield* Ref.make(0);
  const authorities = Layer.mergeAll(
    Layer.succeed(DsrIntakeReceiptAuthority, {
      resolve: Effect.fn('DsrExactDeadline.TEST.intake')(function* intake(value, scope) {
        if (
          scope.tenantId !== fixture.tenantId ||
          scope.legalEntityId !== fixture.legalEntityId ||
          scope.principalId !== principal.principalId ||
          value.caseRef !== caseRef ||
          value.intakeClaimRef !== request.intakeClaimRef
        ) {
          return yield* Effect.fail(authorityFailure());
        }
        return yield* Schema.decodeUnknownEffect(DsrIntakeReceiptSchema)({
          caseRef,
          controllerReceipts: ordered,
          intakeClaimRef: request.intakeClaimRef,
          originalReceivedAt: distinctTimes && count === 2 ? secondReceivedAt : receivedAt,
          requestedRights: request.requestedRights,
        }).pipe(Effect.mapError(authorityFailure));
      }),
    }),
    Layer.succeed(DsrDeadlineAuthority, {
      resolve: Effect.fn('DsrExactDeadline.TEST.deadline')(function* deadline(value) {
        yield* Ref.update(deadlineAuthorityCalls, (calls) => calls + 1);
        const expected = receipts.find((receipt) => receipt.obligationRef === value.obligationRef);
        if (
          expected === undefined ||
          value.caseRef !== caseRef ||
          value.controllerRef !== expected.controllerRef ||
          value.receiptBasisRef !== expected.receiptBasisRef ||
          value.receivedAt !== expected.receivedAt
        ) {
          return yield* Effect.fail(authorityFailure());
        }
        const current = yield* Ref.get(mode);
        if (current === 'unavailable') {
          return yield* Effect.fail(authorityFailure());
        }
        return {
          ...value,
          caseRef: current === 'wrong-case' ? 'TEST.foreign' : value.caseRef,
          controllerRef: current === 'wrong-controller' ? 'TEST.foreign' : value.controllerRef,
          obligationRef: current === 'wrong-obligation' ? 'TEST.foreign' : value.obligationRef,
          policy,
          receiptBasisRef: current === 'wrong-basis' ? 'TEST.foreign' : value.receiptBasisRef,
          receivedAt:
            current === 'wrong-time'
              ? DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(value.receivedAt), { days: 1 }))
              : value.receivedAt,
        };
      }),
    }),
  );
  const contracts = yield* Effect.all(
    snapshot.composition.modules.map((entry) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(entry.contractDocument),
    ),
  );
  const catalog = yield* Effect.try({
    catch: authorityFailure,
    try: () =>
      buildInstalledModuleCatalog(
        contracts.map((contract) => ({ contract, expectedAppId: contract.deployment.appId })),
      ),
  });
  // The catalog is the same validated TEST composition contract, not an allow-all lifecycle service.
  const context = yield* Layer.build(
    Layer.mergeAll(
      fixture.layer,
      NodeCrypto.layer,
      authorities,
      Layer.succeed(InstalledModuleCatalogService, {
        loadForRevision: (_compositionRevision) => Effect.succeed(catalog),
      }),
    ),
  );
  // HTTP runs later under this exported context, independently of setup's ambient services.
  const exportedContextCrypto = Context.get(context, Crypto.Crypto);
  const exportedContextId = yield* exportedContextCrypto.randomUUIDv4();
  expect(Schema.is(Schema.String.check(Schema.isUUID()))(exportedContextId)).toBe(true);
  const permissions = yield* makeContextPermissionRelationshipMutationLive();
  const target = { moduleId: 'privacy.core', permission: 'privacy.dsr.read' };
  const permissionInput = { legalEntityId: fixture.legalEntityId, principal, target, tenantId: fixture.tenantId };
  yield* permissions.mutate({ ...permissionInput, operation: 'grant' });
  yield* Effect.addFinalizer(() => permissions.mutate({ ...permissionInput, operation: 'revoke' }).pipe(Effect.orDie));
  const changeReadPermission = (operation: 'grant' | 'revoke') => permissions.mutate({ ...permissionInput, operation });
  const changeModuleState = Effect.fn('DsrExactDeadline.registeredModuleLifecycle')(function* changeModuleState(
    expectedState: 'active' | 'inactive',
    newState: 'active' | 'inactive',
  ) {
    return yield* runAction({
      payload: {
        expectedState,
        moduleKey: 'privacy.core',
        newState,
        reason: 'TEST exact-obligation module-state boundary',
      },
      principal: fixture.manager,
      registration: changeTenantModuleStateAction,
      transport: { correlationId: yield* nextId, idempotencyKey: yield* nextId, targetModuleKey: 'core.modules' },
    }).pipe(Effect.provideContext(context));
  });
  return {
    caseRef,
    changeModuleState,
    changeReadPermission,
    context,
    deadlineAuthorityCalls,
    fixture,
    isolated,
    makeRedemption,
    mode,
    policy,
    principal,
    receipts,
    request,
    snapshot,
  };
});

const makeDsrHttp = Effect.fn('DsrExactDeadline.makeHttp')(function* makeDsrHttp(
  native: Effect.Success<ReturnType<typeof makeDsrNative>>,
  readFault: 'none' | 'context-transport' | 'permission-transport' = 'none',
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
  const readPermissionTransportCalls = yield* Ref.make(0);
  let readRuntime: Parameters<typeof makePrivacyApiRuntime>[0] = Layer.succeed(
    ReadRuntime,
    Context.get(native.context, ReadRuntime),
  );
  if (readFault !== 'none') {
    // TEST transport fault: this bound plaintext loopback server cannot complete the actual
    // TLS SpiceDB protocol. No permission outcome is fabricated and shared SpiceDB remains intact.
    const failedTransport = yield* makeContextAccessLive(undefined, () =>
      Effect.succeed({
        endpoint: `localhost:${sourceAddress.port}`,
        preSharedKey: 'TEST.unavailable-transport',
      }),
    );
    const liveAccess = yield* makeContextAccessLive();
    const failedPermission = failedTransport.contextPermissions;
    if (failedPermission === undefined) {
      return yield* Effect.fail(authorityFailure());
    }
    const contextAccess =
      readFault === 'context-transport'
        ? failedTransport
        : {
            ...liveAccess,
            contextPermissions: Effect.fn('DsrExactDeadline.TEST.readPermissionTransport')(function* permission(input) {
              yield* Ref.update(readPermissionTransportCalls, (calls) => calls + 1);
              return yield* failedPermission(input);
            }),
          };
    const accessLayer = Layer.succeed(ContextAccess, contextAccess);
    const persistence = CorePersistenceLive.pipe(
      Layer.provide(
        Layer.effect(
          DatabaseConfig,
          parseDatabaseConfig({ DATABASE_URL: native.isolated.connections.runtime.connectionString }),
        ),
      ),
    );
    const state = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
    const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(ModuleStateGateLive.pipe(Layer.provide(state))));
    const resolver = OperationalScopeResolverLive.pipe(Layer.provide(Layer.merge(persistence, accessLayer)));
    readRuntime = ReadRuntimeLive.pipe(
      Layer.provide(Layer.mergeAll(persistence, accessLayer, gateway, resolver)),
      Layer.provide(NodeCrypto.layer),
    );
  }
  const runtime = makePrivacyApiRuntime(readRuntime, Layer.succeedContext(native.context), redemption);
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
  const authorize = Effect.fn('DsrExactDeadline.freshGatewayAssertion')(function* authorize(
    principal = native.principal,
  ) {
    const jti = yield* nextId;
    const token = yield* Effect.tryPromise({
      catch: authorityFailure,
      try: async () =>
        await new SignJWT({
          compositionRevision: native.snapshot.composition.revision,
          principal,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience('privacy')
          .setSubject(principal.principalId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .setJti(jti)
          .sign(pair.privateKey),
    });
    return `Bearer ${token}`;
  });
  const read = Effect.fn('DsrExactDeadline.mountedWorkflow')(function* read() {
    return yield* executeDsrCasesWithAuthorization({ caseRefs: [native.caseRef] }, yield* authorize(), yield* nextId, {
      baseUrl,
      compositionRevision: native.snapshot.composition.revision,
    }).pipe(Effect.provide(FetchHttpClient.layer));
  });
  const options = (idempotencyKey: string) => ({
    baseUrl,
    compositionRevision: native.snapshot.composition.revision,
    idempotencyKey,
  });
  const create = Effect.fn('DsrExactDeadline.mountedCreate')(function* create() {
    return yield* executeCreateDsrCaseWithAuthorization(
      { request: native.request },
      yield* authorize(),
      yield* nextId,
      options(yield* nextId),
    ).pipe(Effect.provide(FetchHttpClient.layer));
  });
  const deadline = Effect.fn('DsrExactDeadline.mountedDeadline')(function* deadline(
    obligationRef: string,
    idempotencyKey: string,
    controllerRef = testController,
  ) {
    return yield* executeRecordDsrDeadlineWithAuthorization(
      { caseRef: native.caseRef, controllerRef, obligationRef },
      yield* authorize(),
      yield* nextId,
      options(idempotencyKey),
    ).pipe(Effect.provide(FetchHttpClient.layer));
  });
  const deniedDeadline = Effect.fn('DsrExactDeadline.mountedDeniedDeadline')(function* deniedDeadline(
    principal: typeof native.principal,
    invalidCredential: boolean,
  ) {
    return yield* executeRecordDsrDeadlineWithAuthorization(
      { caseRef: native.caseRef, controllerRef: testController, obligationRef: native.receipts[0].obligationRef },
      invalidCredential ? 'Bearer TEST.invalid' : yield* authorize(principal),
      yield* nextId,
      options(yield* nextId),
    ).pipe(Effect.provide(FetchHttpClient.layer));
  });
  return { create, deadline, deniedDeadline, read, readPermissionTransportCalls };
});

for (const reverse of [false, true]) {
  for (const distinctTimes of [false, true]) {
    it.live(
      `records exact same-Controller obligations and restarted history (reverse=${reverse}, distinctTimes=${distinctTimes})`,
      () =>
        Effect.gen(function* exactObligations() {
          const native = yield* makeDsrNative(reverse, distinctTimes);
          const http = yield* makeDsrHttp(native);
          yield* http.create();
          const before = yield* http.read();
          expect(before.items[0].caseRecord.controllerObligations.map(({ obligationRef }) => obligationRef)).toEqual(
            native.request.controllerObligations.map(({ obligationRef }) => obligationRef),
          );
          for (const receipt of native.receipts) {
            const result = yield* http.deadline(receipt.obligationRef, yield* nextId);
            expect(result).toMatchObject({
              caseRef: native.caseRef,
              controllerRef: testController,
              obligationRef: receipt.obligationRef,
              policyRef: native.policy.policyRef,
              policyVersion: native.policy.policyVersion,
              receiptBasisRef: receipt.receiptBasisRef,
              receivedAt: receipt.receivedAt,
              version: 2,
            });
          }
          const retained = yield* http.read();
          expect(retained.items[0].deadlines).toHaveLength(2);
          expect(
            new Set(
              retained.items[0].deadlines.map((deadline) =>
                deadline.identityStatus === 'EXACT' ? deadline.obligationRef : 'unresolved',
              ),
            ),
          ).toEqual(new Set(native.receipts.map(({ obligationRef }) => obligationRef)));
          const restarted = yield* makeDsrHttp(native);
          expect((yield* restarted.read()).items[0].deadlines).toEqual(retained.items[0].deadlines);
        }).pipe(Effect.provide(nativeServices)),
      120_000,
    );
  }
}

it.live(
  'preserves single-obligation replay and append-only history while rejecting foreign selectors and mismatched authorities',
  () =>
    Effect.gen(function* exactNegativeControls() {
      const native = yield* makeDsrNative(false, false, 1);
      const http = yield* makeDsrHttp(native);
      yield* http.create();
      const [receipt] = native.receipts;
      const deniedPrincipal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        ...native.fixture.denied,
        legalEntityId: native.fixture.legalEntityId,
      });
      const missingLegalEntity = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
        native.fixture.manager,
      );
      for (const denied of [deniedPrincipal, missingLegalEntity]) {
        const failure = yield* http.deniedDeadline(denied, false).pipe(Effect.flip);
        expect(failure).toMatchObject({ status: 403 });
        expect((yield* http.read()).items[0].deadlines).toEqual([]);
      }
      const invalid = yield* http.deniedDeadline(native.principal, true).pipe(Effect.flip);
      expect(invalid).toMatchObject({ status: 401 });

      const key = yield* nextId;
      yield* http.deadline(receipt.obligationRef, key);
      const retained = (yield* http.read()).items[0].deadlines;
      const replay = yield* http.deadline(receipt.obligationRef, key).pipe(Effect.flip);
      expect(replay).toMatchObject({ status: 409 });
      const changed = yield* http.deadline('TEST.foreign', key).pipe(Effect.flip);
      expect(changed).toMatchObject({ status: 409 });
      for (const selector of [
        { controllerRef: testController, obligationRef: 'TEST.foreign' },
        { controllerRef: 'TEST.foreign', obligationRef: receipt.obligationRef },
      ]) {
        const failure = yield* http
          .deadline(selector.obligationRef, yield* nextId, selector.controllerRef)
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ status: 422 });
        expect((yield* http.read()).items[0].deadlines).toEqual(retained);
      }
      for (const mode of [
        'wrong-case',
        'wrong-controller',
        'wrong-obligation',
        'wrong-basis',
        'wrong-time',
        'unavailable',
      ] as const) {
        yield* Ref.set(native.mode, mode);
        const failure = yield* http.deadline(receipt.obligationRef, yield* nextId).pipe(Effect.flip);
        expect(failure).toMatchObject({ status: mode === 'unavailable' ? 503 : 422 });
        expect((yield* http.read()).items[0].deadlines).toEqual(retained);
      }
      yield* Ref.set(native.mode, 'valid');
      yield* http.deadline(receipt.obligationRef, yield* nextId);
      expect((yield* http.read()).items[0].deadlines).toHaveLength(2);
      // Native guard controls bypass only the handler for a failing attempt, never create success rows.
      for (const mismatch of [
        { receiptBasisRef: 'TEST.foreign' },
        { obligationRef: 'TEST.foreign' },
        { controllerRef: 'TEST.foreign' },
        { receivedAt: DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(receipt.receivedAt), { days: 1 })) },
      ]) {
        const failure = yield* native.fixture
          .prepareOwner(
            Effect.fn('DsrExactDeadline.nativeReceiptGuard')(function* guard(transaction, scope) {
              const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
              return yield* repository.recordDsrDeadline(scope.tenantId, native.fixture.legalEntityId, yield* nextId, {
                calendar: native.policy.calendar,
                caseRef: native.caseRef,
                controllerRef: testController,
                deadlineAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(receipt.receivedAt), { months: 1 })),
                months: native.policy.months,
                obligationRef: receipt.obligationRef,
                policyRef: native.policy.policyRef,
                policyVersion: native.policy.policyVersion,
                receiptBasisRef: receipt.receiptBasisRef,
                receivedAt: receipt.receivedAt,
                version: 2,
                ...mismatch,
              });
            }),
            'required',
          )
          .pipe(Effect.provideContext(native.context), Effect.flip);
        expect(failure).toMatchObject({ code: 'privacy_operation_conflict' });
      }
      expect((yield* http.read()).items[0].deadlines).toHaveLength(2);
    }).pipe(Effect.provide(nativeServices)),
  120_000,
);

it.live('isolates a real foreign Tenant and foreign Legal Entity without leaking deadline authority facts', () =>
  Effect.gen(function* foreignScopeControls() {
    const native = yield* makeDsrNative(false, false, 1);
    const foreign = yield* makeDsrNative(false, false, 1, native);
    const http = yield* makeDsrHttp(native);
    const foreignHttp = yield* makeDsrHttp(foreign);
    yield* http.create();
    yield* foreignHttp.create();
    yield* http.deadline(native.receipts[0].obligationRef, yield* nextId);
    yield* foreignHttp.deadline(foreign.receipts[0].obligationRef, yield* nextId);
    const retained = (yield* http.read()).items[0].deadlines;
    const foreignRetained = (yield* foreignHttp.read()).items[0].deadlines;
    const calls = yield* Ref.get(native.deadlineAuthorityCalls);
    // This Principal has a genuine independent Tenant, LE, binding and positive native write.
    const foreignTenant = yield* http.deniedDeadline(foreign.principal, false).pipe(Effect.flip);
    expect(foreignTenant).toMatchObject({ status: 422 });
    const foreignLegalEntity = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      ...native.principal,
      legalEntityId: foreign.fixture.legalEntityId,
    });
    const wrongLegalEntity = yield* http.deniedDeadline(foreignLegalEntity, false).pipe(Effect.flip);
    expect(wrongLegalEntity).toMatchObject({ status: 403 });
    const missingTenant = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      ...native.principal,
      tenantId: yield* nextId,
    });
    const absentContext = yield* http.deniedDeadline(missingTenant, false).pipe(Effect.flip);
    expect(absentContext).toMatchObject({ status: 403 });
    expect(yield* Ref.get(native.deadlineAuthorityCalls)).toBe(calls);
    expect((yield* http.read()).items[0].deadlines).toEqual(retained);
    expect((yield* foreignHttp.read()).items[0].deadlines).toEqual(foreignRetained);
  }).pipe(Effect.provide(nativeServices)),
);

it.live(
  'uses the registered Core lifecycle Action to block inactive Privacy writes and preserve committed history',
  () =>
    Effect.gen(function* inactiveModuleControl() {
      const native = yield* makeDsrNative(false, false, 1);
      const http = yield* makeDsrHttp(native);
      yield* http.create();
      yield* http.deadline(native.receipts[0].obligationRef, yield* nextId);
      const retained = (yield* http.read()).items[0].deadlines;
      const calls = yield* Ref.get(native.deadlineAuthorityCalls);
      const state = yield* native.changeModuleState('active', 'inactive');
      expect(state).toMatchObject({ newState: 'inactive', previousState: 'active' });
      const failure = yield* http.deadline(native.receipts[0].obligationRef, yield* nextId).pipe(Effect.flip);
      expect(failure).toMatchObject({ status: 403 });
      expect(yield* Ref.get(native.deadlineAuthorityCalls)).toBe(calls);
      const deniedRead = yield* http.read().pipe(Effect.flip);
      expect(deniedRead).toMatchObject({ status: 403 });
      yield* native.changeModuleState('inactive', 'active');
      expect((yield* http.read()).items[0].deadlines).toEqual(retained);
      yield* http.deadline(native.receipts[0].obligationRef, yield* nextId);
      expect((yield* http.read()).items[0].deadlines).toHaveLength(2);
    }).pipe(Effect.provide(nativeServices)),
);

for (const fault of ['context-transport', 'permission-transport'] as const) {
  it.live(`fails closed on actual ${fault} unavailability without presenting an empty workflow`, () =>
    Effect.gen(function* indeterminateReadControl() {
      const native = yield* makeDsrNative(false, false, 1);
      const http = yield* makeDsrHttp(native);
      yield* http.create();
      yield* http.deadline(native.receipts[0].obligationRef, yield* nextId);
      const retained = (yield* http.read()).items[0].deadlines;
      const calls = yield* Ref.get(native.deadlineAuthorityCalls);
      const failed = yield* makeDsrHttp(native, fault);
      const failure = yield* failed.read().pipe(Effect.flip);
      expect(failure).toMatchObject({ status: 503 });
      expect(yield* Ref.get(failed.readPermissionTransportCalls)).toBe(fault === 'permission-transport' ? 1 : 0);
      expect(yield* Ref.get(native.deadlineAuthorityCalls)).toBe(calls);
      expect((yield* http.read()).items[0].deadlines).toEqual(retained);
    }).pipe(Effect.provide(nativeServices)),
  );
}

it.live('rejects definite executor and workflow permission denials after a truthful positive context', () =>
  Effect.gen(function* definitePermissionControls() {
    const native = yield* makeDsrNative(false, false, 1);
    const http = yield* makeDsrHttp(native);
    yield* http.create();
    yield* http.deadline(native.receipts[0].obligationRef, yield* nextId);
    const retained = (yield* http.read()).items[0].deadlines;
    const calls = yield* Ref.get(native.deadlineAuthorityCalls);
    // Core fixture's legalEntityOnly actor has valid Tenant/LE/module access but no manager-only executor grant.
    const executorDenied = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
      native.fixture.legalEntityOnly,
    );
    const execution = yield* http.deniedDeadline(executorDenied, false).pipe(Effect.flip);
    expect(execution).toMatchObject({ code: 'action_permission_denied', status: 403 });
    yield* native.changeReadPermission('revoke');
    const readDenial = yield* http.read().pipe(Effect.flip);
    yield* native.changeReadPermission('grant');
    expect(readDenial).toMatchObject({ status: 403 });
    expect(yield* Ref.get(native.deadlineAuthorityCalls)).toBe(calls);
    expect((yield* http.read()).items[0].deadlines).toEqual(retained);
  }).pipe(Effect.provide(nativeServices)),
);
