import {
  ActiveApplicationCompositionService,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  makeActionRuntimeLive,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { resolveEffectBffModuleHandler } from '@modern-js/bff-effect/effect';
import { HttpApi, dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import {
  ConfigProvider,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';

import { applicationCompositionMarketReferenceOwnerDeploymentStateAuthorityLive } from '../../api/application-composition-market-reference-owner-authority.ts';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
  gatewayAssertionRedemptionPgClient,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { marketAffectedUseAssessmentReadApiLive } from '../../api/market-affected-use-assessment-read-server.ts';
import { marketRetirementReservationRecoveryReadApiLive } from '../../api/market-retirement-reservation-recovery-read-server.ts';
import { reserveMarketRetirementActionApiLive } from '../../api/reserve-market-retirement-action-server.ts';
import { commerceCustomerContextApi, commerceCustomerContextApiContract } from '../../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';

export interface MarketRetirementNativeReceiverOptions {
  readonly compositionRevision: string;
  readonly compositionSourceUrl: string;
  readonly issuer: string;
  readonly publicJwks: string;
  readonly runtimeConnectionString: Redacted.Redacted;
}

export interface MarketRetirementNativeMigrationOptions {
  readonly adminConnectionString: Redacted.Redacted;
  readonly runtimeConnectionString: Redacted.Redacted;
}

export class MarketRetirementNativeReceiverError extends Schema.TaggedError<MarketRetirementNativeReceiverError>()(
  'MarketRetirementNativeReceiverError',
  {
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
    stage: Schema.Literals(['configuration', 'migration', 'activation', 'closed', 'request']),
  },
) {}

const unavailable = (stage: MarketRetirementNativeReceiverError['stage'], cause?: unknown) =>
  new MarketRetirementNativeReceiverError({ cause: Redacted.make(cause), stage });
const receiverConfiguration = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  compositionSourceUrl: Schema.URLFromString,
  issuer: Schema.URLFromString,
  publicJwks: Schema.String.check(Schema.isMinLength(1)),
});
const isOwnedDatabase = (database: string) =>
  database.startsWith('ontos_test_party_gateway_') || database.startsWith('ontos_1094_');

/**
 * CCC-owned native test infrastructure, not a business endpoint or Current-response fixture.
 * The three existing production groups retain their generated handlers, default owner factories,
 * real Core composition locks/scope/permissions and durable gateway redemption. Business rows
 * are never manufactured here: an empty exact Market predicate is read from the actual owner DB.
 */
export const makeMarketRetirementNativeReceiver = Effect.fn('MarketRetirementNativeReceiver.make')(
  function* makeMarketRetirementNativeReceiver() {
    const closed = yield* Ref.make(false);
    const ownedScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Ref.set(closed, true).pipe(Effect.andThen(Scope.close(ownedScope, exit))));
    const server = Context.get(
      yield* Layer.build(NodeHttpServer.layerTest).pipe(Scope.provide(ownedScope)),
      HttpServer.HttpServer,
    );
    if (!Schema.is(Schema.Struct({ port: Schema.Int }))(server.address)) {
      return yield* unavailable('configuration');
    }
    const activated = yield* Ref.make(false);
    const migrated = yield* Ref.make(Option.none<Effect.Success<ReturnType<typeof parseDatabaseConfig>>>());
    const installed = yield* Ref.make(Option.none<Awaited<ReturnType<typeof resolveEffectBffModuleHandler>>>());
    const ensureOpen = Ref.get(closed).pipe(
      Effect.flatMap((value) => (value ? Effect.fail(unavailable('closed')) : Effect.void)),
    );
    yield* server
      .serve(
        Effect.gen(function* receiveMarketRetirementRequest() {
          const handler = yield* Ref.get(installed);
          if (Option.isNone(handler) || handler.value === null) {
            return HttpServerResponse.empty({ status: 503 });
          }
          const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
          const response = yield* Effect.tryPromise({
            catch: (cause) => unavailable('request', cause),
            try: dispatchEffectBffRequest.bind(undefined, handler.value.handler, request, {
              prefix: commerceCustomerContextApiContract.apiPrefix,
            }),
          });
          return HttpServerResponse.fromWeb(response);
        }),
      )
      .pipe(Scope.provide(ownedScope));

    return Object.freeze({
      activate: Effect.fn('MarketRetirementNativeReceiver.activate')(function* activate(
        options: MarketRetirementNativeReceiverOptions,
      ) {
        yield* ensureOpen;
        if (yield* Ref.getAndSet(activated, true)) {
          return yield* unavailable('activation');
        }
        const configuration = yield* Schema.decodeEffect(receiverConfiguration)({
          compositionRevision: options.compositionRevision,
          compositionSourceUrl: options.compositionSourceUrl,
          issuer: options.issuer,
          publicJwks: options.publicJwks,
        }).pipe(Effect.mapError((cause) => unavailable('configuration', cause)));
        const runtime = yield* parseDatabaseConfig({
          DATABASE_URL: Redacted.value(options.runtimeConnectionString),
        }).pipe(Effect.mapError((cause) => unavailable('configuration', cause)));
        const previous = yield* Ref.get(migrated);
        if (
          !isOwnedDatabase(runtime.database) ||
          (Option.isSome(previous) &&
            (previous.value.database !== runtime.database ||
              previous.value.host !== runtime.host ||
              previous.value.port !== runtime.port ||
              previous.value.user !== runtime.user))
        ) {
          return yield* unavailable('configuration');
        }
        const inherited = yield* ConfigProvider.ConfigProvider;
        const provider = ConfigProvider.orElse(
          ConfigProvider.fromEnvRecord({
            ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: configuration.compositionSourceUrl.href,
            ONTOS_GATEWAY_ISSUER: options.issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: configuration.publicJwks,
          }),
          inherited,
        );
        const database = Layer.succeed(DatabaseConfig, runtime);
        const persistence = CorePersistenceLive.pipe(Layer.provide(database));
        const states = TenantModuleStateServiceLive.pipe(Layer.provide(persistence));
        const gate = ModuleStateGateLive.pipe(Layer.provide(states));
        const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(gate));
        const resolver = OperationalScopeResolverLive.pipe(
          Layer.provide(Layer.mergeAll(persistence, ContextAccessLive)),
        );
        const namespace = staffAuthenticationNamespaceRegistryLayer(['commerce-customer-context']);
        const compositionHttp = FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
        );
        const source = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(compositionHttp));
        const composition = ActiveApplicationCompositionConfigLive.pipe(Layer.provideMerge(source));
        const owners = applicationCompositionMarketReferenceOwnerDeploymentStateAuthorityLive.pipe(
          Layer.provide(composition),
        );
        const reader = profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(ContextAccessLive));
        const overlay = commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(Layer.provide(reader));
        const common = Layer.mergeAll(
          persistence,
          ContextAccessLive,
          gate,
          gateway,
          resolver,
          namespace,
          composition,
          overlay,
        );
        const actions = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
          Layer.provide(Layer.mergeAll(common, ActionRepositoryLive, ActionPermissionLive)),
        );
        const reads = ReadRuntimeLive.pipe(Layer.provide(common));
        const redemptionDatabase = GatewayAssertionRedemptionDatabaseLive.pipe(
          Layer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
          Layer.provide(Reactivity.layer),
          Layer.provide(database),
        );
        const redemption = GatewayAssertionRedemptionLive.pipe(Layer.provide(redemptionDatabase));
        const verifier = ActionPrincipalVerifierLive.pipe(Layer.provide(composition));
        const services = Layer.mergeAll(
          actions,
          reads,
          namespace,
          owners,
          redemption,
          verifier,
          RequestSchemaProblemLive,
          common,
        );
        const api = HttpApi.make('CommerceCustomerContextApi')
          .add(commerceCustomerContextApi.groups.marketAffectedUseAssessment)
          .add(commerceCustomerContextApi.groups.reserveMarketRetirementAction)
          .add(commerceCustomerContextApi.groups.marketRetirementReservationRecovery)
          .annotateMerge(commerceCustomerContextApi.annotations);
        const handlers = Layer.mergeAll(
          marketAffectedUseAssessmentReadApiLive,
          reserveMarketRetirementActionApiLive,
          marketRetirementReservationRecoveryReadApiLive,
        ).pipe(
          Layer.provide(services),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(NodeServices.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ConfigProvider.layer(provider)),
          Layer.orDie,
        );
        const live = assembleEffectBffRuntime({ api, handlers, transport: Layer.empty });
        const current = yield* Layer.build(composition).pipe(
          Effect.provide(ConfigProvider.layer(provider)),
          Scope.provide(ownedScope),
          Effect.mapError((cause) => unavailable('activation', cause)),
        );
        const snapshot = yield* Context.get(current, ActiveApplicationCompositionService).load.pipe(
          Effect.mapError((cause) => unavailable('activation', cause)),
        );
        if (
          snapshot.composition.revision !== configuration.compositionRevision ||
          !snapshot.composition.modules.some(
            (module) =>
              module.moduleId === 'commerce.customer-context' &&
              module.deployment.appId === ultramodernApiMarker.appId &&
              module.deployment.buildMarker === ultramodernApiMarker.buildMarker,
          )
        ) {
          return yield* unavailable('activation');
        }
        const handler = yield* Effect.acquireRelease(
          Effect.promise(resolveEffectBffModuleHandler.bind(undefined, { default: live }, {})).pipe(
            Effect.flatMap((value) =>
              value === null ? Effect.fail(unavailable('activation')) : Effect.succeed(value),
            ),
          ),
          (value) => (value.dispose === undefined ? Effect.void : Effect.promise(value.dispose).pipe(Effect.orDie)),
        ).pipe(Scope.provide(ownedScope));
        return yield* Ref.set(installed, Option.some(handler));
      }),
      baseUrl: `http://127.0.0.1:${server.address.port}/`,
      close: Ref.set(closed, true).pipe(Effect.andThen(Scope.close(ownedScope, Exit.void))),
      deployment: Object.freeze({ appId: ultramodernApiMarker.appId, buildMarker: ultramodernApiMarker.buildMarker }),
      migrate: Effect.fn('MarketRetirementNativeReceiver.migrate')(function* migrate(
        options: MarketRetirementNativeMigrationOptions,
      ) {
        yield* ensureOpen;
        if (yield* Ref.get(activated)) {
          return yield* unavailable('migration');
        }
        const pair = yield* parseDatabaseConnectionPair({
          DATABASE_ADMIN_URL: Redacted.value(options.adminConnectionString),
          DATABASE_URL: Redacted.value(options.runtimeConnectionString),
        }).pipe(Effect.mapError((cause) => unavailable('configuration', cause)));
        if (
          !isOwnedDatabase(pair.runtime.database) ||
          pair.admin.database !== pair.runtime.database ||
          pair.admin.host !== pair.runtime.host ||
          pair.admin.port !== pair.runtime.port
        ) {
          return yield* unavailable('configuration');
        }
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* fs
          .makeTempDirectoryScoped({ prefix: 'ontos-market-retirement-ccc-' })
          .pipe(Effect.mapError((cause) => unavailable('migration', cause)));
        const config = path.join(temporary, 'drizzle.config.mjs');
        yield* fs
          .writeFileString(
            config,
            `export default { dialect: 'postgresql', out: process.env.ONTOS_CCC_RETIREMENT_MIGRATIONS, schema: process.env.ONTOS_CCC_RETIREMENT_SCHEMA, dbCredentials: { url: process.env.DATABASE_ADMIN_URL }, migrations: { schema: 'drizzle', table: '__drizzle_migrations_commerce_customer_context' } };`,
          )
          .pipe(Effect.mapError((cause) => unavailable('migration', cause)));
        const child = yield* ChildProcess.make(
          'mise',
          [
            'exec',
            '--',
            'pnpm',
            '--filter',
            '@app/commerce-customer-context',
            'exec',
            'drizzle-kit',
            'migrate',
            '--config',
            config,
          ],
          {
            cwd: new URL('../../../../', import.meta.url).pathname,
            env: {
              APP_ENV_PATH: '/dev/null',
              DATABASE_ADMIN_URL: pair.admin.connectionString,
              ONTOS_CCC_RETIREMENT_MIGRATIONS: new URL('../../drizzle/', import.meta.url).pathname,
              ONTOS_CCC_RETIREMENT_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
            },
            extendEnv: true,
            stderr: 'pipe',
            stdin: 'ignore',
            stdout: 'pipe',
          },
        ).pipe(Effect.mapError((cause) => unavailable('migration', cause)));
        const [status] = yield* Effect.all(
          [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
          { concurrency: 3 },
        ).pipe(Effect.mapError((cause) => unavailable('migration', cause)));
        if (Number(status) !== 0) {
          return yield* unavailable('migration');
        }
        return yield* Ref.set(migrated, Option.some(pair.runtime));
      }),
    });
  },
);
