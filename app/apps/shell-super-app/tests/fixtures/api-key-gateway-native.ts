import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
import {
  PrincipalIdSchema,
  TenantIdSchema,
  ProviderSubjectIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import {
  ActionRuntime,
  ActiveApplicationCompositionSnapshotSchema,
  bindSelfApiKeyAction,
  parseDatabaseConnectionPair,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import {
  GatewayContextRequestSchema,
  GatewayContextResponseSchema,
  GatewayAuthenticationRequiredProblemSchema,
  GatewayAudienceInvalidProblemSchema,
  GatewayReloadRequiredProblemSchema,
  GatewayForbiddenProblemSchema,
  GatewayRateLimitedProblemSchema,
  GatewayUnavailableProblemSchema,
  GatewayInternalProblemSchema,
} from '@app/shared-contracts';
import { NodeHttpServer, NodeSocketServer } from '@effect/platform-node';
import {
  Context,
  Config,
  Clock,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Path,
  Queue,
  Deferred,
  Redacted,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { Socket } from 'effect/socket';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { exportJWK, generateKeyPair } from 'jose';

import { OwnedAuthRuntimeContract, OwnedAuthRuntimeContractLive } from '../support/api-key-gateway-auth-runtime.ts';
import type { ShellNativeOwnedDatabase } from '../support/api-key-gateway-auth-runtime.ts';
import { GatewayModuleBindingSchema } from '../../api/auth/gateway-delegation-policy.ts';
import { GatewayIssuerError } from '../../api/auth/gateway-issuer.ts';
import { ShellGatewayReleaseDiagnosticSchema } from '../../api/auth/gateway-release-diagnostic.ts';
import { SwitchLegalEntityPayloadSchema } from '../../shared/api.ts';
import { SymmyRegionsProjectionConfigurationSchema } from '../../api/symmy/regions-projection.ts';
import { SymmyPriceReadProjectionConfigurationSchema } from '../../api/symmy/source-read-projections.ts';

export { SymmyPriceReadProjectionConfigurationSchema } from '../../api/symmy/source-read-projections.ts';

export class ApiKeyGatewayNativeFixtureError extends Schema.TaggedError<ApiKeyGatewayNativeFixtureError>()(
  'ApiKeyGatewayNativeFixtureError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) =>
  new ApiKeyGatewayNativeFixtureError({
    cause: Redacted.make(cause),
    reason: 'The scoped Shell gateway test fixture is unavailable',
  });
const appRoot = new URL('../../../../', import.meta.url).pathname;
const sourceIssueTag = 'relay-source-issue';
const sourceBoundTag = 'relay-source-bound';
const sessionGatewayTag = 'session-gateway';
const gatewayDiagnosticsTag = 'gateway-diagnostics';
const issuerDiagnosticsTag = 'issuer-diagnostics';
const requestDiagnosticsTag = 'request-diagnostics';
const releaseDiagnosticsTag = 'release-diagnostics';
const marketAppId = 'commerce-market-catalog';
const customerContextAppId = 'commerce-customer-context';
export interface ApiKeyGatewayNativeFixtureOptions {
  readonly additionalRelaySources?: readonly Pick<
    typeof ShellNativeAdditionalRelaySourceSchema.Type,
    'registeredWorkloads' | 'sourceAppId'
  >[];
  readonly ownedDatabase: ShellNativeOwnedDatabase;
  readonly priceReadProjectionJson?: string;
  /** Exercise the actual Core/SpiceDB gate and both production Shell prefixes. */
  readonly productionGate?: true;
  readonly regionsProjectionJson?: string;
  readonly relaySource?: Pick<typeof ShellNativeRelaySourceSchema.Type, 'registeredWorkloads' | 'sourceAppId'>;
  readonly snapshotJson: string;
}
export const ShellNativeRelaySourceSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  registeredWorkloads: GatewayModuleBindingSchema.fields.registeredWorkloads,
  sourceAppId: Schema.Literals([customerContextAppId, marketAppId, 'symmy-integration']),
  sourceBuildMarker: Schema.String.check(Schema.isMinLength(1)),
});
export const ShellNativeModuleAppIdSchema = Schema.Literals([
  'party-registry',
  customerContextAppId,
  'privacy',
  'symmy-integration',
  'pricing',
  'price-group-catalog',
  'catalog',
  marketAppId,
]);
export const ShellNativeAdditionalRelaySourceSchema = Schema.Struct({
  ...ShellNativeRelaySourceSchema.fields,
  sourceAppId: ShellNativeModuleAppIdSchema,
});
const additionalProviderUserSchema = Schema.Struct({
  providerUserId: ProviderSubjectIdSchema,
  sourceAppId: ShellNativeModuleAppIdSchema,
});
export const ShellNativeChildReadySchema = Schema.Struct({
  additionalRelaySourceProviderUsers: Schema.optionalKey(Schema.Array(additionalProviderUserSchema)),
  baseUrl: Schema.String,
  providerUserId: ProviderSubjectIdSchema,
  relaySourceProviderUserId: Schema.optionalKey(ProviderSubjectIdSchema),
});
export const ShellNativeStartupStageSchema = Schema.Literals([
  'entry',
  'connecting_private_channel',
  'loading_database',
  'creating_authentication',
  'creating_provider_users',
  'composing_runtime',
  'binding_server',
  'publishing_readiness',
  'ready',
  'awaiting_module_bindings',
  'typed_failure',
  'defect',
]);
export const ShellNativeStartupEventSchema = Schema.Struct({ stage: ShellNativeStartupStageSchema });
export const ShellNativeIssueCommandSchema = Schema.TaggedStruct('issue', {
  issuerPrincipalId: Schema.optionalKey(PrincipalIdSchema),
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
export const ShellNativeSessionGatewayCommandSchema = Schema.TaggedStruct(sessionGatewayTag, {
  request: GatewayContextRequestSchema,
});
export const ShellNativeSessionGatewayResponseSchema = Schema.TaggedStruct(sessionGatewayTag, {
  gateway: GatewayContextResponseSchema,
});
export const ShellNativeTenantSetupGatewayRequestSchema = Schema.Struct({
  audience: Schema.Literals(['catalog', 'pricing']),
});
export const ShellNativeSetupGatewayRequestSchema = Schema.Union([
  ShellNativeTenantSetupGatewayRequestSchema,
  Schema.Struct({
    audience: Schema.Literals([marketAppId, 'privacy', 'party-registry', customerContextAppId]),
    legalEntityId: SwitchLegalEntityPayloadSchema.fields.legalEntityId,
  }),
]);
export const ShellNativeSetupKeyIssueCommandSchema = Schema.TaggedStruct('setup-key-issue', {});
export const ShellNativeSetupKeyBoundCommandSchema = Schema.TaggedStruct('setup-key-bound', {});
export const ShellNativeSetupKeyIssuedResponseSchema = Schema.TaggedStruct('setup-key-issued', {
  providerKeyId: ProviderSubjectIdSchema,
});
export const ShellNativeTenantSetupGatewayCommandSchema = Schema.TaggedStruct('tenant-setup-gateway', {
  request: Schema.Struct({
    ...ShellNativeTenantSetupGatewayRequestSchema.fields,
    compositionRevision: GatewayContextRequestSchema.fields.compositionRevision,
  }),
});
export const ShellNativeSetupGatewayResponseSchema = Schema.TaggedStruct('setup-gateway', {
  gateway: GatewayContextResponseSchema,
});
export const ShellNativeBoundCommandSchema = Schema.TaggedStruct('bound', {});
export const ShellNativeRelaySourceIssueCommandSchema = Schema.TaggedStruct(sourceIssueTag, {
  issuerPrincipalId: Schema.optionalKey(PrincipalIdSchema),
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
export const ShellNativeRelaySourceBoundCommandSchema = Schema.TaggedStruct(sourceBoundTag, {});
export const ShellNativeModuleSourceIssueCommandSchema = Schema.TaggedStruct('module-source-issue', {
  issuerPrincipalId: Schema.optionalKey(PrincipalIdSchema),
  principalId: PrincipalIdSchema,
  sourceAppId: ShellNativeModuleAppIdSchema,
  tenantId: TenantIdSchema,
});
export const ShellNativeModuleSourceBoundCommandSchema = Schema.TaggedStruct('module-source-bound', {
  sourceAppId: ShellNativeModuleAppIdSchema,
});
export const ShellNativeGatewayProblemSchema = Schema.Union([
  GatewayAuthenticationRequiredProblemSchema,
  GatewayAudienceInvalidProblemSchema,
  GatewayReloadRequiredProblemSchema,
  GatewayForbiddenProblemSchema,
  GatewayRateLimitedProblemSchema,
  GatewayUnavailableProblemSchema,
  GatewayInternalProblemSchema,
]);
export const ShellNativeGatewayDiagnosticSchema = Schema.Struct({
  problem: Schema.Union([
    Schema.Literal('success'),
    Schema.Literal('unclassified'),
    ...ShellNativeGatewayProblemSchema.members.map((problem) => problem.fields._tag),
  ]),
  status: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(599)),
});
export const ShellNativeGatewayDiagnosticsCommandSchema = Schema.TaggedStruct(gatewayDiagnosticsTag, {});
export const ShellNativeGatewayDiagnosticsResponseSchema = Schema.TaggedStruct(gatewayDiagnosticsTag, {
  outcomes: Schema.Array(ShellNativeGatewayDiagnosticSchema).check(Schema.isMaxLength(32)),
});
export const ShellNativeIssuerCauseTagSchema = Schema.Literals([
  'InstalledModuleCatalogUnavailableError',
  'InstalledModuleCatalogInvalidError',
  'ActiveApplicationCompositionUnavailableError',
  'ActiveApplicationCompositionSourceReadError',
  'ApplicationCompositionValidationError',
  'GatewayIssuerConfigError',
  'GatewayScopeGrantUnavailableError',
  'SchemaError',
  'SqlError',
  'SqlTransactionError',
  'UnknownException',
  'HttpClientError',
  'RequestError',
  'ResponseError',
  'ConfigError',
  'other',
]);
export const ShellNativeIssuerDiagnosticSchema = Schema.Struct({
  audience: Schema.Union([ShellNativeModuleAppIdSchema, Schema.Literal('other')]),
  code: Schema.optionalKey(GatewayIssuerError.fields.code),
  failureCauseTag: Schema.optionalKey(ShellNativeIssuerCauseTagSchema),
  nestedCauseTag: Schema.optionalKey(ShellNativeIssuerCauseTagSchema),
  outcome: Schema.Literals(['success', 'audience', 'clock', 'configuration', 'principal', 'scope_grant', 'signing']),
});
const issuerCauseTag = (cause: unknown) => {
  if (cause === undefined) {
    return null;
  }
  return Predicate.hasProperty(cause, '_tag') && Schema.is(ShellNativeIssuerCauseTagSchema)(cause._tag)
    ? cause._tag
    : 'other';
};
interface ShellNativeIssuerCauseTags {
  failureCauseTag?: typeof ShellNativeIssuerCauseTagSchema.Type;
  nestedCauseTag?: typeof ShellNativeIssuerCauseTagSchema.Type;
}
export const describeShellNativeIssuerFailure = (failure: GatewayIssuerError) => {
  const failureCauseTag = issuerCauseTag(failure.failureCause);
  const nestedCauseTag = Predicate.hasProperty(failure.failureCause, 'cause')
    ? issuerCauseTag(failure.failureCause.cause)
    : null;
  const tags: ShellNativeIssuerCauseTags = {};
  if (failureCauseTag !== null) {
    tags.failureCauseTag = failureCauseTag;
  }
  if (nestedCauseTag !== null) {
    tags.nestedCauseTag = nestedCauseTag;
  }
  return {
    code: failure.code,
    ...tags,
    outcome: failure.stage,
  };
};
export const ShellNativeIssuerDiagnosticsCommandSchema = Schema.TaggedStruct(issuerDiagnosticsTag, {});
export const ShellNativeIssuerDiagnosticsResponseSchema = Schema.TaggedStruct(issuerDiagnosticsTag, {
  outcomes: Schema.Array(ShellNativeIssuerDiagnosticSchema).check(Schema.isMaxLength(32)),
});
export const ShellNativeRequestDiagnosticSchema = Schema.Struct({
  elapsedMillis: Schema.Int.check(Schema.isBetween({ maximum: 60_000, minimum: 0 })),
  phase: Schema.Literals(['dispatch_started', 'dispatch_completed', 'dispatch_failed', 'dispatch_timeout']),
  status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 100 }))),
  surface: Schema.Literals(['symmy', 'gateway', 'other']),
});
export const ShellNativeRequestDiagnosticsCommandSchema = Schema.TaggedStruct(requestDiagnosticsTag, {});
export const ShellNativeRequestDiagnosticsResponseSchema = Schema.TaggedStruct(requestDiagnosticsTag, {
  outcomes: Schema.Array(ShellNativeRequestDiagnosticSchema).check(Schema.isMaxLength(32)),
});
export const ShellNativeReleaseDiagnosticSchema = Schema.Struct({
  reason: ShellGatewayReleaseDiagnosticSchema,
  stage: Schema.Literal('release'),
});
export const ShellNativeReleaseDiagnosticsCommandSchema = Schema.TaggedStruct(releaseDiagnosticsTag, {});
export const ShellNativeReleaseDiagnosticsResponseSchema = Schema.TaggedStruct(releaseDiagnosticsTag, {
  outcomes: Schema.Array(ShellNativeReleaseDiagnosticSchema).check(Schema.isMaxLength(32)),
});
const appendRequestOutcome = Effect.fn('ShellNativeFixture.recordRequestPhase')(function* recordRequestPhase(
  outcomes: Ref.Ref<readonly (typeof ShellNativeRequestDiagnosticSchema.Type)[]>,
  surface: typeof ShellNativeRequestDiagnosticSchema.Type.surface,
  started: number,
  phase: typeof ShellNativeRequestDiagnosticSchema.Type.phase,
  status?: number,
) {
  const elapsedMillis = Math.min(60_000, Math.max(0, Math.round((yield* Clock.currentTimeMillis) - started)));
  const outcome = status === undefined ? { elapsedMillis, phase, surface } : { elapsedMillis, phase, status, surface };
  yield* Ref.update(outcomes, (previous) => [...previous, outcome].slice(-32));
});

export const observeShellNativeRequestDispatch = Effect.fn('ShellNativeFixture.observeRequestDispatch')(
  function* observeRequestDispatch<DispatchFailure, TimeoutFailure>(
    dispatch: Effect.Effect<Response, DispatchFailure>,
    onTimeout: Effect.Effect<never, TimeoutFailure>,
    outcomes: Ref.Ref<readonly (typeof ShellNativeRequestDiagnosticSchema.Type)[]>,
    surface: typeof ShellNativeRequestDiagnosticSchema.Type.surface,
  ) {
    const started = yield* Clock.currentTimeMillis;
    yield* appendRequestOutcome(outcomes, surface, started, 'dispatch_started');
    return yield* dispatch.pipe(
      Effect.tapError(() => appendRequestOutcome(outcomes, surface, started, 'dispatch_failed')),
      Effect.timeoutOrElse({
        duration: Duration.seconds(20),
        orElse: () =>
          appendRequestOutcome(outcomes, surface, started, 'dispatch_timeout').pipe(Effect.andThen(onTimeout)),
      }),
      Effect.tap((response) => appendRequestOutcome(outcomes, surface, started, 'dispatch_completed', response.status)),
    );
  },
);

export const ShellNativeChildCommandSchema = Schema.Union([
  ShellNativeIssueCommandSchema,
  ShellNativeSessionGatewayCommandSchema,
  ShellNativeBoundCommandSchema,
  ShellNativeRelaySourceIssueCommandSchema,
  ShellNativeRelaySourceBoundCommandSchema,
  ShellNativeModuleSourceIssueCommandSchema,
  ShellNativeModuleSourceBoundCommandSchema,
  ShellNativeGatewayDiagnosticsCommandSchema,
  ShellNativeIssuerDiagnosticsCommandSchema,
  ShellNativeRequestDiagnosticsCommandSchema,
  ShellNativeReleaseDiagnosticsCommandSchema,
  ShellNativeSetupKeyIssueCommandSchema,
  ShellNativeSetupKeyBoundCommandSchema,
  ShellNativeTenantSetupGatewayCommandSchema,
  Schema.TaggedStruct('enabled', { enabled: Schema.Boolean }),
]);
export const ShellNativeIssuedResponseSchema = Schema.TaggedStruct('issued', {
  providerKeyId: ProviderSubjectIdSchema,
  secret: Schema.String,
});
export const ShellNativeSafeFailureSchema = Schema.Union([
  Schema.Literals([
    'ShellNativeChildUnavailable',
    'InvalidCredentialsError',
    'AuthenticationUnavailableError',
    'PrincipalBindingMissingError',
    'PrincipalBindingAmbiguousError',
    'PrincipalInactiveError',
    'TenantInactiveError',
    'PrincipalResolutionUnavailableError',
    'SqlError',
    'SchemaError',
    'ApiKeyCredentialInvalidError',
    'ApiKeyProviderUnavailableError',
    'ApiKeyRateLimitedError',
    'ApiKeyStateInconsistentError',
    'unclassified',
  ]),
  ...ShellNativeGatewayProblemSchema.members.map((problem) => problem.fields._tag),
]);
export const ShellNativeUnavailableResponseSchema = Schema.TaggedStruct('unavailable', {
  failure: Schema.optionalKey(ShellNativeSafeFailureSchema),
});
export const ShellNativeChildResponseSchema = Schema.Union([
  ShellNativeIssuedResponseSchema,
  ShellNativeSessionGatewayResponseSchema,
  ShellNativeGatewayDiagnosticsResponseSchema,
  ShellNativeIssuerDiagnosticsResponseSchema,
  ShellNativeRequestDiagnosticsResponseSchema,
  ShellNativeReleaseDiagnosticsResponseSchema,
  ShellNativeSetupKeyIssuedResponseSchema,
  ShellNativeSetupGatewayResponseSchema,
  Schema.TaggedStruct('ack', {}),
  ShellNativeUnavailableResponseSchema,
]);
const publicJwkSchema = Schema.Struct({
  alg: Schema.Literal('EdDSA'),
  crv: Schema.Literal('Ed25519'),
  kid: Schema.String,
  kty: Schema.Literal('OKP'),
  use: Schema.Literal('sig'),
  x: Schema.String,
});
const privateJwkSchema = Schema.Struct({ ...publicJwkSchema.fields, d: Schema.String });
const requestTimeout = Effect.timeoutOrElse({
  duration: Duration.seconds(20),
  orElse: () => Effect.fail(unavailable()),
});
interface FixtureProviderKeyTarget extends Pick<TrustedPrincipalContext, 'principalId' | 'tenantId'> {
  readonly issuerPrincipalId?: TrustedPrincipalContext['principalId'];
}

/** Only the child receives this schema-checked owner configuration. */
export const decodeShellNativeRegionsEnvironment = Effect.fn('ShellNativeFixture.regionsEnvironment')(
  function* decodeShellNativeRegionsEnvironment(regionsProjectionJson?: string) {
    if (regionsProjectionJson === undefined) {
      return {};
    }
    const configuration = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(SymmyRegionsProjectionConfigurationSchema),
      { onExcessProperty: 'error' },
    )(regionsProjectionJson).pipe(Effect.mapError(unavailable));
    return {
      ONTOS_SYMMY_REGIONS_PROJECTION: yield* Schema.encodeEffect(
        Schema.fromJsonString(SymmyRegionsProjectionConfigurationSchema),
      )(configuration).pipe(Effect.mapError(unavailable)),
    };
  },
);
export const decodeShellNativePriceReadEnvironment = Effect.fn('ShellNativeFixture.priceReadEnvironment')(
  function* decodeShellNativePriceReadEnvironment(priceReadProjectionJson?: string) {
    if (priceReadProjectionJson === undefined) {
      return {};
    }
    const configuration = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(SymmyPriceReadProjectionConfigurationSchema),
      { onExcessProperty: 'error' },
    )(priceReadProjectionJson).pipe(Effect.mapError(unavailable));
    return {
      ONTOS_SYMMY_PRICE_READ_SOURCES: yield* Schema.encodeEffect(
        Schema.fromJsonString(SymmyPriceReadProjectionConfigurationSchema),
      )(configuration).pipe(Effect.mapError(unavailable)),
    };
  },
);

export { makeCompositionSnapshot as makeApiKeyGatewayNativeComposition } from './application-composition.ts';

const bundleChild = Effect.fn('ApiKeyGatewayNativeFixture.bundle')(function* bundleChild() {
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const generated = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        deliveryUnit: Schema.Struct({
          buildMarker: Schema.String,
          unitId: Schema.String.pipe(Schema.brand('UltramodernDeliveryUnitId')),
        }),
      }),
    ),
  )(yield* filesystem.readFileString(new URL('../../shared/ultramodern-build.json', import.meta.url).pathname));
  const identity = yield* Effect.try({
    catch: unavailable,
    try: () =>
      resolveUltramodernReleaseIdentity({
        generationBuildMarker: generated.deliveryUnit.buildMarker,
        unitId: generated.deliveryUnit.unitId,
        workspaceRoot: appRoot,
      }),
  });
  const cache = new URL('../../node_modules/.cache/ontos-1250/', import.meta.url).pathname;
  yield* filesystem.makeDirectory(cache, { recursive: true });
  const temporary = yield* filesystem.makeTempDirectoryScoped({ directory: cache, prefix: 'shell-' });
  const artifact = path.join(temporary, 'gateway.mjs');
  const bundle = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      'exec',
      'esbuild',
      new URL('../support/api-key-gateway-native-child.ts', import.meta.url).pathname,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      `--define:ULTRAMODERN_BUILD_MARKER=${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(identity.buildMarker)}`,
      `--define:ULTRAMODERN_SOURCE_REVISION=${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(identity.sourceRevision)}`,
      `--outfile=${artifact}`,
    ],
    { cwd: appRoot, forceKillAfter: Duration.seconds(3), stderr: 'pipe', stdout: 'pipe' },
  );
  const [exit] = yield* Effect.all([bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)], {
    concurrency: 3,
  });
  if (Number(exit) !== 0) {
    return yield* unavailable();
  }
  const description = yield* ChildProcess.make(process.execPath, [artifact, '--describe'], {
    cwd: appRoot,
    extendEnv: true,
    forceKillAfter: Duration.seconds(3),
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [descriptionExit, descriptionLines] = yield* Effect.all(
    [
      description.exitCode,
      description.stdout.pipe(Stream.decodeText(), Stream.runCollect),
      Stream.runDrain(description.stderr),
    ],
    { concurrency: 3 },
  ).pipe(requestTimeout);
  if (Number(descriptionExit) !== 0) {
    return yield* unavailable();
  }
  const receiverDeployment = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ appId: Schema.Literal('shell-super-app'), buildMarker: Schema.String })),
    { onExcessProperty: 'error' },
  )(descriptionLines.join('').trim()).pipe(Effect.mapError(unavailable));
  if (receiverDeployment.buildMarker !== identity.buildMarker) {
    return yield* unavailable();
  }
  return { artifact, receiverDeployment };
});

const migrateAuth = Effect.fn('ApiKeyGatewayNativeFixture.migrateAuth')(function* migrateAuth(adminUrl: string) {
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* filesystem.makeTempDirectoryScoped({ prefix: 'ontos-1250-auth-' });
  const configuration = path.join(temporary, 'drizzle.config.mjs');
  yield* filesystem.writeFileString(
    configuration,
    `export default { dialect: 'postgresql', out: process.env.ONTOS_1250_AUTH_MIGRATIONS, schema: process.env.ONTOS_1250_AUTH_SCHEMA, dbCredentials: { url: process.env.DATABASE_ADMIN_URL }, migrations: { schema: 'drizzle', table: '__drizzle_migrations_auth' } };`,
  );
  const child = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      '@app/shell-super-app',
      'exec',
      'drizzle-kit',
      'migrate',
      '--config',
      configuration,
    ],
    {
      cwd: appRoot,
      env: {
        DATABASE_ADMIN_URL: adminUrl,
        ONTOS_1250_AUTH_MIGRATIONS: new URL('../../drizzle-auth/', import.meta.url).pathname,
        ONTOS_1250_AUTH_SCHEMA: new URL('../../api/auth/db/schema.ts', import.meta.url).pathname,
      },
      extendEnv: true,
      forceKillAfter: Duration.seconds(3),
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [exit] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  if (Number(exit) !== 0) {
    return yield* unavailable();
  }
  return yield* Effect.void;
});

/** Closed TEST protocol only: the parent owns this listener before starting its Shell child. */
export const openShellNativePrivateChannel = Effect.fn('ShellNativePrivateChannel.open')(
  function* openShellNativePrivateChannel() {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: '/tmp', prefix: 's1250-' });
    yield* fs.chmod(temporary, 0o700);
    const directory = yield* fs.realPath(temporary);
    const socketPath = `${directory}/native.sock`;
    if (new TextEncoder().encode(socketPath).length > 96) {
      return yield* unavailable();
    }
    const server = yield* NodeSocketServer.make({ path: socketPath }).pipe(Effect.mapError(unavailable));
    const writer = yield* Deferred.make<Socket.Writer>();
    const responses = yield* Queue.unbounded<typeof ShellNativeChildResponseSchema.Type>();
    const failure = yield* Deferred.make<never, ApiKeyGatewayNativeFixtureError>();
    const connected = yield* Ref.make(false);
    const closing = yield* Ref.make(false);
    const exchangeGate = yield* Semaphore.make(1);
    const close = Ref.set(closing, true).pipe(Effect.andThen(Deferred.fail(failure, unavailable())), Effect.asVoid);
    yield* Effect.forkScoped(
      server
        .run((socket) =>
          Effect.scoped(
            Effect.gen(function* readPrivateResponses() {
              if (yield* Ref.getAndSet(connected, true)) {
                return yield* unavailable();
              }
              yield* Deferred.succeed(writer, yield* socket.writer);
              yield* Socket.toStream(socket).pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.mapEffect((line) =>
                  new TextEncoder().encode(line).length > 65_536
                    ? Effect.fail(unavailable())
                    : Schema.decodeUnknownEffect(Schema.fromJsonString(ShellNativeChildResponseSchema))(line).pipe(
                        Effect.mapError(unavailable),
                      ),
                ),
                Stream.runForEach((response) => Queue.offer(responses, response)),
              );
              return yield* Deferred.fail(failure, unavailable());
            }),
          ).pipe(
            Effect.catchIf(
              (error) =>
                Socket.isSocketError(error) &&
                Schema.is(Socket.SocketCloseError)(error.reason) &&
                error.reason.code === 1000,
              (error) =>
                Ref.get(closing).pipe(Effect.flatMap((expected) => (expected ? Effect.void : Effect.fail(error)))),
            ),
            Effect.tapError((error) => Deferred.fail(failure, unavailable(error))),
          ),
        )
        .pipe(Effect.catch((error) => Deferred.fail(failure, unavailable(error)))),
    );
    yield* Effect.addFinalizer(() => close.pipe(Effect.andThen(Queue.shutdown(responses))));
    return Object.freeze({
      close,
      exchange: Effect.fn('ShellNativePrivateChannel.exchange')(function* exchange(
        command: typeof ShellNativeChildCommandSchema.Encoded,
      ) {
        if (yield* Ref.get(closing)) {
          return yield* unavailable();
        }
        const line = yield* Schema.decodeUnknownEffect(ShellNativeChildCommandSchema, { onExcessProperty: 'error' })(
          command,
        ).pipe(
          Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ShellNativeChildCommandSchema))),
          Effect.mapError(unavailable),
        );
        const send = Effect.gen(function* sendClosedCommand() {
          const output = yield* Deferred.await(writer);
          yield* output.write(`${line}\n`).pipe(Effect.mapError(unavailable));
          return yield* Queue.take(responses);
        });
        return yield* Semaphore.withPermits(
          exchangeGate,
          1,
        )(Effect.raceFirst(send, Deferred.await(failure))).pipe(
          requestTimeout,
          Effect.tapError((error) => Deferred.fail(failure, error)),
        );
      }),
      socketPath,
    });
  },
);

const resolveAdditionalRelaySources = Effect.fn('ApiKeyGatewayNativeFixture.resolveAdditionalRelaySources')(
  function* resolveAdditionalRelaySources(
    options: ApiKeyGatewayNativeFixtureOptions,
    snapshot: typeof ActiveApplicationCompositionSnapshotSchema.Type,
  ) {
    const additionalInputs = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          registeredWorkloads: ShellNativeAdditionalRelaySourceSchema.fields.registeredWorkloads,
          sourceAppId: ShellNativeModuleAppIdSchema,
        }),
      ),
      { onExcessProperty: 'error' },
    )(options.additionalRelaySources ?? []).pipe(Effect.mapError(unavailable));
    if (
      additionalInputs.length > 0 &&
      (options.productionGate !== true ||
        options.relaySource === undefined ||
        new Set([...additionalInputs.map(({ sourceAppId }) => sourceAppId), options.relaySource.sourceAppId]).size !==
          additionalInputs.length + 1)
    ) {
      return yield* unavailable();
    }
    return yield* Effect.forEach(
      additionalInputs,
      (input) => {
        const sourceRelease = snapshot.composition.modules.find(
          ({ deployment }) => deployment.appId === input.sourceAppId,
        )?.deployment;
        return sourceRelease === undefined
          ? Effect.fail(unavailable())
          : Effect.succeed({
              ...input,
              compositionRevision: snapshot.composition.revision,
              sourceBuildMarker: sourceRelease.buildMarker,
            });
      },
      { concurrency: 1 },
    );
  },
);

/** Scope-owned process and private Unix socket protocol; no credentials enter readiness/stdout. */
export const makeApiKeyGatewayNativeFixture = Effect.fn('ApiKeyGatewayNativeFixture.make')(
  function* makeApiKeyGatewayNativeFixture(options: ApiKeyGatewayNativeFixtureOptions) {
    const pair = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: options.ownedDatabase.connections.admin.connectionString,
      DATABASE_URL: options.ownedDatabase.connections.runtime.connectionString,
    }).pipe(Effect.mapError(unavailable));
    if (!pair.admin.database.startsWith('ontos_test_party_gateway_') || pair.admin.database !== pair.runtime.database) {
      return yield* unavailable();
    }
    const snapshot = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
    )(options.snapshotJson).pipe(Effect.mapError(unavailable));
    yield* validateActiveApplicationCompositionSnapshot(snapshot).pipe(Effect.mapError(unavailable));
    const regionsEnvironment = yield* decodeShellNativeRegionsEnvironment(options.regionsProjectionJson);
    const priceReadEnvironment = yield* decodeShellNativePriceReadEnvironment(options.priceReadProjectionJson);
    const additionalRelaySources = yield* resolveAdditionalRelaySources(options, snapshot);
    const { artifact, receiverDeployment } = yield* bundleChild();
    if (
      snapshot.composition.shell.deployment.appId !== receiverDeployment.appId ||
      snapshot.composition.shell.deployment.buildMarker !== receiverDeployment.buildMarker
    ) {
      return yield* unavailable();
    }
    const sourceDeployment =
      options.relaySource === undefined
        ? undefined
        : snapshot.composition.modules.find(({ deployment }) => deployment.appId === options.relaySource?.sourceAppId)
            ?.deployment;
    if (options.relaySource !== undefined && sourceDeployment === undefined) {
      return yield* unavailable();
    }
    const relaySource: typeof ShellNativeRelaySourceSchema.Type | undefined =
      sourceDeployment === undefined || options.relaySource === undefined
        ? undefined
        : {
            compositionRevision: snapshot.composition.revision,
            ...options.relaySource,
            sourceBuildMarker: sourceDeployment.buildMarker,
          };
    const authRuntime = Context.get(
      yield* Layer.build(OwnedAuthRuntimeContractLive(options.ownedDatabase, snapshot.composition.revision)).pipe(
        Effect.mapError(unavailable),
      ),
      OwnedAuthRuntimeContract,
    );
    // A schema-only native clone already includes Auth objects, while its migration journal contains no rows.
    // Existing objects must pass establish's exact inventory checks instead of replaying CREATE SCHEMA.
    if (yield* authRuntime.needsMigration().pipe(Effect.mapError(unavailable))) {
      yield* migrateAuth(Redacted.value(authRuntime.adminConnectionString));
    }
    yield* authRuntime.establish().pipe(Effect.mapError(unavailable));
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4();
    const secret = `${yield* crypto.randomUUIDv4()}${yield* crypto.randomUUIDv4()}`;
    const source = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
    if (!Schema.is(Schema.Struct({ port: Schema.Int }))(source.address)) {
      return yield* unavailable();
    }
    yield* source.serve(
      Effect.succeed(HttpServerResponse.text(options.snapshotJson, { contentType: 'application/json' })),
    );
    const sourceUrl = `http://127.0.0.1:${source.address.port}/composition`;
    const signing = yield* Effect.tryPromise({
      catch: unavailable,
      try: generateKeyPair.bind(undefined, 'EdDSA', { crv: 'Ed25519', extractable: true }),
    }).pipe(requestTimeout);
    const privateKey = yield* Effect.tryPromise({
      catch: unavailable,
      try: exportJWK.bind(undefined, signing.privateKey),
    }).pipe(requestTimeout);
    const publicKey = yield* Effect.tryPromise({
      catch: unavailable,
      try: exportJWK.bind(undefined, signing.publicKey),
    }).pipe(requestTimeout);
    const kid = `fixture-${suffix}`;
    const issuer = 'https://shell-native.fixture.invalid';
    const privateJwk = yield* Schema.decodeUnknownEffect(privateJwkSchema)({
      ...privateKey,
      alg: 'EdDSA',
      kid,
      use: 'sig',
    }).pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(privateJwkSchema))), Effect.mapError(unavailable));
    const publicJwks = yield* Schema.decodeUnknownEffect(Schema.Struct({ keys: Schema.Array(publicJwkSchema) }))({
      keys: [{ ...publicKey, alg: 'EdDSA', kid, use: 'sig' }],
    }).pipe(
      Effect.flatMap(
        Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({ keys: Schema.Array(publicJwkSchema) }))),
      ),
      Effect.mapError(unavailable),
    );
    const privateChannel = yield* openShellNativePrivateChannel();
    yield* authRuntime.assertCurrent().pipe(Effect.mapError(unavailable));
    const childEnvironment = {
      ...priceReadEnvironment,
      ...regionsEnvironment,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: 'http://shell-native.localhost',
      DATABASE_ADMIN_URL: Redacted.value(authRuntime.adminConnectionString),
      DATABASE_URL: Redacted.value(authRuntime.runtimeConnectionString),
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: sourceUrl,
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_MODULE_BINDINGS: '[]',
      ONTOS_GATEWAY_PRIVATE_JWK: privateJwk,
      ONTOS_GATEWAY_PUBLIC_JWKS: publicJwks,
      ONTOS_SHELL_NATIVE_ADDITIONAL_RELAY_SOURCES: yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(ShellNativeAdditionalRelaySourceSchema)),
      )(additionalRelaySources),
      ONTOS_SHELL_NATIVE_PRODUCTION_GATE: options.productionGate === true ? 'true' : 'false',
      ONTOS_SHELL_NATIVE_RELAY_SOURCE: yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.OptionFromNullOr(ShellNativeRelaySourceSchema)),
      )(relaySource === undefined ? Option.none() : Option.some(relaySource)),
      ONTOS_SHELL_NATIVE_SOCKET: privateChannel.socketPath,
    };
    const effectiveEnvironment =
      options.productionGate === true
        ? {
            ...childEnvironment,
            SHELL_GATEWAY_ISSUER_DATABASE_URL: yield* Config.schema(
              Schema.URLFromString,
              'SHELL_GATEWAY_ISSUER_DATABASE_URL',
            ).pipe(
              Effect.map((url) => {
                url.pathname = new URL(pair.runtime.connectionString).pathname;
                return url.href;
              }),
            ),
          }
        : childEnvironment;
    const child = yield* ChildProcess.make(process.execPath, [artifact], {
      cwd: appRoot,
      env: effectiveEnvironment,
      forceKillAfter: Duration.seconds(3),
      // Inherit the configured native runner's TLS permission environment; every DB/auth destination above is owned.
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    // Register after the process: mark intentional disposal before process/socket finalizers run.
    yield* Effect.addFinalizer(() => privateChannel.close);
    const latestStage = yield* Ref.make<string>('spawning');
    const childFailure = yield* Ref.make<string>('none');
    const observedFailures = new Set<string>();
    yield* Effect.forkScoped(
      child.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(ShellNativeStartupEventSchema), {
            onExcessProperty: 'error',
          })(line.slice(0, 2048)).pipe(
            Effect.flatMap(({ stage }) =>
              Ref.set(latestStage, stage).pipe(
                Effect.andThen(Effect.logInfo('Shell native fixture startup', { stage })),
              ),
            ),
            Effect.catch(() => {
              const classification = [
                'ERR_MODULE_NOT_FOUND',
                'ERR_PACKAGE_PATH_NOT_EXPORTED',
                'SyntaxError',
                'TypeError',
                'ECONNREFUSED',
                'ETIMEDOUT',
              ].find((name) => line.includes(name));
              if (classification === undefined || observedFailures.has(classification)) {
                return Effect.void;
              }
              observedFailures.add(classification);
              return Ref.set(childFailure, classification).pipe(
                Effect.andThen(Effect.logWarning('Shell native fixture child failure', { classification })),
              );
            }),
          ),
        ),
      ),
    );
    const line = yield* Effect.raceFirst(
      child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
      child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.logWarning('Shell native fixture exited before readiness', { exitCode: Number(code) }).pipe(
            Effect.andThen(Effect.fail(unavailable())),
          ),
        ),
      ),
    ).pipe(
      requestTimeout,
      Effect.tapError(() =>
        Effect.gen(function* reportStartupFailure() {
          yield* Effect.logWarning('Shell native fixture startup failed', {
            classification: yield* Ref.get(childFailure),
            stage: yield* Ref.get(latestStage),
          });
        }),
      ),
    );
    if (Option.isNone(line)) {
      return yield* unavailable();
    }
    const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShellNativeChildReadySchema))(
      line.value,
    ).pipe(Effect.mapError(unavailable));
    const closed = yield* Ref.make(false);
    const issuedOnce = yield* Ref.make(false);
    const sourceIssuedOnce = yield* Ref.make(false);
    const setupKeyIssuedOnce = yield* Ref.make(false);
    const issuedModulePrincipals = new Map<typeof ShellNativeModuleAppIdSchema.Type, string>();
    const boundPrincipal = yield* Ref.make(Option.none<TrustedPrincipalContext>());
    const fixtureBoundActor = yield* Ref.make(Option.none<Pick<TrustedPrincipalContext, 'principalId' | 'tenantId'>>());
    yield* Effect.addFinalizer(() => Ref.set(closed, true).pipe(Effect.asVoid));
    const ensureOpen = Ref.get(closed).pipe(
      Effect.flatMap((value) => (value ? Effect.fail(unavailable()) : Effect.void)),
    );
    const exchange = Effect.fn('ApiKeyGatewayNativeFixture.exchange')(function* exchange(
      command: typeof ShellNativeChildCommandSchema.Encoded,
    ) {
      yield* ensureOpen;
      const response = yield* Effect.raceFirst(
        privateChannel.exchange(command),
        child.exitCode.pipe(Effect.flatMap(() => Effect.fail(unavailable()))),
      );
      if (Schema.is(ShellNativeUnavailableResponseSchema)(response)) {
        yield* Effect.logWarning('Shell native private command refused', {
          command: command._tag,
          failure: response.failure ?? 'unclassified',
        });
        return yield* unavailable();
      }
      return response;
    });
    return Object.freeze({
      additionalRelaySourceProviderUsers: ready.additionalRelaySourceProviderUsers ?? [],
      baseUrl: ready.baseUrl,
      compositionSourceUrl: sourceUrl,
      gatewayDiagnostics: Effect.fn('ApiKeyGatewayNativeFixture.gatewayDiagnostics')(function* gatewayDiagnostics() {
        yield* ensureOpen;
        if (options.productionGate !== true) {
          return yield* unavailable();
        }
        const response = yield* exchange({ _tag: gatewayDiagnosticsTag });
        return Schema.is(ShellNativeGatewayDiagnosticsResponseSchema)(response)
          ? response.outcomes
          : yield* unavailable();
      }),
      issueAndBind: Effect.fn('ApiKeyGatewayNativeFixture.issueAndBind')(function* issueAndBind(
        principal: TrustedPrincipalContext,
      ) {
        yield* ensureOpen;
        if (yield* Ref.getAndSet(issuedOnce, true)) {
          return yield* unavailable();
        }
        const issued = yield* exchange({
          _tag: 'issue',
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        });
        if (!Schema.is(ShellNativeIssuedResponseSchema)(issued)) {
          return yield* unavailable();
        }
        const credential = Redacted.make(issued.secret);
        const runtime = yield* ActionRuntime;
        const binding = yield* runtime.runAction({
          payload: { providerSubjectId: issued.providerKeyId },
          principal,
          registration: bindSelfApiKeyAction,
          transport: {
            correlationId: 'native-gateway-bind',
            idempotencyKey: `native-gateway-bind:${issued.providerKeyId}`,
          },
        });
        yield* exchange({ _tag: 'bound' });
        yield* Ref.set(boundPrincipal, Option.some(principal));
        return Object.freeze({
          authBindingId: binding.authBindingId,
          secret: credential,
          setEnabled: (enabled: boolean) => exchange({ _tag: 'enabled', enabled }).pipe(Effect.asVoid),
        });
      }),
      issueFixtureModuleProviderKey: Effect.fn('ApiKeyGatewayNativeFixture.issueFixtureModuleProviderKey')(
        function* issueFixtureModuleProviderKey(
          input: FixtureProviderKeyTarget & {
            readonly sourceAppId: typeof ShellNativeModuleAppIdSchema.Type;
          },
        ) {
          yield* ensureOpen;
          const actor = yield* Ref.get(fixtureBoundActor);
          if (
            options.productionGate !== true ||
            !additionalRelaySources.some(({ sourceAppId }) => sourceAppId === input.sourceAppId) ||
            (ready.additionalRelaySourceProviderUsers ?? []).every(
              ({ sourceAppId }) => sourceAppId !== input.sourceAppId,
            ) ||
            Option.isNone(actor) ||
            actor.value.principalId === input.principalId ||
            actor.value.tenantId !== input.tenantId ||
            issuedModulePrincipals.has(input.sourceAppId) ||
            [...issuedModulePrincipals.values()].includes(input.principalId)
          ) {
            return yield* unavailable();
          }
          issuedModulePrincipals.set(input.sourceAppId, input.principalId);
          const issued = yield* exchange({ _tag: 'module-source-issue', ...input });
          if (!Schema.is(ShellNativeIssuedResponseSchema)(issued)) {
            return yield* unavailable();
          }
          return Object.freeze({
            acknowledgeBinding: exchange({ _tag: 'module-source-bound', sourceAppId: input.sourceAppId }).pipe(
              Effect.asVoid,
            ),
            providerKeyId: issued.providerKeyId,
            secret: Redacted.make(issued.secret),
          });
        },
      ),
      issueFixtureProviderKey: Effect.fn('ApiKeyGatewayNativeFixture.issueFixtureProviderKey')(
        function* issueFixtureProviderKey(principal: FixtureProviderKeyTarget) {
          yield* ensureOpen;
          if (options.productionGate !== true || (yield* Ref.getAndSet(issuedOnce, true))) {
            return yield* unavailable();
          }
          const issued = yield* exchange({
            _tag: 'issue',
            issuerPrincipalId: principal.issuerPrincipalId ?? principal.principalId,
            principalId: principal.principalId,
            tenantId: principal.tenantId,
          });
          if (!Schema.is(ShellNativeIssuedResponseSchema)(issued)) {
            return yield* unavailable();
          }
          return Object.freeze({
            acknowledgeBinding: exchange({ _tag: 'bound' }).pipe(
              Effect.andThen(Ref.set(fixtureBoundActor, Option.some(principal))),
              Effect.asVoid,
            ),
            providerKeyId: issued.providerKeyId,
            secret: Redacted.make(issued.secret),
          });
        },
      ),
      issueFixtureRelaySourceProviderKey: Effect.fn('ApiKeyGatewayNativeFixture.issueFixtureRelaySourceProviderKey')(
        function* issueFixtureRelaySourceProviderKey(principal: FixtureProviderKeyTarget) {
          yield* ensureOpen;
          const actor = yield* Ref.get(fixtureBoundActor);
          if (
            options.productionGate !== true ||
            relaySource === undefined ||
            ready.relaySourceProviderUserId === undefined ||
            Option.isNone(actor) ||
            actor.value.principalId === principal.principalId ||
            actor.value.tenantId !== principal.tenantId ||
            [...issuedModulePrincipals.values()].includes(principal.principalId) ||
            (yield* Ref.getAndSet(sourceIssuedOnce, true))
          ) {
            return yield* unavailable();
          }
          const issued = yield* exchange({
            _tag: sourceIssueTag,
            issuerPrincipalId: principal.issuerPrincipalId ?? principal.principalId,
            principalId: principal.principalId,
            tenantId: principal.tenantId,
          });
          if (!Schema.is(ShellNativeIssuedResponseSchema)(issued)) {
            return yield* unavailable();
          }
          return Object.freeze({
            acknowledgeBinding: exchange({ _tag: sourceBoundTag }).pipe(Effect.asVoid),
            providerKeyId: issued.providerKeyId,
            secret: Redacted.make(issued.secret),
          });
        },
      ),
      issueFixtureSetupActorKey: Effect.fn('ApiKeyGatewayNativeFixture.issueFixtureSetupActorKey')(
        function* issueFixtureSetupActorKey() {
          yield* ensureOpen;
          if (
            options.productionGate !== true ||
            Option.isNone(yield* Ref.get(fixtureBoundActor)) ||
            (yield* Ref.getAndSet(setupKeyIssuedOnce, true))
          ) {
            return yield* unavailable();
          }
          const issued = yield* exchange({ _tag: 'setup-key-issue' });
          if (!Schema.is(ShellNativeSetupKeyIssuedResponseSchema)(issued)) {
            return yield* unavailable();
          }
          return Object.freeze({
            acknowledgeBinding: exchange({ _tag: 'setup-key-bound' }).pipe(Effect.asVoid),
            providerKeyId: issued.providerKeyId,
          });
        },
      ),
      issueFixtureSetupGateway: Effect.fn('ApiKeyGatewayNativeFixture.issueFixtureSetupGateway')(
        function* issueFixtureSetupGateway(input: typeof ShellNativeSetupGatewayRequestSchema.Encoded) {
          yield* ensureOpen;
          if (options.productionGate !== true || Option.isNone(yield* Ref.get(fixtureBoundActor))) {
            return yield* unavailable();
          }
          const request = yield* Schema.decodeUnknownEffect(ShellNativeSetupGatewayRequestSchema, {
            onExcessProperty: 'error',
          })(input).pipe(Effect.mapError(unavailable));
          if (Schema.is(ShellNativeTenantSetupGatewayRequestSchema)(request)) {
            const response = yield* exchange({
              _tag: 'tenant-setup-gateway',
              request: { ...request, compositionRevision: snapshot.composition.revision },
            });
            return Schema.is(ShellNativeSetupGatewayResponseSchema)(response) ? response.gateway : yield* unavailable();
          }
          const response = yield* exchange({
            _tag: sessionGatewayTag,
            request: { ...request, compositionRevision: snapshot.composition.revision },
          });
          return Schema.is(ShellNativeSessionGatewayResponseSchema)(response) ? response.gateway : yield* unavailable();
        },
      ),
      issuer,
      issuerDiagnostics: Effect.fn('ApiKeyGatewayNativeFixture.issuerDiagnostics')(function* issuerDiagnostics() {
        yield* ensureOpen;
        if (options.productionGate !== true) {
          return yield* unavailable();
        }
        const response = yield* exchange({ _tag: issuerDiagnosticsTag });
        return Schema.is(ShellNativeIssuerDiagnosticsResponseSchema)(response)
          ? response.outcomes
          : yield* unavailable();
      }),
      issueRelaySourceAndBind: Effect.fn('ApiKeyGatewayNativeFixture.issueRelaySourceAndBind')(
        function* issueRelaySourceAndBind(principal: TrustedPrincipalContext) {
          yield* ensureOpen;
          const actor = yield* Ref.get(boundPrincipal);
          if (
            relaySource === undefined ||
            ready.relaySourceProviderUserId === undefined ||
            Option.isNone(actor) ||
            actor.value.principalId === principal.principalId ||
            actor.value.tenantId !== principal.tenantId ||
            (yield* Ref.getAndSet(sourceIssuedOnce, true))
          ) {
            return yield* unavailable();
          }
          const issued = yield* exchange({
            _tag: sourceIssueTag,
            principalId: principal.principalId,
            tenantId: principal.tenantId,
          });
          if (!Schema.is(ShellNativeIssuedResponseSchema)(issued)) {
            return yield* unavailable();
          }
          const sourceCredential = Redacted.make(issued.secret);
          const runtime = yield* ActionRuntime;
          const binding = yield* runtime.runAction({
            payload: { providerSubjectId: issued.providerKeyId },
            principal,
            registration: bindSelfApiKeyAction,
            transport: {
              correlationId: 'native-relay-source-bind',
              idempotencyKey: `native-relay-source-bind:${issued.providerKeyId}`,
            },
          });
          yield* exchange({ _tag: sourceBoundTag });
          return Object.freeze({
            ...relaySource,
            authBindingId: binding.authBindingId,
            principalId: principal.principalId,
            providerKeyId: issued.providerKeyId,
            secret: sourceCredential,
          });
        },
      ),
      providerUserId: ready.providerUserId,
      publicJwks,
      relaySourceProviderUserId: ready.relaySourceProviderUserId,
      releaseDiagnostics: Effect.fn('ApiKeyGatewayNativeFixture.releaseDiagnostics')(function* releaseDiagnostics() {
        yield* ensureOpen;
        if (options.productionGate !== true) {
          return yield* unavailable();
        }
        const response = yield* exchange({ _tag: releaseDiagnosticsTag });
        return Schema.is(ShellNativeReleaseDiagnosticsResponseSchema)(response)
          ? response.outcomes
          : yield* unavailable();
      }),
      requestDiagnostics: Effect.fn('ApiKeyGatewayNativeFixture.requestDiagnostics')(function* requestDiagnostics() {
        yield* ensureOpen;
        if (options.productionGate !== true) {
          return yield* unavailable();
        }
        const response = yield* exchange({ _tag: requestDiagnosticsTag });
        return Schema.is(ShellNativeRequestDiagnosticsResponseSchema)(response)
          ? response.outcomes
          : yield* unavailable();
      }),
    });
  },
);

export { sealComposition as sealApiKeyGatewayNativeComposition } from './application-composition.ts';
