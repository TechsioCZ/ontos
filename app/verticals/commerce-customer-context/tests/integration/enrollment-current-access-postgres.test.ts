import { isAPIError } from 'better-auth/api';
import { getTableName, sql } from 'drizzle-orm';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  BusinessPermissionRelationshipMutation,
  ContextAccess,
  ReadPermissionDenied,
  ReadRuntime,
  runAction,
} from '@app/core-runtime';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { parseResendEmailDeliveryConfig } from '@app/email-delivery/resend';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Order,
  Config,
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { expect, it } from 'effect-rstest';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  decodeSupportedGatewayContextClaims,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
} from '@app/shared-contracts';
import { ChildProcess } from 'effect/process';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { CounterpartyCommerceAccessCheckResponseSchema } from '../../shared/apis/counterparty-commerce-access-check.ts';
import type { CounterpartyCommerceAccessCheckRequest } from '../../shared/apis/counterparty-commerce-access-check.ts';
import { counterpartyInvitationJourneyDefinition } from '../../src/enrollment/journeys/counterparty-invitation.ts';
import type { RetailPortalProfileBindingReadRequest } from '../../shared/apis/retail-portal-profile-binding-read.ts';
import { RetailPortalProfileBindingReadResponseSchema } from '../../shared/apis/retail-portal-profile-binding-read.ts';

import { startPortalEnrollmentAction } from '../../src/actions/start-portal-enrollment.action.ts';
import { commerceEnrollmentOwnerAttemptStoreForRun } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import {
  ClaimEnrollmentTransitionInputSchema,
  EnrollmentResourceIdSchema,
  enrollmentDigest,
  RecordEnrollmentOutcomeInputSchema,
  ReadEnrollmentAttemptInputSchema,
  ReadEnrollmentOwnerOperationInputSchema,
} from '../../shared/enrollment-contracts.ts';
import {
  retailSelfEnrollmentStepPlan,
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  retailSelfEnrollmentEvidenceReference,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  CommerceEnrollmentOwnerTransitionSchema,
  commerceEnrollmentOwnerTransitionDriverFor,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { grantCommercePortalAuthRuntimePrivileges } from '../../scripts/bootstrap-portal-auth-runtime-role.mts';
import { parseCommercePortalAuthDatabaseConfig } from '../../scripts/portal-auth-database-config.mts';
import { makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import {
  account as portalAuthAccount,
  COMMERCE_PORTAL_AUTH_SCHEMA_NAME,
  user as portalAuthUser,
  verification as portalAuthVerification,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { makeCommercePortalAuthRecoveryStore } from '../../src/portal-auth/persistence/portal-auth-recovery-store.ts';
import { makeCommercePortalAuthAuditRecorder } from '../../src/portal-auth/audit/audit.ts';
import { makeCommercePortalAuthRecoveryProvider } from '../../api/portal-auth/provider/recovery/provider-service.ts';
import {
  CommercePortalAuthRecoveryProviderService,
  CommercePortalAuthRecoveryReconciliationService,
  CommercePortalAuthRecoveryStoreService,
  makeCommercePortalAuthEmailDelivery,
  makeCommercePortalAuthRecoveryReconciliation,
  makeCommercePortalAuthRecoveryService,
} from '../../api/portal-auth/provider/recovery/index.ts';
import { counterpartyAccessPortForScopedTransaction } from '../../src/persistence/access-persistence.ts';
import { retailPortalProfileBindingReadRead } from '../../src/api/retail-portal-profile-binding-read.read.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { CommercePortalAuthEnrollmentAttemptProjectionSchema } from '../../api/portal-auth/enrollment/contracts.ts';
import { claimInvitationEffect } from '../../api/portal-auth/enrollment/claim-invitation.ts';
import { claimCounterpartyAccessInvitationAction } from '../../src/actions/claim-counterparty-access-invitation.action.ts';
import {
  CommerceActionCommitResolutionFailed,
  retailPortalBindingOwnerEffect,
} from '../../src/enrollment/journeys/retail-self-enrollment-profile-owners.ts';
import { counterpartyInvitationClaimReconciliationFor } from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import {
  CommerceEnrollmentAttemptRejected,
  CommerceEnrollmentAttemptConflict,
} from '../../src/enrollment/attempts/errors.ts';
import { CommerceEnrollmentOwnerEffectUnavailable } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import {
  CounterpartyInvitationProofDelivery,
  unavailableCounterpartyInvitationProofDelivery,
} from '../../shared/domain/invitation-proof-delivery.ts';
import { makeCapturingCounterpartyInvitationProofDelivery } from '../support/counterparty-invitation-proof-capture.ts';
import {
  makeOwnedEnrollmentCurrentAccessFixture,
  makeOwnedEnrollmentCurrentAccessDatabase,
  makeEnrollmentCurrentAccessFixture,
  prepareEnrollmentCurrentAccessInvitation,
} from '../support/enrollment-current-access-fixture.ts';

type NativeCurrentAccessFixture = Effect.Success<ReturnType<typeof makeOwnedEnrollmentCurrentAccessFixture>>;
type CompletionOutboxEvidence = Effect.Success<
  ReturnType<NativeCurrentAccessFixture['fixture']['evidence']>
>['outbox'][number];

const immutableCompletionMessage = (message: CompletionOutboxEvidence) => ({
  createdAt: message.createdAt,
  domainEventId: message.domainEventId,
  outboxMessageId: message.outboxMessageId,
  payloadJson: message.payloadJson,
  producerModuleKey: message.producerModuleKey,
  tenantId: message.tenantId,
  topic: message.topic,
});

const expectSameCompletionReceipt = (
  before: readonly CompletionOutboxEvidence[],
  after: readonly CompletionOutboxEvidence[],
) => {
  expect(before).toHaveLength(1);
  expect(after).toHaveLength(1);
  expect(after.map(immutableCompletionMessage)).toEqual(before.map(immutableCompletionMessage));
  for (const message of after) {
    expect(message.matchedAt).not.toBeNull();
  }
  for (const [index, message] of before.entries()) {
    if (message.matchedAt !== null) {
      expect(after[index]?.matchedAt).toEqual(message.matchedAt);
    }
  }
};

const resourceReferenceOrder = Order.mapInput(Order.String, (ref: { readonly resourceId: string }) => ref.resourceId);

const fixtureClaimFailure = (cause: unknown) =>
  Object.defineProperty(new Error('The fixture gateway claims are invalid'), 'cause', { value: Redacted.make(cause) });
const ReceiverMarkerSchema = Schema.Struct({
  appId: Schema.Literal('commerce-customer-context'),
  buildMarker: Schema.String,
});
const ReceiverReadySchema = Schema.Struct({
  marker: ReceiverMarkerSchema,
  port: Schema.Int,
  type: Schema.Literal('ready'),
});
// Explicit synthetic transport config prevents inheriting operator credentials or a real mail endpoint.
// Recipient accounts are already verified; these child requests must never dispatch email.
const receiverEmailEnvironment = {
  RESEND_API_KEY: 're_native_enrollment_fixture_not_a_provider_credential',
  RESEND_API_URL: 'https://127.0.0.1:1/emails',
  RESEND_FROM_EMAIL: 'Enrollment fixture <no-reply@enrollment-current.example.test>',
};

const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const makeReceiverArtifact = Effect.fn('EnrollmentCurrent.makeReceiverArtifact')(
  function* makeReceiverArtifactEffect() {
    const artifact = fileURLToPath(
      new URL(`../../node_modules/.cache/ontos-1232/${randomUUID()}.mjs`, import.meta.url),
    );
    yield* Effect.addFinalizer(() => Effect.promise(async () => await rm(artifact, { force: true })));
    const bundle = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        'exec',
        'esbuild',
        'verticals/commerce-customer-context/tests/support/enrollment-current-access-receiver.fixture.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--outfile=${artifact}`,
      ],
      { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
    );
    const [bundleExit] = yield* Effect.all(
      [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
      { concurrency: 3 },
    );
    expect(bundleExit).toBe(0);
    const description = yield* ChildProcess.make(process.execPath, [artifact, '--describe'], {
      cwd: appRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [markerLines, exit] = yield* Effect.all(
      [
        description.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
        description.exitCode,
        Stream.runDrain(description.stderr),
      ],
      { concurrency: 3 },
    );
    expect(exit).toBe(0);
    const marker = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiverMarkerSchema))(markerLines[0]);
    return { artifact, marker };
  },
);

const NativeRecipientSignupCodeSchema = Schema.Literals([
  'INVALID_EMAIL',
  'INVALID_PASSWORD',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'EMAIL_PASSWORD_SIGN_UP_DISABLED',
  'FAILED_TO_CREATE_USER',
  'COMMERCE_AUTH_DATABASE_FAILURE',
  'COMMERCE_AUTH_DATABASE_TIMEOUT',
  'COMMERCE_AUTH_CORRELATION_INVALID',
  'OTHER_OR_MISSING',
]);

const NativeRecipientSignupErrorKindSchema = Schema.Literals([
  'SqlError',
  'EffectDrizzleQueryError',
  'EffectDrizzleError',
  'EffectTransactionRollbackError',
  'TypeError',
  'ReferenceError',
  'DOMException',
  'OTHER',
]);
const nativeRecipientSignupErrorKind = (cause: unknown): typeof NativeRecipientSignupErrorKindSchema.Type => {
  if (Schema.is(Schema.instanceOf(DOMException))(cause)) {
    return 'DOMException';
  }
  if (Schema.is(Schema.Struct({ _tag: NativeRecipientSignupErrorKindSchema }))(cause)) {
    return cause._tag;
  }
  return Schema.is(Schema.Struct({ name: NativeRecipientSignupErrorKindSchema }))(cause) ? cause.name : 'OTHER';
};

const NativeRecipientSignupPreflightSchema = Schema.Struct({
  accountInsert: Schema.Boolean,
  databaseMatches: Schema.Boolean,
  identityMatches: Schema.Boolean,
  schemaUsage: Schema.Boolean,
  userInsert: Schema.Boolean,
  userSelect: Schema.Boolean,
  verificationInsert: Schema.Boolean,
});
const nativeRecipientSignupPreflightUnavailable = {
  accountInsert: false,
  databaseMatches: false,
  identityMatches: false,
  preflightSucceeded: false,
  schemaUsage: false,
  userInsert: false,
  userSelect: false,
  verificationInsert: false,
};

const NativeRecipientSignupStatusSchema = Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 400 }));
const NativeRecipientSignupFailureFields = {
  code: NativeRecipientSignupCodeSchema,
  errorKind: NativeRecipientSignupErrorKindSchema,
  kind: Schema.Literals(['api_error', 'non_api_error']),
  statusCode: Schema.optionalKey(NativeRecipientSignupStatusSchema),
};
const NativeRecipientSignupFailureSchema = Schema.TaggedStruct(
  'NativeRecipientAccountIssuanceFailed',
  NativeRecipientSignupFailureFields,
);
const NativeRecipientAccountIssuanceFailed = Schema.TaggedError<typeof NativeRecipientSignupFailureSchema.Type>()(
  'NativeRecipientAccountIssuanceFailed',
  NativeRecipientSignupFailureFields,
);

// Only closed public metadata survives this foreign boundary; never retain the provider throwable.
const nativeRecipientSignupFailure = (cause: unknown): typeof NativeRecipientSignupFailureSchema.Type => {
  const errorKind = nativeRecipientSignupErrorKind(cause);
  if (!isAPIError(cause)) {
    return new NativeRecipientAccountIssuanceFailed({ code: 'OTHER_OR_MISSING', errorKind, kind: 'non_api_error' });
  }
  const candidateCode = cause.body?.code;
  const code = Schema.is(NativeRecipientSignupCodeSchema)(candidateCode) ? candidateCode : 'OTHER_OR_MISSING';
  const { statusCode } = cause;
  return Schema.is(NativeRecipientSignupStatusSchema)(statusCode)
    ? new NativeRecipientAccountIssuanceFailed({ code, errorKind, kind: 'api_error', statusCode })
    : new NativeRecipientAccountIssuanceFailed({ code, errorKind, kind: 'api_error' });
};

const NativeRecipientRealmPreparationFailureSchema = Schema.TaggedStruct('NativeRecipientRealmPreparationFailed', {
  stage: Schema.Literals(['db:portal-auth:migrate', 'grant-runtime', 'db:portal-auth:verify']),
});
const NativeRecipientRealmPreparationFailed = Schema.TaggedError<
  typeof NativeRecipientRealmPreparationFailureSchema.Type
>()('NativeRecipientRealmPreparationFailed', { stage: NativeRecipientRealmPreparationFailureSchema.fields.stage });

/** Only the live owned constructor supplies this internal preparation's database pair. */
const prepareOwnedEnrollmentRecipientRealm = Effect.fn('EnrollmentCurrentAccessFixture.prepareRealm')(
  function* prepareOwnedEnrollmentRecipientRealmEffect(
    owned: Effect.Success<ReturnType<typeof makeOwnedEnrollmentCurrentAccessDatabase>>,
  ) {
    const pair = yield* parseCommercePortalAuthDatabaseConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: owned.connections.admin.connectionString,
      COMMERCE_PORTAL_AUTH_DATABASE_URL: owned.connections.runtime.connectionString,
    }).pipe(Effect.mapError(() => new NativeRecipientRealmPreparationFailed({ stage: 'grant-runtime' })));
    const toolchain = yield* Config.all({ HOME: Config.String('HOME'), PATH: Config.String('PATH') });
    const environment = {
      ...toolchain,
      APP_ENV_PATH: '/dev/null',
      COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: Redacted.value(pair.admin.connectionString),
      COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(pair.runtime.connectionString),
    };
    const runOwnerRealmCommand = Effect.fn('EnrollmentCurrentAccessFixture.realmCommand')(
      function* runOwnerRealmCommandEffect(command: 'db:portal-auth:migrate' | 'db:portal-auth:verify') {
        const child = yield* ChildProcess.make(
          'mise',
          ['exec', '--', 'pnpm', '--filter', '@app/commerce-customer-context', 'run', command],
          { cwd: appRoot, env: environment, extendEnv: false, stderr: 'pipe', stdout: 'pipe' },
        ).pipe(Effect.mapError(() => new NativeRecipientRealmPreparationFailed({ stage: command })));
        // Drizzle/provider output can carry connection details; retain only a closed stage on failure.
        const [exitCode] = yield* Effect.all(
          [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
          { concurrency: 3 },
        ).pipe(Effect.mapError(() => new NativeRecipientRealmPreparationFailed({ stage: command })));
        if (exitCode !== 0) {
          yield* new NativeRecipientRealmPreparationFailed({ stage: command });
        }
      },
    );
    yield* runOwnerRealmCommand('db:portal-auth:migrate');
    const admin = yield* PgClient.makeClient({ url: pair.admin.connectionString }).pipe(
      Effect.mapError(() => new NativeRecipientRealmPreparationFailed({ stage: 'grant-runtime' })),
    );
    yield* grantCommercePortalAuthRuntimePrivileges(admin, pair).pipe(
      Effect.mapError(() => new NativeRecipientRealmPreparationFailed({ stage: 'grant-runtime' })),
    );
    yield* runOwnerRealmCommand('db:portal-auth:verify');
  },
);

/** Genuine provider issuance, production verification settlement and native session hooks. */
const makeEnrollmentRecipientRealm = Effect.fn('EnrollmentCurrentAccessFixture.recipientRealm')(
  function* makeEnrollmentRecipientRealmEffect(
    owned: Effect.Success<ReturnType<typeof makeOwnedEnrollmentCurrentAccessDatabase>>,
  ) {
    yield* Effect.scoped(prepareOwnedEnrollmentRecipientRealm(owned).pipe(Effect.provide(Reactivity.layer)));
    const { connections } = owned;
    const origin = 'https://enrollment-current.ontos.test';
    const secret = Redacted.make('isolated-enrollment-claim-native-fixture-secret'.repeat(2));
    const configuration = yield* parseCommercePortalAuthConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_URL: connections.runtime.connectionString,
      COMMERCE_PORTAL_AUTH_SECRET: Redacted.value(secret),
      COMMERCE_PORTAL_AUTH_URL: origin,
    });
    const database = yield* makeCommercePortalAuthDatabase(configuration);
    const crypto = yield* Layer.build(commercePortalAuthPlatformCryptoLive);
    const store = yield* makeCommercePortalAuthRecoveryStore(database.executor).pipe(Effect.provide(crypto));
    const tokens: string[] = [];
    const emailDelivery = yield* makeCommercePortalAuthEmailDelivery({
      sendOTP: () => Promise.resolve(),
      sendResetPassword: () => Promise.resolve(),
      sendVerificationEmail: ({ token }) => {
        tokens.push(token);
        return Promise.resolve();
      },
    }).pipe(Effect.provideService(CommercePortalAuthRecoveryStoreService, store));
    const auth = yield* makeCommercePortalAuth({ configuration, databaseAdapter: database.adapter, emailDelivery });
    const email = `enrollment-${randomUUID()}@example.test`;
    const password = randomUUID().repeat(2);
    const accountTable = `"${COMMERCE_PORTAL_AUTH_SCHEMA_NAME}"."${getTableName(portalAuthAccount)}"`;
    const userTable = `"${COMMERCE_PORTAL_AUTH_SCHEMA_NAME}"."${getTableName(portalAuthUser)}"`;
    const verificationTable = `"${COMMERCE_PORTAL_AUTH_SCHEMA_NAME}"."${getTableName(portalAuthVerification)}"`;
    // This observes only the same clone-bound provider pool; it never gates genuine account issuance.
    const preflight = yield* database.executor
      .execute(
        sql`select
          has_table_privilege(current_user, ${accountTable}, 'INSERT') as "accountInsert",
          current_database() = ${connections.runtime.database} as "databaseMatches",
          current_user = ${connections.runtime.user} as "identityMatches",
          has_schema_privilege(current_user, ${COMMERCE_PORTAL_AUTH_SCHEMA_NAME}, 'USAGE') as "schemaUsage",
          has_table_privilege(current_user, ${userTable}, 'INSERT') as "userInsert",
          has_table_privilege(current_user, ${userTable}, 'SELECT') as "userSelect",
          has_table_privilege(current_user, ${verificationTable}, 'INSERT') as "verificationInsert"`,
        'objects',
      )
      .pipe(
        Effect.flatMap((rows) => Schema.decodeUnknownEffect(NativeRecipientSignupPreflightSchema)(rows[0])),
        Effect.map((observed) => ({ ...observed, preflightSucceeded: true })),
        Effect.catch(() => Effect.succeed(nativeRecipientSignupPreflightUnavailable)),
      );
    yield* Effect.logInfo('ENROLLMENT_SIGNUP_PREFLIGHT', {
      ...preflight,
      cryptoGetRandomValues: Schema.is(Schema.Struct({ getRandomValues: Schema.declare(Predicate.isFunction) }))(
        globalThis.crypto,
      ),
      cryptoPresent: Predicate.isObject(globalThis.crypto),
      cryptoSubtleDigest: Schema.is(
        Schema.Struct({ subtle: Schema.Struct({ digest: Schema.declare(Predicate.isFunction) }) }),
      )(globalThis.crypto),
    });
    const created = yield* Effect.tryPromise({
      catch: nativeRecipientSignupFailure,
      try: async () =>
        await auth.api.signUpEmail({
          body: { email, name: 'Native enrollment recipient', password },
          headers: { origin },
        }),
    });
    yield* Effect.tryPromise({
      catch: () => new Error('Native recipient verification issuance failed'),
      try: async () => await auth.api.sendVerificationEmail({ body: { email }, headers: { origin } }),
    });
    const token = tokens.at(-1);
    if (token === undefined) {
      return yield* Effect.die('Native recipient verification was not issued');
    }
    const reconciliation = yield* makeCommercePortalAuthRecoveryReconciliation().pipe(
      Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
    );
    const recovery = yield* makeCommercePortalAuthRecoveryService(
      makeCommercePortalAuthAuditRecorder(database.executor),
    ).pipe(
      Effect.provideService(CommercePortalAuthRecoveryProviderService, makeCommercePortalAuthRecoveryProvider(auth)),
      Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
      Effect.provideService(CommercePortalAuthRecoveryReconciliationService, reconciliation),
    );
    yield* recovery.verifyEmail({ token: Redacted.make(token) });
    const session = yield* Effect.tryPromise({
      catch: () => new Error('Native recipient session issuance failed'),
      try: async () => await auth.api.signInEmail({ asResponse: true, body: { email, password }, headers: { origin } }),
    });
    if (session.status !== 200) {
      return yield* Effect.die('Native recipient signin was refused');
    }
    const cookie = session.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    if (cookie.length === 0) {
      return yield* Effect.die('Native recipient session cookie was not issued');
    }
    return {
      cookie: Redacted.make(cookie),
      origin,
      providerSubjectId: created.user.id,
      secret,
      signOut: () =>
        Effect.tryPromise({
          catch: () => new Error('Native recipient session revocation failed'),
          try: async () => await auth.api.signOut({ headers: { cookie, origin } }),
        }),
    };
  },
);

class EnrollmentReceiverAcquisitionFailed extends Schema.TaggedError<EnrollmentReceiverAcquisitionFailed>()(
  'EnrollmentReceiverAcquisitionFailed',
  { code: Schema.Literals(['startup_timeout', 'early_exit', 'ready_missing']) },
) {}

const makeDefaultCurrentReceiver = Effect.fn('EnrollmentCurrent.makeDefaultReceiver')(
  function* makeDefaultCurrentReceiverEffect(
    native: Effect.Success<ReturnType<typeof makeOwnedEnrollmentCurrentAccessFixture>>,
    receiverArtifact: Effect.Success<ReturnType<typeof makeReceiverArtifact>>,
    recipientRealm?: Effect.Success<ReturnType<typeof makeEnrollmentRecipientRealm>>,
  ) {
    const receiverScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(receiverScope, exit));
    const acquired = yield* Effect.gen(function* acquireReceiver() {
      yield* parseResendEmailDeliveryConfig(receiverEmailEnvironment);
      yield* Effect.logInfo('ENROLLMENT_RECEIVER_PHASE: generating_keys');
      const keys = yield* Effect.promise(
        async () => await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
      );
      const jwk = yield* Effect.promise(async () => await exportJWK(keys.publicKey));
      const issuer = 'https://enrollment-current.ontos.test';
      const sourceContext = yield* Layer.build(NodeHttpServer.layerTest);
      const source = Context.get(sourceContext, HttpServer.HttpServer);
      yield* source.serve(
        Effect.succeed(HttpServerResponse.text(JSON.stringify(native.snapshot), { contentType: 'application/json' })),
      );
      if (!Schema.is(Schema.Struct({ port: Schema.Number }))(source.address)) {
        return yield* Effect.die('A composition source loopback address is required');
      }
      yield* Effect.logInfo('ENROLLMENT_RECEIVER_PHASE: source_ready');
      const environment = {
        ...receiverEmailEnvironment,
        APP_ENV_PATH: '/dev/null',
        ...native.fixture.permissionEnvironment,
        DATABASE_ADMIN_URL: native.connections.admin.connectionString,
        DATABASE_URL: native.connections.runtime.connectionString,
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${source.address.port}/active`,
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
          keys: [{ ...jwk, alg: 'EdDSA', kid: 'current-access', use: 'sig' }],
        }),
        SPICEDB_PRESHARED_KEY: Redacted.value(native.fixture.permissionEnvironment.SPICEDB_PRESHARED_KEY),
      };
      if (recipientRealm !== undefined) {
        Object.assign(environment, {
          COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: native.connections.admin.connectionString,
          COMMERCE_PORTAL_AUTH_DATABASE_URL: native.connections.runtime.connectionString,
          COMMERCE_PORTAL_AUTH_SECRET: Redacted.value(recipientRealm.secret),
          COMMERCE_PORTAL_AUTH_URL: recipientRealm.origin,
        });
      }
      const child = yield* ChildProcess.make(process.execPath, [receiverArtifact.artifact, '--serve'], {
        cwd: appRoot,
        env: environment,
        stderr: 'pipe',
        stdout: 'pipe',
      });
      yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
      yield* Effect.logInfo('ENROLLMENT_RECEIVER_PHASE: child_spawned');
      const firstLine = yield* Effect.raceFirst(
        child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
        child.exitCode.pipe(
          Effect.flatMap(() => Effect.fail(new EnrollmentReceiverAcquisitionFailed({ code: 'early_exit' }))),
        ),
      );
      if (Option.isNone(firstLine)) {
        return yield* new EnrollmentReceiverAcquisitionFailed({ code: 'ready_missing' });
      }
      const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiverReadySchema))(firstLine.value);
      expect(ready.marker).toEqual(receiverArtifact.marker);
      yield* Effect.logInfo('ENROLLMENT_RECEIVER_PHASE: ready');
      return { issuer, keys, ready };
    }).pipe(Effect.provideService(Scope.Scope, receiverScope));
    const { issuer, keys, ready } = acquired;
    const mounted = (
      path: string,
      body?:
        | RetailPortalProfileBindingReadRequest
        | CounterpartyCommerceAccessCheckRequest
        | { readonly claimProofReference: string; readonly invitationSecret: string },
      principal: typeof native.fixture.manager & { readonly legalEntityId?: string } = native.principal,
      cookie?: Redacted.Redacted,
    ) =>
      Effect.gen(function* invokeDefaultRetailRead() {
        const issuedAt = yield* native.clockEpoch();
        const assertion = yield* Effect.promise(
          async () =>
            await new SignJWT({
              compositionRevision: native.snapshot.composition.revision,
              principal,
              targetBuildMarker: receiverArtifact.marker.buildMarker,
              ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
            })
              .setProtectedHeader({ alg: 'EdDSA', kid: 'current-access', typ: 'JWT' })
              .setAudience('commerce-customer-context')
              .setIssuer(issuer)
              .setSubject(principal.principalId)
              .setIssuedAt(issuedAt)
              .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
              .setJti(randomUUID())
              .sign(keys.privateKey),
        );
        const claims = yield* Effect.try({ catch: fixtureClaimFailure, try: () => decodeJwt(assertion) });
        yield* decodeSupportedGatewayContextClaims(claims).pipe(Effect.mapError(fixtureClaimFailure));
        const headers = {
          authorization: `Bearer ${assertion}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
          origin: recipientRealm?.origin ?? issuer,
          'x-correlation-id': randomUUID(),
        };
        if (cookie !== undefined) {
          Object.assign(headers, { cookie: Redacted.value(cookie) });
        }
        return yield* Effect.promise(
          async () =>
            await fetch(`http://127.0.0.1:${ready.port}${path}`, {
              body: body === undefined ? undefined : JSON.stringify(body),
              headers,
              method: body === undefined ? 'GET' : 'POST',
            }),
        );
      });
    return Object.assign(mounted, { close: () => Scope.close(receiverScope, Exit.void) });
  },
);

const pendingRetail = Effect.gen(function* pendingRetailEffect() {
  const receiverArtifact = yield* makeReceiverArtifact();
  const baseSnapshot = yield* makeEnrollmentApplicationCompositionSnapshot(receiverArtifact.marker.buildMarker, []);
  const native = yield* makeOwnedEnrollmentCurrentAccessFixture(baseSnapshot);
  const coreEvidenceContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(native.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceContext));

  const transition = yield* Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: native.fixture.manager.principalId,
    compositionRevision: native.bindingInput.compositionRevision,
    correlationId: native.bindingInput.requestCorrelation,
    expectedRevision: 1,
    ownerInvocationId: randomUUID(),
    ownerModuleKey: 'commerce.customer-context',
    portalEnrollmentAttemptId: native.bindingInput.enrollmentEvidenceRef,
    requestDigest: 'b'.repeat(64),
    tenantId: native.fixture.tenantId,
    transitionKey: BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  });
  let pendingState: string | undefined;
  const outcome = yield* retailPortalBindingOwnerEffect(native.bindingInput, {
    bindProfile: (_payload, _correlation, options) =>
      native.bind(options.idempotencyKey).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            pendingState = result.authorizationState;
          }),
        ),
        Effect.mapError((failure) =>
          Object.defineProperty(
            new CommerceEnrollmentOwnerEffectUnavailable({
              code: 'native_binding_unavailable',
              reason: 'Native governed binding did not settle',
            }),
            'cause',
            { value: failure },
          ),
        ),
      ),
    commitResolution: () => Effect.die('Dispatch must not resolve an unrelated invocation'),
  }).dispatch(transition);
  const evidence = yield* native.fixture.evidence(coreEvidenceExecutor);
  expect(pendingState).toBe('PENDING_GRANT');
  expect(evidence.invocations.filter((row) => row.status === 'succeeded')).toHaveLength(1);
  expect(evidence.outbox).toHaveLength(1);
  expect(outcome.status).toBe('FAILED');
  expect(outcome.nextState).toBe('RECONCILIATION_REQUIRED');
  expect(yield* native.currentAccess()).toBe(false);
  const binding = yield* native.readBinding();
  if (Option.isNone(binding)) {
    return yield* Effect.die('Committed native binding is absent');
  }
  const reader = Context.get(native.context, ReadRuntime);
  const read = () =>
    reader
      .runRead({
        audience: 'commerce-customer-context',
        input: { bindingRef: binding.value.bindingRef, profileRef: native.bindingInput.profileRef },
        principal: native.principal,
        registration: retailPortalProfileBindingReadRead,
        transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
      })
      .pipe(Effect.provideContext(native.context));
  expect(Exit.isFailure(yield* Effect.exit(read()))).toBe(true);
  const { cycle, matched } = yield* native.cycle();
  expect(matched.deliveriesCreated).toBeGreaterThan(0);
  expect(cycle.failed).toBe(0);
  expect(cycle.succeeded).toBeGreaterThan(0);
  expect(yield* native.currentAccess()).toBe(true);
  const activatedTopic = 'commerce.customer-context.retail-portal-profile-binding-activated.v1';
  const completedEvidence = yield* native.fixture.evidence(coreEvidenceExecutor);
  const completedEvents = completedEvidence.events.filter((event) => event.eventType === activatedTopic);
  const completedMessages = completedEvidence.outbox.filter((message) => message.topic === activatedTopic);
  expect(completedEvents).toHaveLength(1);
  expect(completedEvents[0]?.actionInvocationId).toBe(evidence.invocations[0]?.actionInvocationId);
  expect(completedMessages).toHaveLength(1);
  expect(completedMessages[0]?.domainEventId).toBe(completedEvents[0]?.domainEventId);
  const completedBinding = yield* native.readBinding();
  const completedOwnerFacts = yield* native.ownerFactIdentities();
  expect(completedOwnerFacts.profile).toEqual(Option.some(native.bindingInput.profileRef));
  if (Option.isNone(completedBinding)) {
    return yield* Effect.die('The completed Retail binding is absent');
  }
  expect(completedOwnerFacts.binding).toEqual(Option.some(completedBinding.value.bindingRef));
  yield* native.restartWorker();
  const replayCycle = yield* native.cycle();
  expect(replayCycle.cycle.failed).toBe(0);
  const restartedEvidence = yield* native.fixture.evidence(coreEvidenceExecutor);
  expect(restartedEvidence.events.filter((event) => event.eventType === activatedTopic)).toEqual(completedEvents);
  expectSameCompletionReceipt(
    completedMessages,
    restartedEvidence.outbox.filter((message) => message.topic === activatedTopic),
  );
  expect(restartedEvidence.invocations).toEqual(completedEvidence.invocations);
  expect(yield* native.readBinding()).toEqual(completedBinding);
  expect(yield* native.ownerFactIdentities()).toEqual(completedOwnerFacts);
  expect(yield* native.currentAccess()).toBe(true);
  const access = Context.get(native.context, ContextAccess);
  const moduleAccess = () =>
    access.modules({
      legalEntityId: native.fixture.legalEntityId,
      moduleIds: ['commerce.customer-context'],
      principalId: native.principal.principalId,
      tenantId: native.fixture.tenantId,
    });
  expect((yield* moduleAccess()).map(({ decision, key }) => ({ decision, key }))).toEqual([
    { decision: 'denied', key: 'commerce.customer-context' },
  ]);
  expect(Schema.is(ReadPermissionDenied)(yield* read().pipe(Effect.flip))).toBe(true);
  const receiver = yield* makeDefaultCurrentReceiver(native, receiverArtifact).pipe(
    Effect.timeoutOrElse({
      duration: '15 seconds',
      orElse: () => Effect.fail(new EnrollmentReceiverAcquisitionFailed({ code: 'startup_timeout' })),
    }),
  );
  const mounted = () =>
    receiver('/reads/retail-portal-profile-binding-read', {
      bindingRef: binding.value.bindingRef,
      profileRef: native.bindingInput.profileRef,
    });
  const missingModuleAccess = yield* mounted();
  expect(missingModuleAccess.status).toBe(403);
  // This public fixture prerequisite supplies the separate module gate, never a Retail business permission.
  yield* native.fixture.grantResourceAccess(native.bindingInput.profileRef, native.principal.principalId);
  expect((yield* moduleAccess()).map(({ decision, key }) => ({ decision, key }))).toEqual([
    { decision: 'allowed', key: 'commerce.customer-context' },
  ]);
  expect(
    Match.value(yield* read()).pipe(
      Match.tag('BINDING_AVAILABLE', (response) => response.completeness === 'FULL'),
      Match.tag('BINDING_RECONCILIATION_REQUIRED', () => false),
      Match.exhaustive,
    ),
  ).toBe(true);
  const after = yield* mounted();
  expect(after.status).toBe(200);
  const publicBody = yield* Schema.decodeUnknownEffect(RetailPortalProfileBindingReadResponseSchema)(
    yield* Effect.promise(async () => await after.json()),
  );
  expect(
    Match.value(publicBody).pipe(
      Match.tag('BINDING_AVAILABLE', (response) => response.completeness === 'FULL'),
      Match.tag('BINDING_RECONCILIATION_REQUIRED', () => false),
      Match.exhaustive,
    ),
  ).toBe(true);
  const relationships = Context.get(native.context, BusinessPermissionRelationshipMutation);
  yield* relationships.mutate({
    operation: 'revoke',
    permission: 'retail.profile.read',
    principal: { principalId: native.principal.principalId, tenantId: native.fixture.tenantId },
    target: {
      kind: 'retail_profile',
      legalEntityId: native.fixture.legalEntityId,
      profileId: native.bindingInput.profileRef.resourceId,
      tenantId: native.fixture.tenantId,
    },
  });
  expect(yield* native.currentAccess()).toBe(false);
  expect(Schema.is(ReadPermissionDenied)(yield* read().pipe(Effect.flip))).toBe(true);
  expect((yield* mounted()).status).toBe(403);
  return yield* Effect.void;
});

const pendingInvitation = Effect.gen(function* pendingInvitationEffect() {
  const capture = makeCapturingCounterpartyInvitationProofDelivery();
  const receiverArtifact = yield* makeReceiverArtifact();
  const baseSnapshot = yield* makeEnrollmentApplicationCompositionSnapshot(receiverArtifact.marker.buildMarker, []);
  const owned = yield* makeOwnedEnrollmentCurrentAccessDatabase(baseSnapshot);
  const recipientRealm = yield* makeEnrollmentRecipientRealm(owned);
  const preparedNative = yield* makeEnrollmentCurrentAccessFixture({
    compositionRevision: owned.snapshot.composition.revision,
    connections: owned.connections,
    managerProviderSubjectId: recipientRealm.providerSubjectId,
  }).pipe(Effect.provide(capture.live));
  const native = { ...preparedNative, snapshot: owned.snapshot };
  const coreEvidenceContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(native.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceContext));

  const invitation = yield* prepareEnrollmentCurrentAccessInvitation(native);
  const started = yield* runAction({
    payload: {
      intentDigest: '8'.repeat(64),
      intentKey: randomUUID(),
      invitationId: invitation.created.invitation.invitationRef.resourceId,
      journey: 'COUNTERPARTY_INVITATION',
      targetLegalEntityId: native.fixture.legalEntityId,
    },
    principal: native.fixture.manager,
    registration: startPortalEnrollmentAction,
    transport: {
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      targetModuleKey: 'commerce.customer-context',
    },
  }).pipe(Effect.provideContext(native.context));
  const attemptId = started.attempt.portalEnrollmentAttemptId;
  const store = commerceEnrollmentOwnerAttemptStoreForRun(
    { legalEntityId: native.fixture.legalEntityId, tenantId: native.fixture.tenantId },
    native.run,
  );
  let { attempt } = started;
  // Provider/Core binding entries are genuine generic journal fixture prerequisites, not remote producer proof.
  for (const step of counterpartyInvitationJourneyDefinition.requiredTransitions.slice(0, 3)) {
    const identity = {
      actorPrincipalId: native.fixture.manager.principalId,
      ownerInvocationId: randomUUID(),
      ownerModuleKey: step.ownerModuleKey,
      portalEnrollmentAttemptId: attemptId,
      requestDigest: '9'.repeat(64),
      tenantId: native.fixture.tenantId,
      transitionKey: step.transitionKey,
    };
    const claimed = yield* store.claimTransition(
      yield* Schema.decodeEffect(ClaimEnrollmentTransitionInputSchema)({
        ...identity,
        expectedRevision: attempt.revision,
        leaseDurationMs: 30_000,
        required: true,
        workerId: 'fixture-prerequisites',
      }),
    );
    if (claimed.outcome !== 'CLAIMED' || claimed.attempt.lease === undefined) {
      return yield* Effect.die('Native claim prerequisite unavailable');
    }
    const recorded = yield* store.recordOutcome(
      yield* Schema.decodeEffect(RecordEnrollmentOutcomeInputSchema)({
        ...identity,
        accountSubject: {
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          providerSubjectId: recipientRealm.providerSubjectId,
          subjectType: 'user',
        },
        expectedRevision: claimed.attempt.revision,
        leaseToken: claimed.attempt.lease.leaseToken,
        resultReference:
          step.ownerModuleKey === 'core.identity'
            ? native.fixture.manager.authBindingId
            : recipientRealm.providerSubjectId,
        status: 'SUCCEEDED',
        workerId: 'fixture-prerequisites',
      }),
    );
    expect(recorded.attempt.state).not.toBe('COMPLETE');
    ({ attempt } = recorded);
  }
  const delivered = capture.staged.at(-1);
  if (delivered === undefined) {
    return yield* Effect.die('Native committed invitation proof delivery unavailable');
  }
  const transition = yield* Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: native.fixture.manager.principalId,
    compositionRevision: native.bindingInput.compositionRevision,
    correlationId: native.bindingInput.requestCorrelation,
    expectedRevision: attempt.revision,
    ownerInvocationId: retailSelfEnrollmentEvidenceReference([
      'commerce.portal-enrollment.invitation-claim.owner-invocation',
      native.fixture.tenantId,
      attemptId,
      'counterparty-access-invitation.claim',
    ]),
    ownerModuleKey: 'commerce.customer-context',
    portalEnrollmentAttemptId: attemptId,
    requestDigest: enrollmentDigest(
      [
        'commerce.customer-context',
        'counterparty-access-invitation.claim',
        attemptId,
        invitation.created.invitation.invitationRef.resourceId,
      ].join('\u0000'),
    ),
    tenantId: native.fixture.tenantId,
    transitionKey: 'counterparty-access-invitation.claim',
  });
  const claim = yield* store.claimTransition(
    yield* Schema.decodeEffect(ClaimEnrollmentTransitionInputSchema)({
      ...transition,
      leaseDurationMs: 30_000,
      required: true,
      workerId: 'native-claim-worker',
    }),
  );
  if (claim.outcome !== 'CLAIMED' || claim.attempt.lease === undefined) {
    return yield* Effect.die('The affected claim was not durably fenced');
  }
  let actualOwnerOutcome: string | undefined;
  const outcome = yield* claimInvitationEffect(
    {
      crypto: invitation.crypto,
      run: native.run,
      trustedScope: { ...native.principal, correlationId: transition.correlationId },
    },
    {
      claimProofReference: delivered.claimProofReference,
      invitationId: invitation.created.invitation.invitationRef.resourceId,
      secret: Redacted.make(delivered.secret),
    },
    (payload) =>
      runAction({
        payload,
        principal: native.principal,
        registration: claimCounterpartyAccessInvitationAction,
        transport: {
          correlationId: transition.correlationId,
          idempotencyKey: transition.ownerInvocationId,
          targetModuleKey: 'commerce.customer-context',
        },
      }).pipe(
        Effect.provideContext(native.context),
        Effect.tap((result) =>
          Effect.sync(() => {
            actualOwnerOutcome = result.outcome;
          }),
        ),
        Effect.mapError((failure) =>
          Object.defineProperty(
            new CommerceEnrollmentOwnerEffectUnavailable({
              code: 'native_claim_unavailable',
              reason: 'Native governed claim did not settle',
            }),
            'cause',
            { value: failure },
          ),
        ),
      ),
  ).pipe(Effect.provideContext(native.context));
  const reconcile = yield* counterpartyInvitationClaimReconciliationFor(native.run, {
    boundPrincipalId: native.fixture.manager.principalId,
    invitationId: invitation.created.invitation.invitationRef.resourceId,
    legalEntityId: native.fixture.legalEntityId,
    portalEnrollmentAttemptId: transition.portalEnrollmentAttemptId,
    tenantId: native.fixture.tenantId,
  }).pipe(Effect.provideContext(native.context));
  const resolution = yield* reconcile({ ...transition, observedRevision: 1, ownerOperationRevision: 1 });
  expect(actualOwnerOutcome).toBe('RECONCILIATION_REQUIRED');
  expect({ dispatch: outcome.status, recovery: resolution.status }).toEqual({ dispatch: 'FAILED', recovery: 'FAILED' });
  expect(outcome.nextState).toBe('RECONCILIATION_REQUIRED');
  const pending = yield* store.recordOutcome(
    yield* Schema.decodeEffect(RecordEnrollmentOutcomeInputSchema)({
      ...transition,
      ...outcome,
      expectedRevision: claim.attempt.revision,
      leaseToken: claim.attempt.lease.leaseToken,
      workerId: 'native-claim-worker',
    }),
  );
  expect(pending.attempt.state).toBe('RECONCILIATION_REQUIRED');
  let receiver = yield* makeDefaultCurrentReceiver(native, receiverArtifact, recipientRealm).pipe(
    Effect.timeoutOrElse({
      duration: '15 seconds',
      orElse: () => Effect.fail(new EnrollmentReceiverAcquisitionFailed({ code: 'startup_timeout' })),
    }),
  );
  yield* native.fixture.grantResourceAccess(native.bindingInput.profileRef, native.principal.principalId);
  const accessRequest = {
    counterpartyRef: invitation.counterpartyRef,
    permission: 'counterparty.profile.read' as const,
    scope: { kind: 'counterparty' as const },
  };
  const check = () =>
    receiver('/reads/counterparty-commerce-access-check', accessRequest).pipe(
      Effect.flatMap((response) => {
        expect(response.status).toBe(200);
        return Effect.promise(async () => await response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CounterpartyCommerceAccessCheckResponseSchema)),
        );
      }),
    );
  expect((yield* check()).decision).not.toBe('ALLOWED');
  const claimPath = `/api/portal-auth/enrollment/${attemptId}/claim-invitation`;
  // The original claim already committed. This different secret must never be reconsumed.
  const replayPayload = {
    claimProofReference: delivered.claimProofReference,
    invitationSecret: 'not-the-consumed-invitation-secret',
  };
  const withoutSession = yield* receiver(claimPath, replayPayload);
  expect(withoutSession.status).toBe(401);
  const wrongBinding = yield* receiver(
    claimPath,
    replayPayload,
    { ...native.fixture.reader, legalEntityId: native.fixture.legalEntityId },
    recipientRealm.cookie,
  );
  expect(wrongBinding.status).toBe(404);
  const wrongLegalEntity = yield* receiver(
    claimPath,
    replayPayload,
    { ...native.principal, legalEntityId: randomUUID() },
    recipientRealm.cookie,
  );
  expect(wrongLegalEntity.status).toBe(404);
  const foreign = yield* makeEnrollmentCurrentAccessFixture({
    compositionRevision: owned.snapshot.composition.revision,
    connections: owned.connections,
  }).pipe(Effect.provide(capture.live));
  const foreignTenant = yield* receiver(claimPath, replayPayload, foreign.principal, recipientRealm.cookie);
  expect(foreignTenant.status).toBe(404);
  const { cycle, matched } = yield* native.cycle();
  expect(matched.deliveriesCreated).toBeGreaterThan(0);
  expect(cycle.failed).toBe(0);
  expect(cycle.succeeded).toBeGreaterThan(0);
  // Revoke an exact baseline relationship while this accepted Attempt is still pending.
  const relationships = Context.get(native.context, BusinessPermissionRelationshipMutation);
  const claimPermission = {
    permission: 'counterparty.profile.read',
    principal: { principalId: native.principal.principalId, tenantId: native.fixture.tenantId },
    target: {
      counterpartyId: invitation.counterpartyRef.resourceId,
      kind: 'counterparty' as const,
      legalEntityId: native.fixture.legalEntityId,
      tenantId: native.fixture.tenantId,
    },
  };
  yield* relationships.mutate({ ...claimPermission, operation: 'revoke' });
  expect(
    (yield* store.read(
      yield* Schema.decodeEffect(ReadEnrollmentAttemptInputSchema)({
        portalEnrollmentAttemptId: attemptId,
        tenantId: native.fixture.tenantId,
      }),
    )).state,
  ).toBe('RECONCILIATION_REQUIRED');
  expect(
    (yield* reconcile({
      ...transition,
      observedRevision: pending.attempt.revision,
      ownerOperationRevision: pending.operation.revision,
    })).status,
  ).toBe('FAILED');
  expect((yield* check()).decision).toBe('DENIED');
  const mountedPending = yield* receiver(claimPath, replayPayload, native.principal, recipientRealm.cookie);
  expect(mountedPending.status).toBe(200);
  const mountedPendingProjection = yield* Schema.decodeUnknownEffect(
    CommercePortalAuthEnrollmentAttemptProjectionSchema,
  )(yield* Effect.promise(async () => await mountedPending.json()));
  expect(mountedPendingProjection.state).toBe('RECONCILIATION_REQUIRED');
  const currentPending = yield* store.read(
    yield* Schema.decodeEffect(ReadEnrollmentAttemptInputSchema)({
      portalEnrollmentAttemptId: attemptId,
      tenantId: native.fixture.tenantId,
    }),
  );
  expect(currentPending.revision).toBe(pending.attempt.revision);
  expect(transition.expectedRevision).toBeLessThan(currentPending.revision);
  const driver = commerceEnrollmentOwnerTransitionDriverFor({
    attempt: store,
    owner: {
      dispatch: () => Effect.die('An accepted claim must never dispatch the secret again'),
      reconcile,
    },
  });
  const staleRevision = yield* driver
    .reconcile({ ...transition, expectedRevision: transition.expectedRevision })
    .pipe(Effect.flip);
  expect(Schema.is(CommerceEnrollmentAttemptConflict)(staleRevision)).toBe(true);
  expect(staleRevision.code).toBe('attempt_revision_conflict');
  const affectedGrantRefs = () =>
    native.fixture
      .prepareOwner(
        (transaction, scope) =>
          Effect.gen(function* readAffectedGrants() {
            const port = yield* counterpartyAccessPortForScopedTransaction(transaction, {
              ...scope,
              legalEntityId: native.fixture.legalEntityId,
            });
            const grants = yield* port.list({
              actor: { principalId: native.principal.principalId, tenantId: native.fixture.tenantId },
              counterpartyRef: invitation.counterpartyRef,
              legalEntityId: native.fixture.legalEntityId,
              recipient: { principalId: native.principal.principalId, tenantId: native.fixture.tenantId },
              scope: { kind: 'counterparty' },
            });
            const references: (typeof grants)[number]['grantRef'][] = [];
            for (const grant of grants) {
              references.push(grant.grantRef);
            }
            return EffectArray.sort(references, resourceReferenceOrder);
          }),
        'required',
      )
      .pipe(Effect.provideContext(native.context));
  const beforeReceivingRestartFacts = yield* native.ownerFactIdentities();
  const beforeReceivingRestartGrants = yield* affectedGrantRefs();
  // Reap the real receiver to join all detached work before opening a fresh live composition.
  // The same owned database, account and persisted session survive this receiving-process restart.
  yield* receiver.close();
  receiver = yield* makeDefaultCurrentReceiver(native, receiverArtifact, recipientRealm).pipe(
    Effect.timeoutOrElse({
      duration: '15 seconds',
      orElse: () => Effect.fail(new EnrollmentReceiverAcquisitionFailed({ code: 'startup_timeout' })),
    }),
  );
  // Restore only the exact legitimate relationship that the real claim worker just acknowledged.
  yield* relationships.mutate({ ...claimPermission, operation: 'grant' });
  const settled = yield* reconcile({ ...transition, observedRevision: 1, ownerOperationRevision: 1 });
  expect(settled.status).toBe('SUCCEEDED');
  expect(settled.resultReference).toBe(outcome.resultReference);
  const otherPrincipalRecovery = yield* counterpartyInvitationClaimReconciliationFor(native.run, {
    boundPrincipalId: native.fixture.reader.principalId,
    invitationId: invitation.created.invitation.invitationRef.resourceId,
    legalEntityId: native.fixture.legalEntityId,
    portalEnrollmentAttemptId: attemptId,
    tenantId: native.fixture.tenantId,
  }).pipe(Effect.provideContext(native.context));
  expect(
    (yield* otherPrincipalRecovery({
      ...transition,
      observedRevision: pending.attempt.revision,
      ownerOperationRevision: pending.operation.revision,
    })).status,
  ).toBe('FAILED');
  // The actual mounted recovery, not a substitute driver result, closes this same Attempt.
  const mountedComplete = yield* receiver(claimPath, replayPayload, native.principal, recipientRealm.cookie);
  expect(mountedComplete.status).toBe(200);
  const mountedCompleteProjection = yield* Schema.decodeUnknownEffect(
    CommercePortalAuthEnrollmentAttemptProjectionSchema,
  )(yield* Effect.promise(async () => await mountedComplete.json()));
  expect(mountedCompleteProjection.state).toBe('COMPLETE');
  const readInput = yield* Schema.decodeEffect(ReadEnrollmentAttemptInputSchema)({
    portalEnrollmentAttemptId: attemptId,
    tenantId: native.fixture.tenantId,
  });
  const completedAttempt = yield* store.read(readInput);
  const completedOperation = yield* store.readOwnerOperation(
    yield* Schema.decodeEffect(ReadEnrollmentOwnerOperationInputSchema)({
      ownerModuleKey: transition.ownerModuleKey,
      portalEnrollmentAttemptId: attemptId,
      tenantId: native.fixture.tenantId,
      transitionKey: transition.transitionKey,
    }),
  );
  if (completedOperation === undefined) {
    return yield* Effect.die('The original completed claim operation is missing');
  }
  expect(completedAttempt.portalEnrollmentAttemptId).toBe(attemptId);
  expect(completedAttempt.state).toBe('COMPLETE');
  expect(yield* native.ownerFactIdentities()).toEqual(beforeReceivingRestartFacts);
  expect(yield* affectedGrantRefs()).toEqual(beforeReceivingRestartGrants);

  expect((yield* check()).decision).toBe('ALLOWED');
  const wrongAttestation = yield* reconcile({
    ...transition,
    observedRevision: completedAttempt.revision,
    ownerOperationRevision: completedOperation.revision,
    ownerResultReference: yield* Schema.decodeEffect(EnrollmentResourceIdSchema)(randomUUID()),
  });
  expect(wrongAttestation.status).toBe('FAILED');
  expect(wrongAttestation.nextState).toBe('RECONCILIATION_REQUIRED');
  expect(wrongAttestation.resultReference).toBe(outcome.resultReference);
  const publicAttempt = yield* receiver(
    `/api/portal-auth/enrollment/${attemptId}`,
    undefined,
    native.principal,
    recipientRealm.cookie,
  );
  expect(publicAttempt.status).toBe(200);
  const publicProjection = yield* Schema.decodeUnknownEffect(CommercePortalAuthEnrollmentAttemptProjectionSchema)(
    yield* Effect.promise(async () => await publicAttempt.json()),
  );
  expect(publicProjection.state).toBe('COMPLETE');
  const beforeRestartGrants = yield* affectedGrantRefs();
  expect(beforeRestartGrants).toHaveLength(3);
  const beforeRestartFacts = yield* native.ownerFactIdentities();
  const beforeRestartEvidence = yield* native.fixture.evidence(coreEvidenceExecutor);
  const claimTopic = 'commerce.customer-context.counterparty-access-invitation-claimed.v1';
  const claimEvents = beforeRestartEvidence.events.filter((event) => event.eventType === claimTopic);
  const claimMessages = beforeRestartEvidence.outbox.filter((message) => message.topic === claimTopic);
  expect(claimEvents).toHaveLength(1);
  const originalClaimInvocation = beforeRestartEvidence.invocations.find(
    (invocation) => invocation.actionKey === claimCounterpartyAccessInvitationAction.descriptor.actionKey,
  );
  expect(originalClaimInvocation).toBeDefined();
  expect(claimEvents[0]?.actionInvocationId).toBe(originalClaimInvocation?.actionInvocationId);
  expect(claimMessages).toHaveLength(1);
  expect(claimMessages[0]?.domainEventId).toBe(claimEvents[0]?.domainEventId);
  yield* native.restartWorker();
  expect((yield* native.cycle()).cycle.failed).toBe(0);
  const afterRestartEvidence = yield* native.fixture.evidence(coreEvidenceExecutor);
  expect(afterRestartEvidence.events.filter((event) => event.eventType === claimTopic)).toEqual(claimEvents);
  expectSameCompletionReceipt(
    claimMessages,
    afterRestartEvidence.outbox.filter((message) => message.topic === claimTopic),
  );
  expect(yield* native.ownerFactIdentities()).toEqual(beforeRestartFacts);
  expect(yield* affectedGrantRefs()).toEqual(beforeRestartGrants);
  expect(capture.staged).toHaveLength(1);
  yield* recipientRealm.signOut();
  const staleSession = yield* receiver(claimPath, replayPayload, native.principal, recipientRealm.cookie);
  expect(staleSession.status).toBe(401);
  const terminal = yield* driver
    .reconcile({ ...transition, expectedRevision: completedAttempt.revision })
    .pipe(Effect.flip);
  expect(Schema.is(CommerceEnrollmentAttemptRejected)(terminal)).toBe(true);
  expect(terminal.code).toBe('attempt_terminal');
  expect(terminal.retryable).toBe(false);
  const unchanged = yield* store.read(readInput);
  expect(unchanged.state).toBe('COMPLETE');
  expect(unchanged.revision).toBe(completedAttempt.revision);
  expect(capture.staged).toHaveLength(1);
  const evidence = yield* native.fixture.evidence(coreEvidenceExecutor);
  expect(
    evidence.invocations.filter(
      (invocation) => invocation.actionKey === claimCounterpartyAccessInvitationAction.descriptor.actionKey,
    ),
  ).toHaveLength(1);
  expect(
    evidence.outbox.filter(
      (message) => message.topic === 'commerce.customer-context.counterparty-access-invitation-claimed.v1',
    ),
  ).toHaveLength(1);
  yield* relationships.mutate({
    operation: 'revoke',
    permission: 'counterparty.profile.read',
    principal: { principalId: native.principal.principalId, tenantId: native.fixture.tenantId },
    target: {
      counterpartyId: invitation.counterpartyRef.resourceId,
      kind: 'counterparty',
      legalEntityId: native.fixture.legalEntityId,
      tenantId: native.fixture.tenantId,
    },
  });
  expect((yield* check()).decision).toBe('DENIED');
  expect(
    (yield* reconcile({
      ...transition,
      observedRevision: completedAttempt.revision,
      ownerOperationRevision: completedOperation.revision,
    })).status,
  ).toBe('FAILED');
  return yield* Effect.void;
});

/** Unaffected provider/Party/profile journal entries are fixture preconditions, not remote producer proof. */
const durableRetailAttempt = Effect.gen(function* durableRetailAttemptEffect() {
  const receiverArtifact = yield* makeReceiverArtifact();
  const baseSnapshot = yield* makeEnrollmentApplicationCompositionSnapshot(receiverArtifact.marker.buildMarker, []);
  const owned = yield* makeOwnedEnrollmentCurrentAccessDatabase(baseSnapshot);
  const recipientRealm = yield* makeEnrollmentRecipientRealm(owned);
  const preparedNative = yield* makeEnrollmentCurrentAccessFixture({
    compositionRevision: owned.snapshot.composition.revision,
    connections: owned.connections,
    managerProviderSubjectId: recipientRealm.providerSubjectId,
  });
  const native = { ...preparedNative, snapshot: owned.snapshot };
  const started = yield* runAction({
    payload: {
      intentDigest: 'd'.repeat(64),
      intentKey: randomUUID(),
      journey: 'RETAIL_SELF_ENROLLMENT',
      targetLegalEntityId: native.fixture.legalEntityId,
    },
    principal: native.fixture.manager,
    registration: startPortalEnrollmentAction,
    transport: {
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      targetModuleKey: 'commerce.customer-context',
    },
  }).pipe(Effect.provideContext(native.context));
  const attemptId = started.attempt.portalEnrollmentAttemptId;
  const store = commerceEnrollmentOwnerAttemptStoreForRun(
    { legalEntityId: native.fixture.legalEntityId, tenantId: native.fixture.tenantId },
    native.run,
  );
  let { attempt } = started;
  for (const step of retailSelfEnrollmentStepPlan().filter(
    (plannedStep) => plannedStep.transitionKey !== BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  )) {
    const identity = {
      actorPrincipalId: native.fixture.manager.principalId,
      ownerInvocationId: randomUUID(),
      ownerModuleKey: step.ownerModuleKey,
      portalEnrollmentAttemptId: attemptId,
      requestDigest: 'e'.repeat(64),
      tenantId: native.fixture.tenantId,
      transitionKey: step.transitionKey,
    };
    const claimed = yield* store.claimTransition(
      yield* Schema.decodeEffect(ClaimEnrollmentTransitionInputSchema)({
        ...identity,
        expectedRevision: attempt.revision,
        leaseDurationMs: 30_000,
        required: true,
        workerId: 'fixture-prerequisites',
      }),
    );
    if (claimed.outcome !== 'CLAIMED' || claimed.attempt.lease === undefined) {
      return yield* Effect.die('The genuine journal prerequisite was not claimed');
    }
    const recorded = yield* store.recordOutcome(
      yield* Schema.decodeEffect(RecordEnrollmentOutcomeInputSchema)({
        ...identity,
        accountSubject: {
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          providerSubjectId: recipientRealm.providerSubjectId,
          subjectType: 'user',
        },
        expectedRevision: claimed.attempt.revision,
        leaseToken: claimed.attempt.lease.leaseToken,
        status: 'SUCCEEDED',
        workerId: 'fixture-prerequisites',
      }),
    );
    expect(recorded.attempt.state).not.toBe('COMPLETE');
    ({ attempt } = recorded);
  }
  const transition = yield* Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: native.fixture.manager.principalId,
    compositionRevision: native.bindingInput.compositionRevision,
    correlationId: randomUUID(),
    expectedRevision: attempt.revision,
    ownerInvocationId: randomUUID(),
    ownerModuleKey: 'commerce.customer-context',
    portalEnrollmentAttemptId: attemptId,
    requestDigest: 'f'.repeat(64),
    tenantId: native.fixture.tenantId,
    transitionKey: BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  });
  const owner = retailPortalBindingOwnerEffect(
    { ...native.bindingInput, enrollmentEvidenceRef: attemptId },
    {
      bindProfile: () =>
        native.bind(transition.ownerInvocationId, attemptId).pipe(
          Effect.mapError(
            () =>
              new CommerceEnrollmentOwnerEffectUnavailable({
                code: 'native_bind_unavailable',
                reason: 'The governed native binding failed',
              }),
          ),
        ),
      // The actual registry rebuilds commit resolution from this exact scoped owner row too.
      commitResolution: () =>
        native.readBinding().pipe(
          Effect.map((found) =>
            Option.isNone(found)
              ? ({ state: 'NOT_STARTED' } as const)
              : ({ result: found.value, state: 'COMMITTED' } as const),
          ),
          Effect.mapError(
            () =>
              new CommerceActionCommitResolutionFailed({
                code: 'commit_resolution_unavailable',
                reason: 'The exact native owner commit read failed',
              }),
          ),
        ),
      confirmCurrentBinding: () =>
        native.currentAccess(attemptId).pipe(
          Effect.mapError(
            () =>
              new CommerceActionCommitResolutionFailed({
                code: 'commit_resolution_unavailable',
                reason: 'The native Current read failed',
              }),
          ),
        ),
    },
  );
  const driver = commerceEnrollmentOwnerTransitionDriverFor({ attempt: store, owner });
  const pending = yield* driver.execute(transition);
  expect(pending.outcome).toBe('RECORDED');
  if (pending.outcome !== 'RECORDED') {
    return yield* Effect.die('The pending binding was not durably recorded');
  }
  expect(pending.recorded.attempt.state).toBe('RECONCILIATION_REQUIRED');
  expect(pending.recorded.operation.status).toBe('FAILED');
  const readInput = yield* Schema.decodeEffect(ReadEnrollmentAttemptInputSchema)({
    portalEnrollmentAttemptId: attemptId,
    tenantId: native.fixture.tenantId,
  });
  expect((yield* store.read(readInput)).state).toBe('RECONCILIATION_REQUIRED');
  const { cycle, matched } = yield* native.cycle();
  expect(matched.deliveriesCreated).toBeGreaterThan(0);
  expect(cycle.failed).toBe(0);
  expect(cycle.succeeded).toBeGreaterThan(0);
  expect(yield* native.currentAccess(attemptId)).toBe(true);
  const completed = yield* driver.reconcile({ ...transition, expectedRevision: pending.recorded.attempt.revision });
  expect(completed.outcome).toBe('RECORDED');
  if (completed.outcome !== 'RECORDED') {
    return yield* Effect.die('The same pending operation was not reconciled');
  }
  expect(completed.recorded.attempt.portalEnrollmentAttemptId).toBe(attemptId);
  expect(completed.recorded.operation.ownerInvocationId).toBe(transition.ownerInvocationId);
  expect(completed.recorded.attempt.state).toBe('COMPLETE');
  expect((yield* store.read(readInput)).state).toBe('COMPLETE');
  const receiver = yield* makeDefaultCurrentReceiver(native, receiverArtifact, recipientRealm).pipe(
    Effect.timeoutOrElse({
      duration: '15 seconds',
      orElse: () => Effect.fail(new EnrollmentReceiverAcquisitionFailed({ code: 'startup_timeout' })),
    }),
  );
  const response = yield* receiver(
    `/api/portal-auth/enrollment/${attemptId}`,
    undefined,
    native.principal,
    recipientRealm.cookie,
  );
  expect(response.status).toBe(200);
  const projection = yield* Schema.decodeUnknownEffect(CommercePortalAuthEnrollmentAttemptProjectionSchema)(
    yield* Effect.promise(async () => await response.json()),
  );
  expect(projection.state).toBe('COMPLETE');
  const forbidden = yield* receiver(`/api/portal-auth/enrollment/${attemptId}`, undefined, native.fixture.reader);
  expect(forbidden.status).toBe(404);
  return yield* Effect.void;
});

const nativeServices = Layer.merge(
  NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  Layer.merge(
    NodeCrypto.layer,
    Layer.succeed(CounterpartyInvitationProofDelivery, unavailableCounterpartyInvitationProofDelivery()),
  ),
);
it.live(
  'keeps a genuinely committed staged Retail binding pending',
  () => pendingRetail.pipe(Effect.provide(nativeServices)),
  60_000,
);
it.live(
  'reconciles the same durable Retail Attempt only after genuine worker Current access',
  () => durableRetailAttempt.pipe(Effect.provide(nativeServices)),
  60_000,
);
it.live(
  'keeps a native accepted invitation pending in dispatch and lost-response recovery',
  () => pendingInvitation.pipe(Effect.provide(nativeServices)),
  60_000,
);
