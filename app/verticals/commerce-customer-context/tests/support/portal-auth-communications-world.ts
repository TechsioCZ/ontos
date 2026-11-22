import { BindPreVerificationSubjectResultSchema } from '@app/privacy/actions/bind-pre-verification-subject';
import { NodeCrypto } from '@effect/platform-node';
import { splitSetCookieHeader, applySetCookies } from 'better-auth/cookies';
import { and, eq, inArray, isNotNull, like } from 'drizzle-orm';
import { Config, Context, Crypto, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  CommercePortalAuthAccountCreationGatewayLive,
  CommercePortalAuthAccountCreationGatewayService,
  CommercePortalAuthAccountCreationProviderLive,
} from '../../api/portal-auth/provider/account-create.ts';
import { CommercePortalAuthInstance, CommercePortalAuthLive } from '../../api/portal-auth/provider/auth.ts';
import type { CommercePortalAuthEmailDelivery } from '../../api/portal-auth/provider/auth.ts';
import { CommercePortalAuthCommunicationsEmailLive } from '../../api/portal-auth/provider/communications-email-delivery.ts';
import { ledgerProbeOver } from '../../api/portal-auth/provider/communications-ledger-probe.ts';
import { CommercePortalAuthConfig, parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { CommercePortalAuthEmailDeliveryService } from '../../api/portal-auth/provider/email-delivery-service.ts';
import { CommercePortalAuthRawEmailDeliveryService } from '../../api/portal-auth/provider/raw-email-delivery-service.ts';
import { CommercePortalAuthEmailDeliveryLive } from '../../api/portal-auth/provider/recovery/email-delivery.ts';
import { CommercePortalAuthRecoveryProviderLive } from '../../api/portal-auth/provider/recovery/provider-service.ts';
import { CommercePortalAuthRecoveryReconciliationServiceLive } from '../../api/portal-auth/provider/recovery/reconciliation.ts';
import {
  CommercePortalAuthRecoveryService,
  CommercePortalAuthRecoveryServiceLive,
} from '../../api/portal-auth/provider/recovery/service.ts';
import { CommercePortalAuthRecoveryStoreService } from '../../api/portal-auth/provider/recovery/store-service.ts';
import type { CommercePortalAuthRecoveryStore } from '../../api/portal-auth/provider/recovery/store-service.ts';
import { CommercePortalAuthAudit, unauditedCommercePortalAuthRecorder } from '../../src/portal-auth/audit/audit.ts';
import { CommercePortalAuthCommunicationOutcomeReader } from '../../src/portal-auth/communications/communication-outcome-reader.ts';
import type { PortalAuthSourceOutcome } from '../../src/portal-auth/communications/communication-outcome-reader.ts';
import { CommercePortalAuthCommunicationRequestSubmitter } from '../../src/portal-auth/communications/communication-request-submitter.ts';
import type { CommunicationRequestSubmitterService } from '../../src/portal-auth/communications/communication-request-submitter.ts';
import { CommercePortalAuthCommunicationStore } from '../../src/portal-auth/communications/communication-store.ts';
import { CommercePortalAuthIssuedFacts } from '../../src/portal-auth/communications/issued-facts.ts';
import type { IssuedFactsService } from '../../src/portal-auth/communications/issued-facts.ts';
import {
  CommercePortalAuthOwnerSlotCompletion,
  ownerSlotCompletionLayer,
} from '../../src/portal-auth/communications/owner-completion.ts';
import {
  CommercePortalAuthPreVerificationPrivacyBinding,
  privacyPreVerificationBindingLayer,
  unsupportedPreVerificationPrivacyBindingLayer,
} from '../../src/portal-auth/communications/pre-verification-privacy-binding.ts';
import { CommercePortalAuthPreVerificationPrivacyTransport } from '../../src/portal-auth/communications/pre-verification-privacy-transport.ts';
import type { PreVerificationPrivacyTransportService } from '../../src/portal-auth/communications/pre-verification-privacy-transport.ts';
import {
  CommercePortalAuthProtectedHandoff,
  protectedHandoffLayer,
} from '../../src/portal-auth/communications/protected-handoff.ts';
import type {
  IssuanceLedgerProbe,
  ProtectedHandoffService,
} from '../../src/portal-auth/communications/protected-handoff.ts';
import { protectedValueSealerLayer } from '../../src/portal-auth/communications/protected-value.ts';
import { relayCommunicationRequests } from '../../src/portal-auth/communications/request-relay.ts';
import { CommercePortalAuthTrustedScope } from '../../src/portal-auth/communications/trusted-scope.ts';
import { verificationReplayLayer } from '../../src/portal-auth/communications/verification-replay.ts';
import { CommercePortalAuthAccountLookupLive } from '../../src/portal-auth/persistence/portal-auth-account-lookup.ts';
import { CommercePortalAuthCommunicationStoreLive } from '../../src/portal-auth/persistence/portal-auth-communication-store.ts';
import {
  CommercePortalAuthDatabase,
  CommercePortalAuthDatabaseLive,
} from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { CommercePortalAuthRecoveryStoreLive } from '../../src/portal-auth/persistence/portal-auth-recovery-store.ts';
import {
  communicationIssuance,
  communicationRequestOutbox,
  session,
  user,
  verification,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';

/**
 * PUBLISHED TEST-ONLY seam (`@app/commerce-customer-context/testing/portal-auth-communications`) of the Portal Auth realm as the
 * SOURCE of its three e-mail flows (#1406). Everything here is the REAL Auth source: the Better Auth realm callbacks over the
 * deployment's own `commerce_auth` schema, the recovery ledger, the Communications-routed delivery, the protected handoff with
 * its sealed values in Auth's own PostgreSQL store (D2), the Auth-local outbox and its relay (D1), the owner-slot completion and
 * the enrollment gateway. It knows no Communications code: the relay submits through whatever submitter the suite hands it.
 *
 * The pre-verification Privacy binding is composed in one of three ways:
 * - `privacyTransport`: Auth's REAL production binding (Privacy's public bind Action, read with Privacy's published result
 *   schema) over the transport the suite hands it, so the suite can put the REAL Privacy owner behind it;
 * - LABELLED DOUBLE (the default, `evidencing` true): a FICTIONAL binding in the shape of Privacy's published bind result,
 *   never Privacy evidence;
 * - `evidencing: false`: Auth's composition without a transport to Privacy (D1), so no scope is declared.
 */

export { CommercePortalAuthAccountCreationUnavailable } from '../../api/portal-auth/provider/account-creation-unavailable.ts';
export { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
export { COMMERCE_PORTAL_AUTH_MFA_POLICY } from '../../api/portal-auth/provider/mfa/plugin.ts';
export {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
export {
  PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
  PORTAL_AUTH_EMAIL_FLOWS,
  PORTAL_AUTH_ISSUANCE_STATE,
  PORTAL_AUTH_RECIPIENT_ROLE,
  PORTAL_AUTH_RESOURCE_TYPE,
  PortalAuthIssuanceRefSchema,
  portalAuthCommunicationPurposeOf,
  portalAuthOwnerRenderedSlotOf,
} from '../../shared/portal-auth-communications.ts';
export type { PortalAuthEmailFlow } from '../../shared/portal-auth-communications.ts';
export type { PortalAuthSourceOutcome } from '../../src/portal-auth/communications/communication-outcome-reader.ts';
export type {
  PortalAuthIntentSummary,
  PortalAuthSubmission,
} from '../../src/portal-auth/communications/communication-request-submitter.ts';
export { PortalAuthCommunicationUnavailable } from '../../src/portal-auth/communications/communication-unavailable.ts';
export type { PreVerificationPrivacyTransportService } from '../../src/portal-auth/communications/pre-verification-privacy-transport.ts';
export { PreVerificationPrivacyBindingUnavailable } from '../../src/portal-auth/communications/privacy-binding-unavailable.ts';
export {
  issuanceSourceStateOf,
  maskedAddressOf,
  originalEndpointOf,
} from '../../src/portal-auth/communications/owner-facts.ts';
export { fillOwnerRenderedSlots } from '../../src/portal-auth/communications/owner-completion.ts';
export type { IssuanceLedgerProbe } from '../../src/portal-auth/communications/protected-handoff.ts';
export { portalAuthCommunicationRequest } from '../../src/portal-auth/communications/request.ts';
export { user, verification } from '../../src/portal-auth/persistence/portal-auth-tables.ts';

/** The FICTIONAL realm secret every Auth "process" and realm of a suite shares. */
const REALM_SECRET = 's'.repeat(64);
export const PORTAL_ORIGIN = 'https://portal.example.test';
export const PASSWORD = 'P'.repeat(24);
export const REPLACEMENT_PASSWORD = 'R'.repeat(24);
const AUTH_DATABASE_URL = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);
const RELAY = { leaseMillis: 30_000, leaseOwner: 'auth-world-relay', limit: 16, maxRetryMillis: 1000, retryMillis: 0 };

const cryptoLive = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    digest: (algorithm, data) =>
      Effect.sync(() => new Uint8Array(createHash(algorithm.toLowerCase().replace('-', '')).update(data).digest())),
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
  }),
);

const realmConfiguration = Effect.gen(function* configuration() {
  return yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* AUTH_DATABASE_URL),
    COMMERCE_PORTAL_AUTH_SECRET: REALM_SECRET,
    COMMERCE_PORTAL_AUTH_URL: PORTAL_ORIGIN,
  });
});
/** The realm's own database over the given configuration: the owner's production layer. */
const realmDatabaseLayer = (configuration: typeof CommercePortalAuthConfig.Service) =>
  CommercePortalAuthDatabaseLive.pipe(Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration)));

/** The FICTIONAL binding the labelled double answers with, in the shape of Privacy's published bind result. */
const fictionalPrivacyBinding = (tenantId: string) => ({
  bindingRef: '00000000-0000-4000-8000-00000000b1d0',
  policy: { policyRef: 'fictional-policy', revision: 'fictional-r1' },
  scope: {
    controllerRef: 'fictional-controller',
    dataCategoryRefs: ['fictional:contact'],
    operation: 'FICTIONAL_SEND_AUTH_MESSAGE',
    processingScopeRef: { scopeId: 'fictional-scope', scopeType: 'privacy.processing-scope' },
    purposeRef: 'fictional-purpose',
    purposeVersionId: 'fictional-v1',
    recipientRefs: ['fictional.communications'],
    subjectRef: {
      moduleId: 'privacy.core',
      resourceId: '00000000-0000-4000-8000-00000000b1d0',
      resourceType: 'privacy.core.privacy-subject',
      tenantId,
    },
  },
  status: 'ACTIVE',
  validUntil: '2099-01-01T00:00:00.000Z',
});

/** The pre-verification Privacy binding of a source: Auth's real one over a transport, the labelled double, or none. */
const bindingLayerOf = (options: PortalAuthSourceOptions) => {
  if (options.privacyTransport !== undefined) {
    return privacyPreVerificationBindingLayer.pipe(
      Layer.provide(Layer.succeed(CommercePortalAuthPreVerificationPrivacyTransport, options.privacyTransport)),
    );
  }
  return options.evidencing === false
    ? unsupportedPreVerificationPrivacyBindingLayer
    : Layer.succeed(CommercePortalAuthPreVerificationPrivacyBinding, {
        // LABELLED DOUBLE of Privacy's bind Action: a FICTIONAL binding in Privacy's answer shape, never Privacy evidence
        bind: () =>
          Schema.decodeUnknownEffect(BindPreVerificationSubjectResultSchema)(
            fictionalPrivacyBinding(options.tenantId),
          ).pipe(Effect.orDie),
      });
};

export interface PortalAuthSourceOptions {
  /** Whether the labelled double of Privacy's bind Action evidences a binding. Default: yes. Ignored with `privacyTransport`. */
  readonly evidencing?: boolean | undefined;
  readonly ledgerProbe?: IssuanceLedgerProbe | undefined;
  /** The transport to Privacy's bind Action that Auth's REAL production binding runs over. Default: none (see `evidencing`). */
  readonly privacyTransport?: PreVerificationPrivacyTransportService | undefined;
  /** The Tenant the realm, its delivery and its relay serve. */
  readonly tenantId: string;
}

/**
 * The Auth side of a Portal Auth e-mail suite: one Auth "process" (its own pool, store, sealed handoff and slot completion),
 * the Communications-routed delivery the realms install, and one relay tick over the Auth-local outbox. A realm that owns a
 * real recovery ledger installs its probe and its store here. `restart` replaces the process with a fresh one over the same
 * database (D2). The rows the Tenant left in the shared realm database are removed after it, whatever happened.
 */
export const makePortalAuthSource = Effect.fn('PortalAuthCommunicationsSource.make')(function* makeSource(
  options: PortalAuthSourceOptions,
) {
  const { tenantId } = options;
  const ledgerProbe = {
    current: options.ledgerProbe ?? ((): ReturnType<IssuanceLedgerProbe> => Effect.succeed('CURRENT')),
  } satisfies { current: IssuanceLedgerProbe };
  const openProcess = Effect.gen(function* openAuthProcess() {
    const configuration = yield* realmConfiguration;
    // the pool lives in a scope of its own, so every cleanup registered after it can still use it
    const storage = yield* acquireOutlivingCleanup(
      Layer.build(CommercePortalAuthCommunicationStoreLive.pipe(Layer.provideMerge(realmDatabaseLayer(configuration)))),
    );
    const authDatabase = Context.get(storage, CommercePortalAuthDatabase);
    const store = Context.get(storage, CommercePortalAuthCommunicationStore);
    const storeLayers = Layer.merge(
      Layer.succeed(CommercePortalAuthCommunicationStore, store),
      protectedValueSealerLayer(configuration.secret).pipe(Layer.provide(NodeCrypto.layer)),
    );
    const handoff = yield* CommercePortalAuthProtectedHandoff.pipe(
      Effect.provide(protectedHandoffLayer((held) => ledgerProbe.current(held)).pipe(Layer.provide(storeLayers))),
    );
    const completion = yield* CommercePortalAuthOwnerSlotCompletion.pipe(
      Effect.provide(
        ownerSlotCompletionLayer.pipe(Layer.provide(Layer.succeed(CommercePortalAuthProtectedHandoff, handoff))),
      ),
    );
    return { authDatabase, completion, handoff, store };
  });
  const auth = { process: yield* openProcess };
  const firstProcess = auth.process;
  yield* Effect.addFinalizer(() =>
    firstProcess.authDatabase.executor
      .select({ issuanceRef: communicationRequestOutbox.issuanceRef })
      .from(communicationRequestOutbox)
      .where(eq(communicationRequestOutbox.tenantId, tenantId))
      .pipe(
        Effect.flatMap((rows) => {
          const refs = rows.map(({ issuanceRef }) => issuanceRef);
          return refs.length === 0
            ? Effect.void
            : firstProcess.authDatabase.executor
                .delete(communicationRequestOutbox)
                .where(inArray(communicationRequestOutbox.issuanceRef, refs))
                .pipe(
                  Effect.andThen(
                    firstProcess.authDatabase.executor
                      .delete(communicationIssuance)
                      .where(inArray(communicationIssuance.issuanceRef, refs)),
                  ),
                );
        }),
        Effect.ignore,
      ),
  );
  const restart = openProcess.pipe(
    Effect.tap((fresh) =>
      Effect.sync(() => {
        auth.process = fresh;
      }),
    ),
    Effect.asVoid,
  );
  const binding = yield* CommercePortalAuthPreVerificationPrivacyBinding.pipe(Effect.provide(bindingLayerOf(options)));

  /** The realm's real recovery store, set once its realm exists: the delivery reads Auth's stored expiry and one-time code challenge from it. */
  const recoveryStore = yield* Ref.make(Option.none<CommercePortalAuthRecoveryStore>());
  const throughRealmStore = <Value, Failure>(
    read: (store: CommercePortalAuthRecoveryStore) => Effect.Effect<Value, Failure>,
  ) =>
    Ref.get(recoveryStore).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.die('no Portal Auth realm is bound to the world'), onSome: read }),
      ),
    );
  const delegatingStore = {
    locateOtpChallenge: (input) => throughRealmStore((store) => store.locateOtpChallenge(input)),
    peekEmailVerificationLedger: (input) => throughRealmStore((store) => store.peekEmailVerificationLedger(input)),
    peekPasswordResetLedger: (input) => throughRealmStore((store) => store.peekPasswordResetLedger(input)),
  } satisfies IssuedFactsService;
  const rawDelivery = yield* CommercePortalAuthRawEmailDeliveryService.pipe(
    Effect.provide(
      CommercePortalAuthCommunicationsEmailLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CommercePortalAuthProtectedHandoff, auth.process.handoff),
            Layer.succeed(CommercePortalAuthTrustedScope, { current: Effect.succeed({ tenantId }) }),
            Layer.succeed(CommercePortalAuthIssuedFacts, delegatingStore),
            cryptoLive,
          ),
        ),
      ),
    ),
  );

  return {
    binding,
    /** The owner-slot completion of the CURRENT Auth process. */
    get completion() {
      return auth.process.completion;
    },
    /** The protected handoff of the CURRENT Auth process. */
    get handoff() {
      return auth.process.handoff;
    },
    ledgerProbe,
    /** The Auth-local outbox rows of the Tenant, as Auth's runtime role reads them. */
    outboxRows: Effect.suspend(() =>
      auth.process.authDatabase.executor
        .select()
        .from(communicationRequestOutbox)
        .where(eq(communicationRequestOutbox.tenantId, tenantId)),
    ),
    rawDelivery,
    recoveryStore,
    /** ONE relay tick over the Auth-local outbox of the current Auth process, through the given transport. */
    relayThrough: (submitter: CommunicationRequestSubmitterService) =>
      Effect.suspend(() =>
        relayCommunicationRequests({ ...RELAY, tenantId }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(CommercePortalAuthCommunicationStore, auth.process.store),
              Layer.succeed(CommercePortalAuthCommunicationRequestSubmitter, submitter),
            ),
          ),
        ),
      ),
    restart,
  };
});

/**
 * What a realm needs from the suite's Auth side: the ledger probe and store slots it fills, and the delivery it installs behind
 * the ledger registration (the source's `rawDelivery`, or a suite's tap over it that plays the account owner's inbox).
 */
interface PortalAuthRealmHost {
  readonly delivery: CommercePortalAuthEmailDelivery;
  readonly ledgerProbe: { current: IssuanceLedgerProbe };
  readonly recoveryStore: Ref.Ref<Option.Option<CommercePortalAuthRecoveryStore>>;
}

export const headersOf = (ip: string, cookie?: string) => {
  const headers = new Headers({ 'content-type': 'application/json', origin: PORTAL_ORIGIN, 'x-forwarded-for': ip });
  if (cookie !== undefined) {
    headers.set('cookie', cookie);
  }
  return headers;
};

/**
 * One address per realm (Better Auth keeps its sign-up budget per client address in the shared database), drawn from a
 * process-random start so suites running in parallel workers never share a budget row.
 */
let realmNumber = randomInt(1, 120);
const nextIp = () => {
  realmNumber += 1;
  return `198.51.100.${realmNumber % 250}`;
};

/**
 * One real Postgres realm of the suite's Auth: the deployment's own realm (`CommercePortalAuthLive` over the `commerce_auth`
 * schema) with its REAL recovery ledger and the Communications-routed delivery installed behind the ledger registration,
 * exactly where the transactional delivery sits today.
 */
export const makePostgresRealm = Effect.fn('PortalAuthCommunicationsRealm.postgres')(function* makeRealm(
  host: PortalAuthRealmHost,
  caseName: string,
) {
  const configuration = yield* realmConfiguration;
  // the pool lives in a scope of its own, so every cleanup registered after it can still use it
  const storage = yield* acquireOutlivingCleanup(
    Layer.build(
      CommercePortalAuthRecoveryStoreLive.pipe(
        Layer.provideMerge(realmDatabaseLayer(configuration)),
        Layer.provide(cryptoLive),
      ),
    ),
  );
  const database = Context.get(storage, CommercePortalAuthDatabase);
  const store = Context.get(storage, CommercePortalAuthRecoveryStoreService);
  // Auth's own Current lifecycle of a held issuance is read from this very ledger
  host.ledgerProbe.current = ledgerProbeOver(store);
  yield* Ref.set(host.recoveryStore, Option.some(store));
  // the deployment's realm over that database, delivering through the host's delivery behind the ledger registration, with
  // its own unaudited recovery service: the real Auth path that spends a verification or reset token
  const realm = yield* Layer.build(
    CommercePortalAuthRecoveryServiceLive.pipe(
      Layer.provide(
        Layer.merge(CommercePortalAuthRecoveryProviderLive, CommercePortalAuthRecoveryReconciliationServiceLive),
      ),
      Layer.provideMerge(CommercePortalAuthLive.pipe(Layer.provideMerge(CommercePortalAuthEmailDeliveryLive))),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CommercePortalAuthConfig, configuration),
          Layer.succeed(CommercePortalAuthDatabase, database),
          Layer.succeed(CommercePortalAuthRecoveryStoreService, store),
          Layer.succeed(CommercePortalAuthRawEmailDeliveryService, host.delivery),
          Layer.succeed(CommercePortalAuthAudit, unauditedCommercePortalAuthRecorder),
        ),
      ),
    ),
  );
  const auth = Context.get(realm, CommercePortalAuthInstance);
  const emailDelivery = Context.get(realm, CommercePortalAuthEmailDeliveryService);
  const recovery = Context.get(realm, CommercePortalAuthRecoveryService);
  const email = `auth-comm-${caseName}-${randomUUID()}@example.test`;
  const ip = nextIp();
  yield* Effect.addFinalizer(() =>
    Effect.all(
      [
        database.executor.delete(user).where(eq(user.email, email)),
        database.executor.delete(verification).where(like(verification.identifier, `%${email}%`)),
      ],
      { concurrency: 1 },
    ).pipe(Effect.orDie),
  );
  const accountOf = (address: string) =>
    database.executor.select({ id: user.id }).from(user).where(eq(user.email, address)).limit(1);
  return {
    accountOf,
    auth,
    configuration,
    database,
    email,
    emailDelivery,
    ip,
    recovery,
    store,
  };
});
export type PostgresRealm = Effect.Success<ReturnType<typeof makePostgresRealm>>;

/** An account of the realm, created through the provider's own sign-up (no enrollment), and its subject id. */
export const signUp = Effect.fn('PortalAuthCommunicationsRealm.signUp')(function* signUpAccount(
  realm: PostgresRealm,
  address: string = realm.email,
) {
  yield* Effect.promise(
    async () =>
      await realm.auth.api.signUpEmail({
        body: { email: address, name: 'Auth communications fixture', password: PASSWORD },
        headers: headersOf(realm.ip),
      }),
  );
  const [row] = yield* realm.accountOf(address);
  return yield* Option.match(Option.fromNullishOr(row), {
    onNone: () => Effect.die('the realm did not persist the account'),
    onSome: ({ id }) => Effect.succeed(id),
  });
});

export interface EnrollmentGatewayOptions {
  /** The protected handoff the verification replay rule reads. */
  readonly handoff: ProtectedHandoffService;
  /** What Communications proves about the message of one issuance, as the SOURCE learns it from the outcome feed. */
  readonly outcomeOf: (issuanceRef: string) => Effect.Effect<PortalAuthSourceOutcome>;
  readonly withReplay: boolean;
}

/** The enrollment account-creation gateway over the realm, with the verification replay rule installed (or not). */
export const makeEnrollmentGateway = Effect.fn('PortalAuthCommunicationsRealm.gateway')(function* makeGateway(
  realm: PostgresRealm,
  options: EnrollmentGatewayOptions,
) {
  const lookupLive = CommercePortalAuthAccountLookupLive.pipe(
    Layer.provide(Layer.succeed(CommercePortalAuthDatabase, realm.database)),
  );
  const outcomes = Layer.succeed(CommercePortalAuthCommunicationOutcomeReader, {
    outcomeOf: ({ issuanceRef }) => options.outcomeOf(issuanceRef),
  });
  const replay = verificationReplayLayer.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(CommercePortalAuthProtectedHandoff, options.handoff), outcomes, cryptoLive),
    ),
  );
  const gatewayLive = CommercePortalAuthAccountCreationGatewayLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        CommercePortalAuthAccountCreationProviderLive.pipe(
          Layer.provide(Layer.succeed(CommercePortalAuthInstance, realm.auth)),
        ),
        lookupLive,
        options.withReplay ? replay : Layer.empty,
      ),
    ),
  );
  return yield* CommercePortalAuthAccountCreationGatewayService.pipe(Effect.provide(gatewayLive));
});

/**
 * The one-time code flow of a realm: the REAL Portal Auth provider (the real two-factor plugin over the real Postgres schema).
 * The challenge Better Auth stores for each code is the very row Auth's Current-state read looks at.
 */
export const otpChallengeOf = (realm: PostgresRealm) => {
  const { auth, email, ip } = realm;
  const cookieOf = (responseHeaders: Headers) => {
    const headers = headersOf(ip);
    applySetCookies(headers, splitSetCookieHeader(responseHeaders.get('set-cookie') ?? ''));
    return headers;
  };
  const signIn = Effect.promise(
    async () =>
      await auth.api.signInEmail({
        body: { email, password: PASSWORD },
        headers: headersOf(ip),
        returnHeaders: true,
      }),
  );
  /** Sign up, verify the address, enable the one-time-code factor, sign out and sign in again: the pending second step the code is sent for. */
  const pendingChallenge = Effect.gen(function* challenge() {
    yield* Effect.promise(
      async () =>
        await auth.api.signUpEmail({
          body: { email, name: 'Auth communications OTP fixture', password: PASSWORD },
          headers: headersOf(ip),
        }),
    );
    // the realm requires a verified address before a sign-in; the verification flow is another suite's subject
    yield* realm.database.executor.update(user).set({ emailVerified: true }).where(eq(user.email, email));
    const [account] = yield* realm.accountOf(email);
    const first = yield* signIn;
    const enabled = yield* Effect.promise(
      async () =>
        await auth.api.enableTwoFactor({
          body: { password: PASSWORD },
          headers: cookieOf(first.headers),
          returnHeaders: true,
        }),
    );
    yield* Effect.promise(async () => await auth.api.signOut({ headers: cookieOf(enabled.headers) }));
    const second = yield* signIn;
    return { headers: cookieOf(second.headers), subjectId: account?.id ?? '' };
  });
  const authenticatedSessionCount = realm.database.executor
    .select({ id: session.id })
    .from(session)
    .innerJoin(user, eq(session.userId, user.id))
    .where(and(eq(user.email, email), isNotNull(session.authenticatedAt)))
    .pipe(Effect.map((rows) => rows.length));
  return { authenticatedSessionCount, pendingChallenge };
};
