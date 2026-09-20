import { APIError, betterAuth } from 'better-auth';
import type {
  Auth,
  BetterAuthOptions,
  DBAdapter,
  DBTransactionAdapter,
  GenericEndpointContext,
  Session,
  User,
} from 'better-auth';
import { isAPIError } from 'better-auth/api';
import type { OTPOptions } from 'better-auth/plugins/two-factor';
import { Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schema, flow } from 'effect';

import type { CommercePortalAuthConfigValue } from './config.ts';
import { COMMERCE_PORTAL_AUTH_POLICY, CommercePortalAuthConfig } from './config.ts';
import { CommercePortalAuthDatabase } from '../../../src/portal-auth/persistence/portal-auth-database.ts';
import { COMMERCE_PORTAL_AUTH_MFA_POLICY, createCommercePortalAuthTwoFactorPlugin } from './mfa/plugin.ts';
import type { CommercePortalAuthTwoFactorPlugin } from './mfa/plugin.ts';
import type { CommercePortalAuthDatabaseAdapter } from '../../../src/portal-auth/persistence/portal-auth-database-types.ts';
import { CommercePortalAuthEmailDeliveryService } from './email-delivery-service.ts';
import { COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH } from '../../../shared/deployment-paths.ts';

/**
 * Better Auth's callback is a foreign Promise boundary. The provider owns delivery, while the
 * callback data (including verification/reset tokens) stays inside that delivery implementation.
 */
export interface CommercePortalAuthEmailDelivery {
  readonly sendOTP: NonNullable<OTPOptions['sendOTP']>;
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- Better Auth owns this callback boundary.
  readonly sendResetPassword: (data: {
    readonly token: string;
    readonly url: string;
    readonly user: User;
  }) => Promise<void>;
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- Better Auth owns this callback boundary.
  readonly sendVerificationEmail: (data: {
    readonly token: string;
    readonly url: string;
    readonly user: User;
  }) => Promise<void>;
}

export interface CommercePortalAuthOptionsInput {
  readonly configuration: CommercePortalAuthConfigValue;
  /** The provider database module supplies its Better Auth adapter factory. */
  readonly databaseAdapter: CommercePortalAuthDatabaseAdapter;
  readonly emailDelivery: CommercePortalAuthEmailDelivery;
}

/**
 * The exact Better Auth options this realm is constructed with. Naming the shape keeps the
 * provider declaration portable: the two-factor plugin carries zod endpoint schemas, so an
 * inferred options type cannot be written into a declaration file without naming zod internals.
 */
export interface CommercePortalAuthOptions extends BetterAuthOptions {
  readonly plugins: CommercePortalAuthTwoFactorPlugin[];
}

/** The constructed Commerce portal realm, including the two-factor endpoints its plugin installs. */
export type CommercePortalAuth = Auth<CommercePortalAuthOptions>;

type SessionHookData = Session & {
  readonly banExpires?: Date | null;
  readonly banned?: boolean;
};

interface CommercePortalAuthCookieAttributes {
  readonly domain?: string;
  readonly httpOnly: boolean;
  readonly path: string;
  readonly sameSite: 'lax';
  readonly secure: boolean;
}

const epochMillis = (value: Date): number => {
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.toEpochMillis(date.value) : Number.NaN;
};

const absoluteSessionExpiryMillis = (createdAt: Date): number => {
  const date = DateTime.make(createdAt);
  return Option.isSome(date)
    ? DateTime.toEpochMillis(
        DateTime.add(date.value, {
          seconds: COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds,
        }),
      )
    : Number.NaN;
};

const isActiveProviderSession = (row: Pick<SessionHookData, 'createdAt' | 'expiresAt'>, now: number): boolean => {
  const createdAt = epochMillis(row.createdAt);
  const expiresAt = epochMillis(row.expiresAt);
  return Number.isFinite(createdAt) && Number.isFinite(expiresAt) && createdAt <= now && expiresAt > now;
};

const isBannedProviderUser = (row: Pick<SessionHookData, 'banExpires' | 'banned'>): boolean => {
  if (row.banned !== true) {
    return false;
  }
  if (row.banExpires === null || row.banExpires === undefined) {
    return true;
  }
  const banExpires = epochMillis(row.banExpires);
  return !Number.isFinite(banExpires) || banExpires > DateTime.toEpochMillis(DateTime.nowUnsafe());
};

const sessionExpiryAtPolicyBound = (session: Pick<SessionHookData, 'createdAt' | 'expiresAt'>): Date | null => {
  const createdAt = epochMillis(session.createdAt);
  const expiresAt = epochMillis(session.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    return null;
  }
  return DateTime.toDate(DateTime.makeUnsafe(Math.min(expiresAt, absoluteSessionExpiryMillis(session.createdAt))));
};

const databaseBridgeTimeout = Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.session.providerCallTimeoutMilliseconds);
const databaseBridgeTimeoutPolicy = Effect.timeoutOrElse({
  duration: databaseBridgeTimeout,
  orElse: () =>
    Effect.fail(
      new APIError('INTERNAL_SERVER_ERROR', {
        code: 'COMMERCE_AUTH_DATABASE_TIMEOUT',
        message: 'The Commerce portal authentication database operation timed out',
      }),
    ),
});
/**
 * The governed identity the private account-creation port carries on its own direct provider call.
 * Nothing here crosses a network: `auth.api.signUpEmail` is invoked in-process, Better Auth's
 * router is the only path that reads headers off the wire, and `/sign-up/email` is never mounted
 * publicly. Headers are the request-scoped channel a Better Auth database hook can read, and the
 * user-creation hook below is the first point inside the provider's own call that knows the subject
 * it has just committed.
 */
export const COMMERCE_PORTAL_ACCOUNT_CORRELATION_HEADERS = {
  attempt: 'x-commerce-portal-account-attempt',
  ownerInvocation: 'x-commerce-portal-account-owner-invocation',
  tenant: 'x-commerce-portal-account-tenant',
} as const;

const correlationUuid = Schema.String.check(Schema.isUUID());

/**
 * The governed identity one account creation is correlated by. The brands are the same ones the
 * private account-creation input carries, so a Tenant can never be read where an invocation is
 * meant. All three are decoded even though only the invocation reaches the account row: a call
 * carrying a partial or unusable triple is a broken port rather than an ordinary sign-up.
 */
const CommercePortalAuthAccountCreationCorrelationSchema = Schema.Struct({
  ownerInvocationId: correlationUuid.pipe(Schema.brand('ActionInvocationId')),
  portalEnrollmentAttemptId: correlationUuid.pipe(Schema.brand('EnrollmentAttemptId')),
  tenantId: correlationUuid.pipe(Schema.brand('TenantId')),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const databaseFailure = (cause: unknown): APIError =>
  Object.defineProperty(
    new APIError('INTERNAL_SERVER_ERROR', {
      code: 'COMMERCE_AUTH_DATABASE_FAILURE',
      message: 'The Commerce portal authentication database operation failed',
    }),
    'cause',
    { configurable: true, value: cause },
  );
const databaseTransactionFailure = (cause: unknown): APIError => (isAPIError(cause) ? cause : databaseFailure(cause));
const countActiveProviderSessions = (
  rows: readonly Pick<SessionHookData, 'createdAt' | 'expiresAt'>[],
  now: number,
): number => rows.reduce((count, row) => count + (isActiveProviderSession(row, now) ? 1 : 0), 0);
type CommercePortalAuthDatabaseRecordInput = Parameters<
  ReturnType<CommercePortalAuthDatabaseAdapter>['create']
>[0]['data'];

/** Better Auth callbacks are Promise ports; the runner is captured once at this foreign boundary. */
const sessionCreateBeforeEffect = Effect.fn('CommercePortalAuth.sessionCreateBeforeEffect')(
  function* sessionCreateBeforeEffect(databaseAdapter: DBAdapter, newSession: SessionHookData) {
    const findOne = databaseAdapter.findOne<{ banExpires?: Date | null; banned?: boolean }>;
    const account = yield* Effect.tryPromise({
      catch: databaseFailure,
      try: findOne.bind(databaseAdapter, {
        model: 'user',
        select: ['banned', 'banExpires'],
        where: [{ field: 'id', value: newSession.userId }],
      }),
    }).pipe(databaseBridgeTimeoutPolicy);
    if (account === null || account === undefined || isBannedProviderUser(account)) {
      return false;
    }
    const expiresAt = sessionExpiryAtPolicyBound(newSession);
    return expiresAt === null ? false : { data: { expiresAt } };
  },
);

const sessionCreateBeforeHook = (databaseAdapter: DBAdapter, runDatabaseEffect: typeof Effect.runPromise) =>
  flow((newSession: SessionHookData) => sessionCreateBeforeEffect(databaseAdapter, newSession), runDatabaseEffect);

const readSessionTokenEffect = (endpointContext: GenericEndpointContext | null) => {
  if (endpointContext?.headers === undefined) {
    return Effect.succeed<string | null>(null);
  }
  const getSignedCookie = endpointContext.getSignedCookie.bind(
    endpointContext,
    endpointContext.context.authCookies.sessionToken.name,
    endpointContext.context.secret,
    undefined,
  );
  return Effect.tryPromise({
    catch: databaseFailure,
    try: getSignedCookie,
  }).pipe(
    databaseBridgeTimeoutPolicy,
    Effect.map((token) => (token === false ? null : token)),
  );
};

const sessionUpdateBeforeEffect = Effect.fn('CommercePortalAuth.sessionUpdateBeforeEffect')(
  function* sessionUpdateBeforeEffect(
    databaseAdapter: DBAdapter,
    data: Partial<SessionHookData>,
    endpointContext: GenericEndpointContext | null,
  ) {
    const token = yield* readSessionTokenEffect(endpointContext);
    if (token === null || token.length === 0) {
      return false;
    }
    const findOne = databaseAdapter.findOne<Pick<SessionHookData, 'createdAt' | 'expiresAt'>>;
    const current = yield* Effect.tryPromise({
      catch: databaseFailure,
      try: findOne.bind(databaseAdapter, {
        model: 'session',
        select: ['createdAt', 'expiresAt'],
        where: [{ field: 'token', value: token }],
      }),
    }).pipe(databaseBridgeTimeoutPolicy);
    if (current === null || current === undefined) {
      return false;
    }
    if (data.expiresAt === undefined) {
      return true;
    }
    const currentCreatedAt = epochMillis(current.createdAt);
    const requestedExpiry = epochMillis(data.expiresAt);
    if (!Number.isFinite(currentCreatedAt) || !Number.isFinite(requestedExpiry)) {
      return false;
    }
    const absoluteExpiry = absoluteSessionExpiryMillis(current.createdAt);
    return {
      data: {
        expiresAt: DateTime.toDate(DateTime.makeUnsafe(Math.min(requestedExpiry, absoluteExpiry))),
      },
    };
  },
);

const sessionUpdateBeforeHook = (databaseAdapter: DBAdapter, runDatabaseEffect: typeof Effect.runPromise) =>
  flow(
    (data: Partial<SessionHookData>, endpointContext: GenericEndpointContext | null) =>
      sessionUpdateBeforeEffect(databaseAdapter, data, endpointContext),
    runDatabaseEffect,
  );

/**
 * Reads the governed identity the account-creation port attached to this very provider call. A call
 * that carries none of the three headers is not a port-driven creation and correlates nothing; a
 * call that carries some of them is a broken port rather than an ordinary sign-up, so it fails
 * closed instead of committing an account no Attempt can ever name.
 */
const accountCreationCorrelationOf = (
  context: GenericEndpointContext | null,
): Effect.Effect<Option.Option<typeof CommercePortalAuthAccountCreationCorrelationSchema.Type>, APIError> => {
  const headers = context?.headers;
  if (headers === undefined || headers === null) {
    return Effect.succeedNone;
  }
  const candidate = {
    ownerInvocationId: headers.get(COMMERCE_PORTAL_ACCOUNT_CORRELATION_HEADERS.ownerInvocation),
    portalEnrollmentAttemptId: headers.get(COMMERCE_PORTAL_ACCOUNT_CORRELATION_HEADERS.attempt),
    tenantId: headers.get(COMMERCE_PORTAL_ACCOUNT_CORRELATION_HEADERS.tenant),
  };
  if (Object.values(candidate).every((value) => value === null)) {
    return Effect.succeedNone;
  }
  return Schema.decodeUnknownEffect(CommercePortalAuthAccountCreationCorrelationSchema)(candidate).pipe(
    Effect.mapBoth({
      onFailure: (cause) =>
        Object.defineProperty(
          new APIError('INTERNAL_SERVER_ERROR', {
            code: 'COMMERCE_AUTH_CORRELATION_INVALID',
            message: 'The Commerce portal account creation correlation is not a usable governed identity',
          }),
          'cause',
          { configurable: true, value: cause },
        ),
      onSuccess: Option.some,
    }),
  );
};

/**
 * Better Auth runs this hook before its adapter insert and inserts whatever data it returns, so the
 * governed invocation lands in the very statement that commits the account. There is deliberately
 * no second write: a correlation recorded after the user transaction committed can fail on its own
 * and leave exactly the account — committed, uncorrelated — that the correlation exists to recover.
 * A call carrying no correlation header at all is an ordinary sign-up and is left untouched.
 */
const userCreateBeforeEffect = Effect.fn('CommercePortalAuth.userCreateBeforeEffect')(function* userCreateBeforeEffect(
  newUser: User,
  context: GenericEndpointContext | null,
): Effect.fn.Return<boolean | { readonly data: User & { readonly enrollmentOwnerInvocationId: string } }, APIError> {
  const correlation = yield* accountCreationCorrelationOf(context);
  return Option.isNone(correlation)
    ? true
    : { data: { ...newUser, enrollmentOwnerInvocationId: correlation.value.ownerInvocationId } };
});

const userCreateBeforeHook = (runDatabaseEffect: typeof Effect.runPromise) =>
  flow(
    (newUser: User, context: GenericEndpointContext | null) => userCreateBeforeEffect(newUser, context),
    runDatabaseEffect,
  );

/**
 * Better Auth runs the session create hook before its adapter create call. A count in that hook
 * cannot enforce a concurrent-device cap: two requests can observe the same count and then both
 * insert. The adapter boundary is the first place where we can hold a PostgreSQL transaction
 * while locking the account row, counting committed sessions and creating the new session.
 */
const withAtomicSessionCreation = (
  databaseAdapter: ReturnType<CommercePortalAuthDatabaseAdapter>,
  runDatabaseEffect: typeof Effect.runPromise,
): ReturnType<CommercePortalAuthDatabaseAdapter> => {
  const originalCreate = databaseAdapter.create;
  const createEffect = <T extends Record<string, CommercePortalAuthDatabaseRecordInput[string]>, R = T>(data: {
    readonly data: Omit<T, 'id'>;
    readonly forceAllowId?: boolean | undefined;
    readonly model: string;
    readonly select?: string[] | undefined;
  }): Effect.Effect<R, APIError> => {
    if (data.model !== 'session' || COMMERCE_PORTAL_AUTH_POLICY.session.concurrentDevice.maxActiveSessions === null) {
      const create = originalCreate<T, R>;
      return Effect.tryPromise({
        catch: databaseFailure,
        try: create.bind(databaseAdapter, data),
      }).pipe(databaseBridgeTimeoutPolicy);
    }

    const { data: sessionData } = data;
    const userIdOption = Schema.decodeUnknownOption(Schema.String)(sessionData['userId']);
    if (Option.isNone(userIdOption)) {
      const create = originalCreate<T, R>;
      return Effect.tryPromise({
        catch: databaseFailure,
        try: create.bind(databaseAdapter, data),
      }).pipe(databaseBridgeTimeoutPolicy);
    }
    const userId = userIdOption.value;

    const transactionEffect = Effect.fn('CommercePortalAuth.atomicSessionCreationTransaction')(
      function* atomicSessionCreationTransaction(transaction: DBTransactionAdapter): Effect.fn.Return<R, APIError> {
        const lockedAccount = yield* Effect.tryPromise({
          catch: databaseFailure,
          try: transaction.update.bind(transaction, {
            model: 'user',
            update: { updatedAt: DateTime.toDate(DateTime.nowUnsafe()) },
            where: [{ field: 'id', value: userId }],
          }),
        }).pipe(databaseBridgeTimeoutPolicy);
        if (lockedAccount === null) {
          return yield* Effect.fail(
            new APIError('UNAUTHORIZED', {
              code: 'FAILED_TO_CREATE_SESSION',
              message: 'The Commerce portal account could not create a session',
            }),
          );
        }

        const findMany = transaction.findMany<Pick<SessionHookData, 'createdAt' | 'expiresAt'>>;
        const activeSessions = yield* Effect.tryPromise({
          catch: databaseFailure,
          try: findMany.bind(transaction, {
            model: 'session',
            select: ['createdAt', 'expiresAt'],
            where: [{ field: 'userId', value: userId }],
          }),
        }).pipe(databaseBridgeTimeoutPolicy);
        const activeCount = countActiveProviderSessions(activeSessions, DateTime.toEpochMillis(DateTime.nowUnsafe()));
        const { maxActiveSessions } = COMMERCE_PORTAL_AUTH_POLICY.session.concurrentDevice;
        if (maxActiveSessions !== null && activeCount >= maxActiveSessions) {
          return yield* Effect.fail(
            new APIError('TOO_MANY_REQUESTS', {
              code: 'CONCURRENT_DEVICE_LIMIT',
              message: 'The Commerce portal session limit has been reached',
            }),
          );
        }

        const create = transaction.create<T, R>;
        return yield* Effect.tryPromise({
          catch: databaseFailure,
          try: create.bind(transaction, data),
        }).pipe(databaseBridgeTimeoutPolicy);
      },
    );
    const transactionProgram = flow(transactionEffect, runDatabaseEffect);
    const transaction = databaseAdapter.transaction<R>;
    return Effect.tryPromise<R, APIError>({
      catch: databaseTransactionFailure,
      try: transaction.bind(databaseAdapter, transactionProgram),
    }).pipe(databaseBridgeTimeoutPolicy);
  };
  const runCreate: <A>(effect: Effect.Effect<A, APIError>) => ReturnType<typeof runDatabaseEffect<A, APIError>> =
    runDatabaseEffect;
  const create = Effect.fnUntraced(function* createEffectForBetterAuth<
    T extends Record<string, CommercePortalAuthDatabaseRecordInput[string]>,
    R = T,
  >(data: Parameters<typeof originalCreate<T, R>>[0]): Effect.fn.Return<R, APIError> {
    return yield* createEffect<T, R>(data);
  }, runCreate);
  databaseAdapter.create = create;
  return databaseAdapter;
};

const makeCommercePortalAuthOptionsWithAdapter = (
  input: CommercePortalAuthOptionsInput,
  runDatabaseEffect: typeof Effect.runPromise,
): CommercePortalAuthOptions => {
  const { configuration, emailDelivery } = input;
  const atomicDatabaseFactory = (optionsForAdapter: BetterAuthOptions) =>
    withAtomicSessionCreation(input.databaseAdapter(optionsForAdapter), runDatabaseEffect);
  const commonCookieAttributes = {
    httpOnly: COMMERCE_PORTAL_AUTH_POLICY.cookie.httpOnly,
    path: COMMERCE_PORTAL_AUTH_POLICY.cookie.path,
    sameSite: COMMERCE_PORTAL_AUTH_POLICY.cookie.sameSite,
    secure: configuration.secureCookies,
  } satisfies CommercePortalAuthCookieAttributes;
  const defaultCookieAttributes: CommercePortalAuthCookieAttributes =
    COMMERCE_PORTAL_AUTH_POLICY.cookie.domain === undefined
      ? commonCookieAttributes
      : { ...commonCookieAttributes, domain: COMMERCE_PORTAL_AUTH_POLICY.cookie.domain };

  /**
   * Construct the isolated Better Auth realm. The returned handler must be mounted by the owner
   * with an explicit route allowlist; in particular, `/sign-up/email` is private to the account
   * creation port and must never be exposed as an unauthenticated public endpoint.
   */
  const options = {
    account: {
      accountLinking: {
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        disableImplicitLinking: true,
        enabled: false,
        updateUserInfoOnLink: false,
      },
      encryptOAuthTokens: true,
      updateAccountOnSignIn: false,
    },
    advanced: {
      cookiePrefix: COMMERCE_PORTAL_AUTH_POLICY.cookie.namePrefix,
      crossSubDomainCookies: {
        enabled: false,
      },
      defaultCookieAttributes,
      disableCSRFCheck: !COMMERCE_PORTAL_AUTH_POLICY.csrf.enabled,
      disableOriginCheck: !COMMERCE_PORTAL_AUTH_POLICY.csrf.originCheck,
      ipAddress: {
        // A forwarded hop is believed only when the socket peer is one of the deployment's own
        // declared proxies; with none declared the provider falls back to the socket peer.
        ipAddressHeaders: ['x-forwarded-for'],
        trustedProxies: [...configuration.trustedProxies],
      },
      useSecureCookies: configuration.secureCookies,
    },
    appName: 'OntOS Commerce Portal',
    basePath: COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH,
    baseURL: configuration.baseUrl,
    database: atomicDatabaseFactory,
    emailAndPassword: {
      autoSignIn: false,
      disableSignUp: false,
      enabled: true,
      maxPasswordLength: COMMERCE_PORTAL_AUTH_POLICY.password.maxLength,
      minPasswordLength: COMMERCE_PORTAL_AUTH_POLICY.password.minLength,
      requireEmailVerification: COMMERCE_PORTAL_AUTH_POLICY.emailVerification.requiredBeforeSignIn,
      resetPasswordTokenExpiresIn: COMMERCE_PORTAL_AUTH_POLICY.password.resetTokenExpiresInSeconds,
      revokeSessionsOnPasswordReset: COMMERCE_PORTAL_AUTH_POLICY.password.revokeSessionsOnReset,
      sendResetPassword: emailDelivery.sendResetPassword,
    },
    emailVerification: {
      autoSignInAfterVerification: false,
      expiresIn: COMMERCE_PORTAL_AUTH_POLICY.emailVerification.expiresInSeconds,
      sendOnSignIn: false,
      sendOnSignUp: true,
      sendVerificationEmail: emailDelivery.sendVerificationEmail,
    },
    logger: {
      disabled: true,
    },
    plugins: [
      createCommercePortalAuthTwoFactorPlugin({
        policy: COMMERCE_PORTAL_AUTH_MFA_POLICY,
        sendOTP: emailDelivery.sendOTP,
      }),
    ],
    rateLimit: {
      customRules: {
        '/request-password-reset': {
          max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.max,
          window: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.windowSeconds,
        },
        '/send-verification-email': {
          max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.max,
          window: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.windowSeconds,
        },
        '/sign-in/email': {
          max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.signIn.max,
          window: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.signIn.windowSeconds,
        },
        '/sign-up/email': {
          max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.accountCreation.max,
          window: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.accountCreation.windowSeconds,
        },
        '/two-factor/*': {
          max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max,
          window: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.windowSeconds,
        },
      },
      enabled: true,
      max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.default.max,
      storage: 'database',
      window: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.default.windowSeconds,
    },
    secret: Redacted.value(configuration.secret),
    secrets:
      configuration.versionedSecrets.length === 0
        ? undefined
        : configuration.versionedSecrets.map(({ value, version }) => ({
            value: Redacted.value(value),
            version,
          })),
    session: {
      cookieCache: {
        enabled: COMMERCE_PORTAL_AUTH_POLICY.session.cookieCacheEnabled,
        refreshCache: false,
      },
      deferSessionRefresh: false,
      disableSessionRefresh: false,
      expiresIn: COMMERCE_PORTAL_AUTH_POLICY.session.inactivityLifetimeSeconds,
      freshAge: COMMERCE_PORTAL_AUTH_POLICY.session.freshAgeSeconds,
      updateAge: COMMERCE_PORTAL_AUTH_POLICY.session.updateAgeSeconds,
    },
    trustedOrigins: [...configuration.trustedOrigins],
    user: {
      // Provider status is private state. It is excluded from Better Auth response objects and is
      // checked directly by the authoritative verifier before identity admission.
      additionalFields: {
        banExpires: {
          input: false,
          required: false,
          returned: false,
          type: 'date',
        },
        banned: {
          defaultValue: false,
          input: false,
          required: false,
          returned: false,
          type: 'boolean',
        },
        banReason: {
          input: false,
          required: false,
          returned: false,
          type: 'string',
        },
        // The governed invocation the realm's own user-creation hook stamps on the row it inserts.
        // `input: false` keeps a caller from naming one; it is never returned to a browser.
        enrollmentOwnerInvocationId: {
          input: false,
          required: false,
          returned: false,
          type: 'string',
        },
      },
      changeEmail: {
        enabled: false,
      },
      deleteUser: {
        enabled: false,
      },
    },
    verification: {
      // Reset and verification identifiers are hashed at rest by Better Auth 1.7.2.
      storeIdentifier: 'hashed',
    },
  } satisfies BetterAuthOptions;
  const initializedAdapter = atomicDatabaseFactory(options);
  const databaseHooks = {
    session: {
      create: {
        before: sessionCreateBeforeHook(initializedAdapter, runDatabaseEffect),
      },
      update: {
        before: sessionUpdateBeforeHook(initializedAdapter, runDatabaseEffect),
      },
    },
    user: {
      create: {
        before: userCreateBeforeHook(runDatabaseEffect),
      },
    },
  };
  return { ...options, databaseHooks } satisfies BetterAuthOptions;
};

/**
 * Resolve the adapter factory with the same options that are ultimately passed to Better Auth.
 * Passing the factory itself as `database` leaves `findOne`/`findMany` undefined at request time.
 */
export const makeCommercePortalAuthOptions = Effect.fn('CommercePortalAuth.makeOptions')(
  function* makeCommercePortalAuthOptionsEffect(
    input: CommercePortalAuthOptionsInput,
  ): Effect.fn.Return<CommercePortalAuthOptions> {
    const effectContext = yield* Effect.context();
    return makeCommercePortalAuthOptionsWithAdapter(input, Effect.runPromiseWith(effectContext));
  },
);

export const makeCommercePortalAuth = Effect.fn('CommercePortalAuth.make')(function* makeCommercePortalAuthEffect(
  input: CommercePortalAuthOptionsInput,
): Effect.fn.Return<CommercePortalAuth> {
  return betterAuth(yield* makeCommercePortalAuthOptions(input));
});

export class CommercePortalAuthInstance extends Context.Service<CommercePortalAuthInstance, CommercePortalAuth>()(
  '@app/commerce-customer-context/api/portal-auth/provider/auth/CommercePortalAuthInstance',
) {}

export const CommercePortalAuthLive = Layer.effect(
  CommercePortalAuthInstance,
  Effect.gen(function* makeCommercePortalAuthLive() {
    const configuration = yield* CommercePortalAuthConfig;
    const database = yield* CommercePortalAuthDatabase;
    const emailDelivery = yield* CommercePortalAuthEmailDeliveryService;
    return yield* makeCommercePortalAuth({
      configuration,
      databaseAdapter: database.adapter,
      emailDelivery,
    });
  }),
);
