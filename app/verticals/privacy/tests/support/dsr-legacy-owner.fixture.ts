// Explicit TEST entry, compiled independently into genuine old/current owner trees.
import {
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  TrustedPrincipalContextSchema,
  makeActionRuntimeLive,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { NodeCrypto, NodeHttpServer, NodeRuntime, NodeServices, NodeSocket } from '@effect/platform-node';
import { Clock, Config, Console, Effect, FileSystem, Layer, Option, Redacted, Result, Schema, Stream } from 'effect';
import type { HttpClient } from 'effect/http';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Socket } from 'effect/socket';
import { Pool } from 'pg';
import { makePrivacyApiRuntime } from '../../api/index.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import {
  DsrCaseRequestSchema,
  DsrIntakeReceiptSchema,
  DsrDeadlinePolicySchema,
} from '../../shared/domain/privacy-dsr.ts';
import { RecordDsrDeadlinePayloadSchema } from '../../shared/actions/record-dsr-deadline.ts';
import { DsrIntakeReceiptAuthority } from '../../src/actions/create-dsr-case.action.ts';
import { DsrDeadlineAuthority, recordDsrDeadlineAction } from '../../src/actions/record-dsr-deadline.action.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';
import { executeCreateDsrCaseWithAuthorization } from '../../src/api/create-dsr-case-action-client.ts';
import { executeRecordDsrDeadlineWithAuthorization } from '../../src/api/record-dsr-deadline-action-client.ts';
import { executeDsrCasesWithAuthorization } from '../../src/api/dsr-cases-client.ts';

class DsrLegacyOwnerFailure extends Schema.TaggedError<DsrLegacyOwnerFailure>()('DsrLegacyOwnerFailure', {
  reason: Schema.String,
}) {}
const failure = () => new DsrLegacyOwnerFailure({ reason: 'The closed TEST legacy owner boundary failed' });
const authorityFailure = () =>
  new PrivacyOperationPersistenceError({
    code: 'privacy_operation_persistence_unavailable',
    reason: 'Exact TEST legacy receipt authority is unavailable',
  });
const fixtureSchema = Schema.Struct({
  policy: DsrDeadlinePolicySchema,
  principal: TrustedPrincipalContextSchema,
  receipt: DsrIntakeReceiptSchema,
  request: DsrCaseRequestSchema,
});
const commandSchema = Schema.Union([
  Schema.Struct({
    correlation: Schema.String,
    credential: Schema.String,
    idempotencyKey: Schema.String.pipe(Schema.brand('DsrLegacyIdempotencyKey')),
    operation: Schema.Literals(['create', 'deadline', 'read']),
    payload: Schema.Unknown,
  }),
  Schema.Struct({ operation: Schema.Literal('stop') }),
]);
const safeHttpFailure = Schema.Struct({ status: Schema.Number });
const wireReplySchema = Schema.Struct({
  deadlineSchemaVersion: Schema.optionalKey(Schema.String),
  deliveryUnit: Schema.optionalKey(Schema.Unknown),
  marker: Schema.optionalKey(Schema.Unknown),
  outcome: Schema.optionalKey(Schema.Literals(['success', 'refused'])),
  status: Schema.optionalKey(Schema.Number),
  type: Schema.String,
  value: Schema.optionalKey(Schema.Unknown),
});
const description = () => ({
  deadlineSchemaVersion: recordDsrDeadlineAction.descriptor.schemaVersion,
  deliveryUnit: ultramodernDeliveryUnit,
  marker: ultramodernApiMarker,
});

const ownsRuntimeAddress = (address: URL, database: string, runtimeUser: string) =>
  ['postgres:', 'postgresql:'].includes(address.protocol) &&
  ['localhost', '127.0.0.1'].includes(address.hostname) &&
  address.search === '' &&
  address.hash === '' &&
  address.pathname === `/${database}` &&
  database.startsWith('ontos_test_party_gateway_') &&
  decodeURIComponent(address.username) === runtimeUser;
const serve = Effect.scoped(
  Effect.gen(function* legacyOwner() {
    const socketPath = yield* Config.String('ONTOS_1271_SOCKET');
    const filesystem = yield* FileSystem.FileSystem;
    const slash = socketPath.lastIndexOf('/');
    const directory = socketPath.slice(0, slash);
    const directoryInfo = yield* filesystem.stat(directory);
    if (
      !socketPath.startsWith('/') ||
      !socketPath.endsWith('/dsr.sock') ||
      new TextEncoder().encode(socketPath).length > 96 ||
      directoryInfo.type !== 'Directory' ||
      directoryInfo.mode % 0o1000 !== 0o700 ||
      (yield* filesystem.realPath(directory)) !== directory ||
      (yield* filesystem.stat(socketPath)).type !== 'Socket'
    ) {
      return yield* failure();
    }
    const socket = yield* NodeSocket.makeNet({ openTimeout: '2 seconds', path: socketPath });
    const pull = yield* Socket.readerBytes(socket);
    const writer = yield* socket.writer;
    const reply = (value: typeof wireReplySchema.Type) =>
      Schema.encodeEffect(Schema.fromJsonString(wireReplySchema))(value).pipe(
        Effect.flatMap((line) => writer.write(`${line}\n`)),
      );
    const unexpectedAdmin = yield* Config.Redacted('DATABASE_ADMIN_URL').pipe(Config.option);
    const settings = yield* Config.all({
      database: Config.String('ONTOS_1271_DATABASE'),
      fixture: Config.String('ONTOS_1271_FIXTURE'),
      revision: Config.String('ONTOS_1271_REVISION'),
      runtime: Config.Redacted('DATABASE_URL'),
      runtimeUser: Config.String('ONTOS_1271_RUNTIME_USER'),
    });
    const address = new URL(Redacted.value(settings.runtime));
    if (Option.isSome(unexpectedAdmin) || !ownsRuntimeAddress(address, settings.database, settings.runtimeUser)) {
      return yield* failure();
    }
    const fixture = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(fixtureSchema))(settings.fixture).pipe(
      Effect.mapError(failure),
    );
    if (
      fixture.receipt.caseRef !== fixture.request.caseRef ||
      fixture.receipt.intakeClaimRef !== fixture.request.intakeClaimRef ||
      fixture.receipt.controllerReceipts.length !== 2 ||
      fixture.request.controllerObligations.length !== 2
    ) {
      return yield* failure();
    }
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: Redacted.value(settings.runtime), max: 2 })),
      (pool) => Effect.promise(async () => await pool.end()),
    );
    const valid = yield* Effect.tryPromise({
      catch: failure,
      try: async () => {
        const result =
          await runtime.query(`select current_database() as database,current_user as role,session_user as session,
      rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user`);
        const [row] = result.rows;
        if (
          row?.database !== settings.database ||
          row.role !== settings.runtimeUser ||
          row.session !== settings.runtimeUser ||
          row.rolsuper !== false ||
          row.rolbypassrls !== false ||
          row.rolcreatedb !== false ||
          row.rolcreaterole !== false
        ) {
          return false;
        }
        const permissions = await runtime.query(
          'select operation,has_table_privilege(current_user,$1,operation) as allowed from unnest($2::text[]) as operation',
          [
            'privacy_dsr_legacy_test.redemptions',
            ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
          ],
        );
        if (
          permissions.rows.some(
            (permission) => permission.allowed !== ['SELECT', 'INSERT'].includes(permission.operation),
          )
        ) {
          return false;
        }
        const schema = await runtime.query(
          `select has_schema_privilege(current_user,'privacy_dsr_legacy_test','CREATE') as allowed`,
        );
        return schema.rows[0]?.allowed === false;
      },
    });
    if (!valid) {
      return yield* failure();
    }
    const clock = yield* Clock.Clock;
    const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
      consume: Effect.fn('DsrLegacyOwner.TEST.redeem')(function* redeem(input) {
        if (
          input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <=
          Math.floor((yield* clock.currentTimeMillis) / 1000)
        ) {
          return yield* new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
        }
        const result = yield* Effect.tryPromise({
          catch: () =>
            new GatewayAssertionRedemptionUnavailableError({ reason: 'The owned TEST replay store is unavailable' }),
          try: async () =>
            await runtime.query(
              'insert into privacy_dsr_legacy_test.redemptions(issuer,audience,jti) values($1,$2,$3) on conflict do nothing returning jti',
              [input.issuer, input.audience, input.jti],
            ),
        });
        if (result.rowCount !== 1) {
          return yield* new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
        }
        return yield* Effect.void;
      }),
    });
    const authorities = Layer.mergeAll(
      Layer.succeed(DsrIntakeReceiptAuthority, {
        resolve: Effect.fn('DsrLegacyOwner.TEST.intake')(function* intake(request, scope) {
          if (
            scope.tenantId !== fixture.principal.tenantId ||
            scope.legalEntityId !== fixture.principal.legalEntityId ||
            scope.principalId !== fixture.principal.principalId ||
            JSON.stringify(request) !== JSON.stringify(fixture.request)
          ) {
            return yield* authorityFailure();
          }
          return fixture.receipt;
        }),
      }),
      Layer.succeed(DsrDeadlineAuthority, {
        resolve: Effect.fn('DsrLegacyOwner.TEST.deadline')(function* deadline(evidence) {
          const receipt = fixture.receipt.controllerReceipts.find(
            (item) => item.obligationRef === evidence.obligationRef,
          );
          if (
            receipt === undefined ||
            evidence.caseRef !== fixture.request.caseRef ||
            evidence.controllerRef !== receipt.controllerRef ||
            evidence.receiptBasisRef !== receipt.receiptBasisRef ||
            evidence.receivedAt !== receipt.receivedAt
          ) {
            return yield* authorityFailure();
          }
          return { ...evidence, policy: fixture.policy };
        }),
      }),
    );
    const source = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer));
    const state = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
    const gate = ModuleStateGateLive.pipe(Layer.provide(state));
    const entrypoint = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
    const scope = OperationalScopeResolverLive.pipe(
      Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
    );
    const infrastructure = Layer.mergeAll(
      CorePersistenceLive,
      ContextAccessLive,
      gate,
      entrypoint,
      scope,
      ActionRepositoryLive,
      ActionPermissionLive,
      ActionAuthorizationPreflightDatabaseLive.pipe(Layer.provideMerge(CorePersistenceLive)),
      ActiveApplicationCompositionConfigLive.pipe(Layer.provide(source)),
    );
    const action = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
      Layer.provideMerge(authorities),
      Layer.provide(infrastructure),
      Layer.provide(Layer.mergeAll(DatabaseConfigLive, NodeCrypto.layer)),
    );
    const read = ReadRuntimeLive.pipe(
      Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive, entrypoint, scope)),
      Layer.provide(Layer.mergeAll(DatabaseConfigLive, NodeCrypto.layer)),
    );
    const api = makePrivacyApiRuntime(read, action, redemption);
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => api.createHandler()),
      (value) => Effect.promise(async () => await value.dispose()),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* receiveRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const web = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({ catch: failure, try: async () => await handler.handler(web) });
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const { address: serverAddress } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(serverAddress)) {
      return yield* failure();
    }
    const baseUrl = `http://127.0.0.1:${serverAddress.port}`;
    yield* reply({ type: 'ready', ...description() });
    let pendingBytes = 0;
    yield* Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect((bytes) =>
        Effect.suspend(() => {
          for (const byte of bytes) {
            pendingBytes = byte === 10 ? 0 : pendingBytes + 1;
            if (pendingBytes > 1024 * 1024) {
              return Effect.fail(failure());
            }
          }
          return Effect.succeed(bytes);
        }),
      ),
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(commandSchema))(line, { onExcessProperty: 'error' }),
      ),
      Stream.takeUntil((command) => command.operation === 'stop'),
      Stream.runForEach((command) =>
        Effect.gen(function* executeCommand() {
          if (command.operation === 'stop') {
            return yield* reply({ type: 'STOPPED' });
          }
          const options = { baseUrl, compositionRevision: settings.revision, idempotencyKey: command.idempotencyKey };
          let request: Effect.Effect<unknown, unknown, HttpClient.HttpClient>;
          if (command.operation === 'create') {
            request = executeCreateDsrCaseWithAuthorization(
              { request: fixture.request },
              command.credential,
              command.correlation,
              options,
            );
          } else if (command.operation === 'deadline') {
            request = Schema.decodeUnknownEffect(RecordDsrDeadlinePayloadSchema)(command.payload, {
              onExcessProperty: 'error',
            }).pipe(
              Effect.flatMap((payload) =>
                executeRecordDsrDeadlineWithAuthorization(payload, command.credential, command.correlation, options),
              ),
            );
          } else {
            request = executeDsrCasesWithAuthorization(
              { caseRefs: [fixture.request.caseRef] },
              command.credential,
              command.correlation,
              options,
            );
          }
          const result = yield* request.pipe(Effect.provide(FetchHttpClient.layer), Effect.result);
          if (Result.isSuccess(result)) {
            return yield* reply({ outcome: 'success', type: 'result', value: result.success });
          }
          const status = Schema.decodeUnknownOption(safeHttpFailure)(result.failure);
          if (Option.isNone(status)) {
            return yield* failure();
          }
          return yield* reply({ outcome: 'refused', status: status.value.status, type: 'result' });
        }),
      ),
    );
    return yield* Effect.void;
  }),
);

const main = process.argv.includes('--describe')
  ? Schema.encodeEffect(Schema.fromJsonString(wireReplySchema))({ type: 'description', ...description() }).pipe(
      Effect.flatMap(Console.log),
    )
  : serve;
NodeRuntime.runMain(
  main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NodeHttpServer.layerTest))),
);
