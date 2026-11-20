import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { splitSetCookieHeader, applySetCookies } from 'better-auth/cookies';
import { eq, like } from 'drizzle-orm';
import { Config, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { randomInt, randomUUID } from 'node:crypto';

import {
  CommercePortalAuthAccountCreationGatewayLive,
  CommercePortalAuthAccountCreationGatewayService,
  CommercePortalAuthAccountCreationProviderLive,
} from '../../../verticals/commerce-customer-context/api/portal-auth/provider/account-create.ts';
import {
  CommercePortalAuthInstance,
  makeCommercePortalAuth,
} from '../../../verticals/commerce-customer-context/api/portal-auth/provider/auth.ts';
import { ledgerProbeOver } from '../../../verticals/commerce-customer-context/api/portal-auth/provider/communications-ledger-probe.ts';
import {
  COMMERCE_PORTAL_AUTH_POLICY,
  parseCommercePortalAuthConfig,
} from '../../../verticals/commerce-customer-context/api/portal-auth/provider/config.ts';
import {
  COMMERCE_PORTAL_AUTH_MFA_POLICY,
  createCommercePortalAuthTwoFactorPlugin,
} from '../../../verticals/commerce-customer-context/api/portal-auth/provider/mfa/plugin.ts';
import { makeCommercePortalAuthRecoveryProvider } from '../../../verticals/commerce-customer-context/api/portal-auth/provider/recovery/provider-service.ts';
import {
  CommercePortalAuthRecoveryProviderService,
  CommercePortalAuthRecoveryReconciliationService,
  CommercePortalAuthRecoveryStoreService,
  makeCommercePortalAuthEmailDelivery,
  makeCommercePortalAuthRecoveryReconciliation,
  makeCommercePortalAuthRecoveryService,
} from '../../../verticals/commerce-customer-context/api/portal-auth/provider/recovery/index.ts';
import { unauditedCommercePortalAuthRecorder } from '../../../verticals/commerce-customer-context/src/portal-auth/audit/audit.ts';
import { CommercePortalAuthCommunicationOutcomeReader } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/communication-outcome-reader.ts';
import type { PortalAuthSourceOutcome } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/communication-outcome-reader.ts';
import { CommercePortalAuthProtectedHandoff } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/protected-handoff.ts';
import { verificationReplayLayer } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/verification-replay.ts';
import { CommercePortalAuthAccountLookupLive } from '../../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-account-lookup.ts';
import {
  CommercePortalAuthDatabase,
  makeCommercePortalAuthDatabase,
} from '../../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-database.ts';
import { makeCommercePortalAuthRecoveryStore } from '../../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-recovery-store.ts';
import {
  user,
  verification,
} from '../../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-tables.ts';
import { acquireOutlivingCleanup } from '../../../packages/core-runtime/tests/support/database.ts';
import type { AuthWorld } from './auth-communications-world.spec.mts';
import { cryptoLive, historyOfRequest, PORTAL_ORIGIN } from './auth-communications-world.spec.mts';

/**
 * TEST-ONLY real Better Auth realms of the Portal Auth e-mail flows. The Postgres realm is the deployment's own realm
 * (`makeCommercePortalAuth` over the `commerce_auth` schema) with its REAL recovery ledger and the Communications-routed
 * delivery installed behind the ledger registration, exactly where the transactional delivery sits today. The one-time code
 * realm is the real two-factor plugin over an in-memory adapter, as the Auth MFA suites build it.
 */

const SECRET = 's'.repeat(64);
const SignUpAnswerSchema = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
export const PASSWORD = 'P'.repeat(24);
export const REPLACEMENT_PASSWORD = 'R'.repeat(24);
const DATABASE_URL = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);

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

interface IssuedTokens {
  readonly reset: string[];
  readonly verification: string[];
}

/** One real Postgres realm of the world's Auth: ledger, provider and the Communications-routed delivery. */
export const makePostgresRealm = Effect.fn('AuthCommunicationsRealm.postgres')(function* makeRealm(
  world: AuthWorld,
  caseName: string,
) {
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* DATABASE_URL),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_URL: PORTAL_ORIGIN,
  });
  const database = yield* acquireOutlivingCleanup(makeCommercePortalAuthDatabase(configuration));
  const store = yield* makeCommercePortalAuthRecoveryStore(database.executor).pipe(Effect.provide(cryptoLive));
  // Auth's own Current lifecycle of a held issuance is read from this very ledger
  world.ledgerProbe.current = ledgerProbeOver(store);
  // the provider's callback data as the account owner's inbox would see it: only tests read it, to play that owner
  const issued: IssuedTokens = { reset: [], verification: [] };
  const tappedDelivery = {
    sendOTP: world.rawDelivery.sendOTP,
    sendResetPassword: (data: Parameters<typeof world.rawDelivery.sendResetPassword>[0]) => {
      issued.reset.push(data.token);
      return world.rawDelivery.sendResetPassword(data);
    },
    sendVerificationEmail: (data: Parameters<typeof world.rawDelivery.sendVerificationEmail>[0]) => {
      issued.verification.push(data.token);
      return world.rawDelivery.sendVerificationEmail(data);
    },
  };
  const emailDelivery = yield* makeCommercePortalAuthEmailDelivery(tappedDelivery).pipe(
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
  );
  const auth = yield* makeCommercePortalAuth({ configuration, databaseAdapter: database.adapter, emailDelivery });
  // the realm's own recovery service: the real Auth path that spends a verification or reset token
  const recovery = yield* makeCommercePortalAuthRecoveryService(unauditedCommercePortalAuthRecorder).pipe(
    Effect.provideService(CommercePortalAuthRecoveryProviderService, makeCommercePortalAuthRecoveryProvider(auth)),
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
    Effect.provideServiceEffect(
      CommercePortalAuthRecoveryReconciliationService,
      makeCommercePortalAuthRecoveryReconciliation().pipe(
        Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
      ),
    ),
  );
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
  return { accountOf, auth, configuration, database, email, emailDelivery, ip, issued, recovery, store };
});
export type PostgresRealm = Effect.Success<ReturnType<typeof makePostgresRealm>>;

/** What Communications proves about the message of one issuance, as the SOURCE learns it from the real outcome feed. */
export const outcomeOfIssuance = (world: AuthWorld, issuanceRef: string): Effect.Effect<PortalAuthSourceOutcome> =>
  Effect.gen(function* readOutcome() {
    const known = world.submissions.find(({ request }) => request.occurrence.occurrenceId === issuanceRef);
    if (known === undefined || known.submission.outcome !== 'DECIDED') {
      return 'NOT_SUBMITTED' as const;
    }
    const history = yield* historyOfRequest(world, known.submission.requestId);
    const statuses = history.feed.messages.map(({ status }) => status);
    if (
      statuses.length === 0 ||
      statuses.some((status) => status === 'SUPPRESSED' || status === 'HELD_UNPROVEN' || status === 'NO_MESSAGE')
    ) {
      return 'STOPPED' as const;
    }
    if (statuses.some((status) => status === 'PROVIDER_SUBMITTED' || status === 'INDETERMINATE')) {
      return 'UNCERTAIN' as const;
    }
    if (statuses.some((status) => status === 'FAILED')) {
      return 'NON_ACCEPTANCE_PROVEN' as const;
    }
    return statuses.every((status) => status === 'PREPARED') ? ('IN_PROGRESS' as const) : ('ACCEPTED' as const);
  }).pipe(Effect.orDie);

/** An account of the realm, created through the provider's own sign-up (no enrollment), and its subject id. */
export const signUp = Effect.fn('AuthCommunicationsRealm.signUp')(function* signUpAccount(
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

/** The enrollment account-creation gateway over the realm, with the verification replay rule installed (or not). */
export const makeEnrollmentGateway = Effect.fn('AuthCommunicationsRealm.gateway')(function* makeGateway(
  world: AuthWorld,
  realm: PostgresRealm,
  options: { readonly withReplay: boolean },
) {
  const lookupLive = CommercePortalAuthAccountLookupLive.pipe(
    Layer.provide(Layer.succeed(CommercePortalAuthDatabase, realm.database)),
  );
  const outcomes = Layer.succeed(CommercePortalAuthCommunicationOutcomeReader, {
    outcomeOf: ({ issuanceRef }) => outcomeOfIssuance(world, issuanceRef),
  });
  const replay = verificationReplayLayer.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(CommercePortalAuthProtectedHandoff, world.handoff), outcomes, cryptoLive),
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

/** The one-time code realm: the real two-factor plugin over an in-memory adapter, delivering through the world's Auth. */
export const makeOtpRealm = (world: AuthWorld) => {
  const database = { account: [], session: [], twoFactor: [], user: [], verification: [] };
  // the provider's callback data as the account owner's inbox would see it: only tests read it, to play that owner
  const issued: string[] = [];
  const tappedSendOtp: typeof world.rawDelivery.sendOTP = (data, context) => {
    issued.push(data.otp);
    return world.rawDelivery.sendOTP(data, context);
  };
  const auth = betterAuth({
    advanced: { cookiePrefix: COMMERCE_PORTAL_AUTH_POLICY.cookie.namePrefix },
    basePath: '/api/portal-auth',
    baseURL: PORTAL_ORIGIN,
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [
      createCommercePortalAuthTwoFactorPlugin({
        policy: COMMERCE_PORTAL_AUTH_MFA_POLICY,
        sendOTP: tappedSendOtp,
      }),
    ],
    secret: SECRET,
    trustedOrigins: [PORTAL_ORIGIN],
  });
  const ip = nextIp();
  const email = `auth-comm-otp-${randomUUID()}@example.test`;
  const cookieOf = (response: Response) => {
    const headers = headersOf(ip);
    applySetCookies(headers, splitSetCookieHeader(response.headers.get('set-cookie') ?? ''));
    return headers;
  };
  const post = (route: string, body: Readonly<Record<string, string>>, cookie?: string) =>
    Effect.promise(
      async () =>
        await auth.handler(
          new Request(`${PORTAL_ORIGIN}/api/portal-auth${route}`, {
            body: JSON.stringify(body),
            headers: headersOf(ip, cookie),
            method: 'POST',
          }),
        ),
    );
  /** Sign up, enable the one-time-code factor, sign out and sign in again: the pending second step the code is sent for. */
  const pendingChallenge = Effect.gen(function* challenge() {
    const created = yield* post('/sign-up/email', {
      email,
      name: 'Auth communications OTP fixture',
      password: PASSWORD,
    });
    const enabled = yield* post(
      '/two-factor/enable',
      { method: 'otp', password: PASSWORD },
      cookieOf(created).get('cookie') ?? undefined,
    );
    yield* Effect.promise(async () => await auth.api.signOut({ headers: cookieOf(enabled) }));
    const signIn = yield* Effect.promise(
      async () =>
        await auth.api.signInEmail({
          body: { email, password: PASSWORD },
          headers: headersOf(ip),
          returnHeaders: true,
        }),
    );
    const headers = headersOf(ip);
    applySetCookies(headers, splitSetCookieHeader(signIn.headers.get('set-cookie') ?? ''));
    const subject = yield* Effect.promise(async () => await created.clone().text()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SignUpAnswerSchema))),
    );
    return { headers, subjectId: subject.user.id };
  });
  return { auth, database, email, ip, issued, pendingChallenge };
};
export type OtpRealm = ReturnType<typeof makeOtpRealm>;
