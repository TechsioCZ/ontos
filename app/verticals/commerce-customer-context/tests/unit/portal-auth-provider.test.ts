import { APIError } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { OTPOptions } from 'better-auth/plugins/two-factor';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  CommerceSessionReferenceSchema,
} from '../../shared/portal-auth-contracts.ts';
import { COMMERCE_PORTAL_AUTH_VERIFY_OPERATION } from '../../shared/portal-auth-verification.ts';
import {
  CommerceEnrollmentProofService,
  CommerceEnrollmentProofUnavailable,
} from '../../api/portal-auth/enrollment-proof-port.ts';
import {
  CommercePortalAuthAccountCreationRejected,
  CommercePortalAuthAccountCreationInvalidRequest,
  CommercePortalAuthAccountCreationUnavailable,
  CommercePortalAuthAccountCreationGatewayService,
  CommercePortalAuthAccountCreationProviderService,
  CommercePortalAuthAccountLookupService,
  CommercePortalAuthAccountCreationService,
  makeCommercePortalAuthAccountCreationGateway,
  makeCommercePortalAuthAccountCreationService,
} from '../../api/portal-auth/provider/account-create.ts';
import { makeCommercePortalAuthOptions } from '../../api/portal-auth/provider/auth.ts';
import {
  COMMERCE_PORTAL_AUTH_SCHEMA_NAME,
  COMMERCE_PORTAL_AUTH_TABLE_INVENTORY,
  COMMERCE_PORTAL_AUTH_TABLES,
  commercePortalAuthDatabaseSchema,
  user,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import {
  COMMERCE_PORTAL_AUTH_POLICY,
  CommercePortalAuthConfigError,
  parseCommercePortalAuthConfig,
} from '../../api/portal-auth/provider/config.ts';
import {
  CommercePortalAuthSessionReferenceError,
  encodeCommerceSessionReference,
  parseCommerceSessionReference,
} from '../../api/portal-auth/provider/session-reference.ts';
import {
  CommercePortalAuthSessionReadUnavailable,
  CommercePortalAuthVerificationCaller,
  CommercePortalAuthVerificationCallerRejected,
  makeCommercePortalAuthVerificationService,
} from '../../api/portal-auth/provider/verification.ts';
import type {
  CommercePortalAccountCreateInput,
  CommercePortalAuthAccountCreateResponse,
  CommercePortalAuthAccountCreationProvider,
  CommercePortalAuthAccountLookup,
  CommercePortalAccountCreateResult,
  CommercePortalAuthAccountCreationFailure,
} from '../../api/portal-auth/provider/account-create.ts';
import type {
  CommercePortalAuthAuthoritativeSession,
  CommercePortalAuthVerificationInput,
  CommercePortalAuthVerificationAuthorization,
} from '../../api/portal-auth/provider/verification.ts';
import type { CommercePortalAuthSessionReader } from '../../api/portal-auth/provider/session-reader-service.ts';
import type { CommercePortalAuthDatabaseAdapter } from '../../src/portal-auth/persistence/portal-auth-database-types.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';

const tenantId = Schema.decodeUnknownSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const nonce = '20000000-0000-4000-8000-000000000002';
const enrollmentAttemptId = Schema.decodeUnknownSync(EnrollmentAttemptIdSchema)('30000000-0000-4000-8000-000000000003');
const ownerInvocationId = Schema.decodeUnknownSync(EnrollmentActionInvocationIdSchema)(
  '40000000-0000-4000-8000-000000000004',
);
const evidenceRef = '50000000-0000-4000-8000-000000000005';
const providerSubjectId = 'commerce-user-1';
const sessionId = 'session_safe-1';
const sessionRef = `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:${sessionId}`;
const testNow = new Date(0);
const testPassword = Redacted.make('P'.repeat(24));
// The adapter is constructed with a dummy DB because these tests inspect options only; no query runs.
const testDatabaseAdapter: CommercePortalAuthDatabaseAdapter = drizzleAdapter({}, { provider: 'pg' });
const otpDeliveryCallback: NonNullable<OTPOptions['sendOTP']> = () => Promise.resolve();
const createdAt = new Date(testNow.getTime() - 60_000);
const expiresAt = new Date(testNow.getTime() + 3_600_000);

const request = {
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  nonce,
  providerSubjectId,
  sessionRef,
  subjectType: 'user' as const,
  tenantId,
} satisfies CommercePortalAuthVerificationInput;

const authoritativeSession: CommercePortalAuthAuthoritativeSession = {
  banExpiresAt: null,
  banned: false,
  createdAt,
  emailVerified: true,
  expiresAt,
  providerSubjectId,
  sessionId,
};

const allowingCaller: CommercePortalAuthVerificationCaller['Service'] = {
  authorize: (_input: CommercePortalAuthVerificationAuthorization) => Effect.void,
};

const proofUnavailable: CommerceEnrollmentProofService['Service'] = {
  authorizeAccountCreation: () => Effect.fail(new CommerceEnrollmentProofUnavailable()),
  verify: () => Effect.fail(new CommerceEnrollmentProofUnavailable()),
};

const runVerification = (
  input: CommercePortalAuthVerificationInput,
  sessionReader: CommercePortalAuthSessionReader,
  caller: CommercePortalAuthVerificationCaller['Service'] = allowingCaller,
  proof: CommerceEnrollmentProofService['Service'] = proofUnavailable,
) =>
  makeCommercePortalAuthVerificationService(sessionReader).pipe(
    Effect.provideService(CommercePortalAuthVerificationCaller, caller),
    Effect.provideService(CommerceEnrollmentProofService, proof),
    Effect.flatMap((service) => service.verifyExternalAuthentication(input)),
  );

const makeAccountGateway = (
  auth: CommercePortalAuthAccountCreationProvider,
  accountLookup: CommercePortalAuthAccountLookup,
) =>
  makeCommercePortalAuthAccountCreationGateway().pipe(
    Effect.provideService(CommercePortalAuthAccountCreationProviderService, auth),
    Effect.provideService(CommercePortalAuthAccountLookupService, accountLookup),
  );

const runGatewayCreate = (
  auth: CommercePortalAuthAccountCreationProvider,
  accountLookup: CommercePortalAuthAccountLookup,
  input: Pick<
    CommercePortalAccountCreateInput,
    'email' | 'enrollmentAttemptId' | 'name' | 'ownerInvocationId' | 'password' | 'tenantId'
  >,
) => makeAccountGateway(auth, accountLookup).pipe(Effect.flatMap((gateway) => gateway.create(input)));

const providerSuccess = (response: CommercePortalAuthAccountCreateResponse) => Effect.succeed(Option.some(response));

const invokeAccountCreationBoundary = (
  service: CommercePortalAuthAccountCreationService['Service'],
  serializedInput: string,
  password?: Redacted.Redacted,
): Effect.Effect<CommercePortalAccountCreateResult, CommercePortalAuthAccountCreationFailure> => {
  const input = JSON.parse(serializedInput);
  if (password === undefined) {
    return service.createAccount(input);
  }
  return service.createAccount({ ...input, password });
};

it.effect('verifies a live provider session by safe session.id and never returns a token', () =>
  runVerification(request, {
    findBySessionId: (id) => Effect.succeed(id === sessionId ? Option.some(authoritativeSession) : Option.none()),
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.outcome).toBe('ALLOWED');
        if (result.outcome !== 'ALLOWED') {
          throw new Error('Expected an allowed session');
        }
        expect(result.sessionRef).toBe(sessionRef);
        expect(result.authenticatedAt).toStrictEqual(DateTime.makeUnsafe(createdAt));
        expect('token' in result).toBe(false);
        expect(result.emailVerified).toBe(true);
      }),
    ),
  ),
);

it.effect('requires trusted caller authorization before reading the provider session', () => {
  let reads = 0;
  const caller: CommercePortalAuthVerificationCaller['Service'] = {
    authorize: () =>
      Effect.fail(
        new CommercePortalAuthVerificationCallerRejected({
          reason: 'test caller denied',
        }),
      ),
  };
  return runVerification(
    request,
    {
      findBySessionId: () =>
        Effect.sync(() => {
          reads += 1;
          return Option.some(authoritativeSession);
        }),
    },
    caller,
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toStrictEqual({ nonce, observedAt: result.observedAt, outcome: 'REJECTED' });
        expect(reads).toBe(0);
      }),
    ),
  );
});

it.effect('rejects expired, unverified, disabled, and subject-mismatched provider state', () => {
  const cases: readonly CommercePortalAuthAuthoritativeSession[] = [
    { ...authoritativeSession, expiresAt: new Date(createdAt.getTime() - 1) },
    {
      ...authoritativeSession,
      createdAt: new Date(testNow.getTime() - COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds * 1000 - 1),
    },
    { ...authoritativeSession, emailVerified: false },
    { ...authoritativeSession, banned: true },
    { ...authoritativeSession, providerSubjectId: 'another-user' },
  ];
  return Effect.all(
    cases.map((record) =>
      runVerification(request, {
        findBySessionId: () => Effect.succeed(Option.some(record)),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.outcome).toBe('REJECTED');
            expect(result.nonce).toBe(nonce);
          }),
        ),
      ),
    ),
  );
});

it.effect('binds an active owner-local Attempt proof to the allowed result', () => {
  const proof: CommerceEnrollmentProofService['Service'] = {
    authorizeAccountCreation: () => Effect.fail(new CommerceEnrollmentProofUnavailable()),
    verify: () =>
      Effect.succeed({
        enrollmentAttemptId,
        evidenceRef,
        observedAt: DateTime.makeUnsafe(createdAt),
        policyVersion: COMMERCE_PORTAL_AUTH_POLICY.policyVersion,
        revision: 2,
      }),
  };
  return runVerification(
    { ...request, enrollmentAttemptId },
    {
      findBySessionId: () => Effect.succeed(Option.some(authoritativeSession)),
    },
    allowingCaller,
    proof,
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.outcome).toBe('ALLOWED');
        if (result.outcome !== 'ALLOWED') {
          throw new Error('Expected an allowed session');
        }
        expect(result.enrollmentProof?.enrollmentAttemptId).toBe(enrollmentAttemptId);
        expect(result.enrollmentProof?.evidenceRef).toBe(evidenceRef);
        expect(result.enrollmentProof?.revision).toBe(2);
      }),
    ),
  );
});

it.effect('maps owner-proof unavailability to a fail-closed unavailable result', () =>
  runVerification(
    { ...request, enrollmentAttemptId },
    {
      findBySessionId: () => Effect.succeed(Option.some(authoritativeSession)),
    },
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.outcome).toBe('UNAVAILABLE');
        expect(result.nonce).toBe(nonce);
      }),
    ),
  ),
);

it.effect('authorizes the exact create invocation before invoking Better Auth', () => {
  const events: string[] = [];
  const proof: CommerceEnrollmentProofService['Service'] = {
    authorizeAccountCreation: (input) =>
      Effect.sync(() => {
        events.push(`proof:${input.enrollmentAttemptId}:${input.ownerInvocationId}`);
        return { evidenceRef, revision: 7 };
      }),
    verify: () => Effect.fail(new CommerceEnrollmentProofUnavailable()),
  };
  const gateway = {
    create: (input: { readonly email: string; readonly name: string; readonly password: Redacted.Redacted }) =>
      Effect.sync(() => {
        events.push(`provider:${input.email}`);
        return { providerSubjectId };
      }),
  };
  const input = {
    email: 'buyer@example.test',
    enrollmentAttemptId,
    name: 'Buyer',
    ownerInvocationId,
    password: testPassword,
    tenantId,
  };
  return makeCommercePortalAuthAccountCreationService().pipe(
    Effect.provideService(CommerceEnrollmentProofService, proof),
    Effect.provideService(CommercePortalAuthAccountCreationGatewayService, gateway),
    Effect.flatMap((service) => service.createAccount(input)),
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(events).toStrictEqual([
          `proof:${enrollmentAttemptId}:${ownerInvocationId}`,
          'provider:buyer@example.test',
        ]);
        expect(result).toStrictEqual({
          enrollmentAttemptId,
          evidenceRef,
          outcome: 'CREATED',
          providerSubjectId,
          revision: 7,
        });
        expect('token' in result).toBe(false);
      }),
    ),
  );
});

it.effect('does not invoke Better Auth when the owner rejects the create invocation', () => {
  let providerCalls = 0;
  const proof: CommerceEnrollmentProofService['Service'] = {
    authorizeAccountCreation: () => Effect.fail(new CommerceEnrollmentProofUnavailable()),
    verify: () => Effect.fail(new CommerceEnrollmentProofUnavailable()),
  };
  const gateway = {
    create: () =>
      Effect.sync(() => {
        providerCalls += 1;
        return { providerSubjectId };
      }),
  };
  return makeCommercePortalAuthAccountCreationService().pipe(
    Effect.provideService(CommerceEnrollmentProofService, proof),
    Effect.provideService(CommercePortalAuthAccountCreationGatewayService, gateway),
    Effect.flatMap((service) =>
      Effect.flip(
        service.createAccount({
          email: 'buyer@example.test',
          enrollmentAttemptId,
          name: 'Buyer',
          ownerInvocationId,
          password: testPassword,
          tenantId,
        }),
      ),
    ),
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(failure)).toBe(true);
        expect(providerCalls).toBe(0);
      }),
    ),
  );
});

it.effect('projects a Better Auth create response double without returning its token', () => {
  let receivedBody: unknown;
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: (signUpRequest) => {
        receivedBody = signUpRequest;
        return Effect.succeed(Option.some({ token: 'raw-session-token', user: { id: providerSubjectId } }));
      },
    },
  };
  return makeAccountGateway(auth, {
    existsByEmail: () => Effect.succeed(false),
    existsByProviderSubject: () => Effect.succeed(true),
    subjectForOwnerInvocation: () => Effect.succeedNone,
  }).pipe(
    Effect.flatMap((gateway) =>
      gateway.create({
        email: 'buyer@example.test',
        enrollmentAttemptId,
        name: 'Buyer',
        ownerInvocationId,
        password: testPassword,
        tenantId,
      }),
    ),
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toStrictEqual({ providerSubjectId });
        expect('token' in result).toBe(false);
        expect(receivedBody).toStrictEqual({
          body: {
            email: 'buyer@example.test',
            name: 'Buyer',
            password: 'P'.repeat(24),
          },
          // The provider correlates its own commit by these, so a lost answer is still recoverable.
          headers: {
            'x-commerce-portal-account-attempt': enrollmentAttemptId,
            'x-commerce-portal-account-owner-invocation': ownerInvocationId,
            'x-commerce-portal-account-tenant': tenantId,
          },
        });
      }),
    ),
  );
});

it.effect('does not treat Better Auth generic duplicate responses as created accounts', () => {
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: () => providerSuccess({ token: null, user: { id: 'synthetic-user' } }),
    },
  };
  return Effect.flip(
    runGatewayCreate(
      auth,
      {
        existsByEmail: () => Effect.succeed(false),
        existsByProviderSubject: () => Effect.succeed(false),
        subjectForOwnerInvocation: () => Effect.succeedNone,
      },
      {
        email: 'existing@example.test',
        enrollmentAttemptId,
        name: 'Existing',
        ownerInvocationId,
        password: testPassword,
        tenantId,
      },
    ),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthAccountCreationRejected)(failure)).toBe(true);
      }),
    ),
  );
});

it.effect('maps a definitive Better Auth validation failure to rejected', () => {
  let providerCalls = 0;
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: () => {
        providerCalls += 1;
        return Effect.fail(
          new APIError('BAD_REQUEST', {
            code: 'INVALID_EMAIL',
            message: 'Invalid email',
          }),
        );
      },
    },
  };
  return Effect.flip(
    runGatewayCreate(
      auth,
      {
        existsByEmail: () => Effect.succeed(false),
        existsByProviderSubject: () => Effect.succeed(false),
        subjectForOwnerInvocation: () => Effect.succeedNone,
      },
      {
        email: 'buyer@example.test',
        enrollmentAttemptId,
        name: 'Buyer',
        ownerInvocationId,
        password: testPassword,
        tenantId,
      },
    ),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthAccountCreationRejected)(failure)).toBe(true);
        expect(providerCalls).toBe(1);
      }),
    ),
  );
});

it.effect('fails closed when the Better Auth error code is absent or unbounded', () => {
  const failureFor = (body: { readonly code?: string; readonly message?: string }) => {
    const auth: CommercePortalAuthAccountCreationProvider = {
      api: {
        sendVerificationEmail: () => Effect.void,
        signUpEmail: () => Effect.fail(new APIError('BAD_REQUEST', body)),
      },
    };
    return Effect.flip(
      runGatewayCreate(
        auth,
        {
          existsByEmail: () => Effect.succeed(false),
          existsByProviderSubject: () => Effect.succeed(false),
          subjectForOwnerInvocation: () => Effect.succeedNone,
        },
        {
          email: 'buyer@example.test',
          enrollmentAttemptId,
          name: 'Buyer',
          ownerInvocationId,
          password: testPassword,
          tenantId,
        },
      ),
    );
  };
  return Effect.all([failureFor({ message: 'No code' }), failureFor({ code: 'X'.repeat(65) })]).pipe(
    Effect.tap((failures) =>
      Effect.sync(() => {
        for (const failure of failures) {
          expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(failure)).toBe(true);
        }
      }),
    ),
  );
});

it.effect('rejects an existing email before invoking Better Auth', () => {
  let providerCalls = 0;
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: () => {
        providerCalls += 1;
        return providerSuccess({ token: null, user: { id: 'synthetic-user' } });
      },
    },
  };
  return Effect.flip(
    runGatewayCreate(
      auth,
      {
        existsByEmail: () => Effect.succeed(true),
        existsByProviderSubject: () => Effect.succeed(true),
        subjectForOwnerInvocation: () => Effect.succeedNone,
      },
      {
        email: 'existing@example.test',
        enrollmentAttemptId,
        name: 'Existing',
        ownerInvocationId,
        password: testPassword,
        tenantId,
      },
    ),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthAccountCreationRejected)(failure)).toBe(true);
        expect(providerCalls).toBe(0);
      }),
    ),
  );
});

/**
 * The lost-answer retry. Better Auth committed the account for this exact invocation and the start
 * route never journalled its subject, so the address is already taken: without the correlation
 * replay the duplicate guard refuses the retry and the Attempt can never be completed at all.
 */
it.effect('replays a correlated owner invocation to its committed subject instead of refusing it', () => {
  let providerCalls = 0;
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: () => {
        providerCalls += 1;
        return providerSuccess({ user: { id: 'a-second-account' } });
      },
    },
  };
  return runGatewayCreate(
    auth,
    {
      existsByEmail: () => Effect.succeed(true),
      existsByProviderSubject: () => Effect.succeed(true),
      subjectForOwnerInvocation: ({ ownerInvocationId: invocation }) =>
        invocation === ownerInvocationId ? Effect.succeedSome(providerSubjectId) : Effect.succeedNone,
    },
    {
      email: 'buyer@example.test',
      enrollmentAttemptId,
      name: 'Buyer',
      ownerInvocationId,
      password: testPassword,
      tenantId,
    },
  ).pipe(
    Effect.tap((account) =>
      Effect.sync(() => {
        expect(account).toStrictEqual({ providerSubjectId });
        expect(providerCalls).toBe(0);
      }),
    ),
  );
});

it.effect('maps a malformed Better Auth success response to unavailable', () => {
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: () => Effect.succeed(Option.none<CommercePortalAuthAccountCreateResponse>()),
    },
  };
  return Effect.flip(
    runGatewayCreate(
      auth,
      {
        existsByEmail: () => Effect.succeed(false),
        existsByProviderSubject: () => Effect.succeed(true),
        subjectForOwnerInvocation: () => Effect.succeedNone,
      },
      {
        email: 'buyer@example.test',
        enrollmentAttemptId,
        name: 'Buyer',
        ownerInvocationId,
        password: testPassword,
        tenantId,
      },
    ),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(failure)).toBe(true);
      }),
    ),
  );
});

it.effect('maps an indeterminate Better Auth provider failure to unavailable without retrying', () => {
  let providerCalls = 0;
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: () => {
        providerCalls += 1;
        return Effect.fail(new Error('provider response lost after dispatch'));
      },
    },
  };
  return Effect.flip(
    runGatewayCreate(
      auth,
      {
        existsByEmail: () => Effect.succeed(false),
        existsByProviderSubject: () => Effect.succeed(false),
        subjectForOwnerInvocation: () => Effect.succeedNone,
      },
      {
        email: 'buyer@example.test',
        enrollmentAttemptId,
        name: 'Buyer',
        ownerInvocationId,
        password: testPassword,
        tenantId,
      },
    ),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(failure)).toBe(true);
        expect(providerCalls).toBe(1);
      }),
    ),
  );
});

it.effect('maps a wrapped Better Auth storage failure to unavailable after one provider call', () => {
  let providerCalls = 0;
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: () => {
        providerCalls += 1;
        return Effect.fail(
          new APIError('UNPROCESSABLE_ENTITY', {
            code: 'FAILED_TO_CREATE_USER',
            message: 'Failed to create user',
          }),
        );
      },
    },
  };
  return Effect.flip(
    runGatewayCreate(
      auth,
      {
        existsByEmail: () => Effect.succeed(false),
        existsByProviderSubject: () => Effect.succeed(false),
        subjectForOwnerInvocation: () => Effect.succeedNone,
      },
      {
        email: 'buyer@example.test',
        enrollmentAttemptId,
        name: 'Buyer',
        ownerInvocationId,
        password: testPassword,
        tenantId,
      },
    ),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(failure)).toBe(true);
        expect(providerCalls).toBe(1);
      }),
    ),
  );
});

it.effect('rejects raw password and missing owner invocation before any gateway call', () => {
  let gatewayCalls = 0;
  let providerCalls = 0;
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: () => {
        providerCalls += 1;
        return providerSuccess({ user: { id: providerSubjectId } });
      },
    },
  };
  const accountLookup: CommercePortalAuthAccountLookup = {
    existsByEmail: () => Effect.succeed(false),
    existsByProviderSubject: () => Effect.succeed(true),
    subjectForOwnerInvocation: () => Effect.succeedNone,
  };
  const rawPasswordInput = {
    email: 'buyer@example.test',
    enrollmentAttemptId,
    name: 'Buyer',
    ownerInvocationId,
    password: 'a'.repeat(24),
    tenantId,
  };
  const missingInvocationPassword = Redacted.make('a'.repeat(24));
  const missingInvocationInput = {
    email: 'buyer@example.test',
    enrollmentAttemptId,
    name: 'Buyer',
    password: missingInvocationPassword,
    tenantId,
  };
  return makeAccountGateway(auth, accountLookup).pipe(
    Effect.flatMap((providerGateway) =>
      makeCommercePortalAuthAccountCreationService().pipe(
        Effect.provideService(CommerceEnrollmentProofService, proofUnavailable),
        Effect.provideService(CommercePortalAuthAccountCreationGatewayService, {
          create: (input) => {
            gatewayCalls += 1;
            return providerGateway.create(input);
          },
        }),
        Effect.flatMap((service) =>
          Effect.all([
            Effect.flip(invokeAccountCreationBoundary(service, JSON.stringify(rawPasswordInput))),
            Effect.flip(
              invokeAccountCreationBoundary(service, JSON.stringify(missingInvocationInput), missingInvocationPassword),
            ),
          ]),
        ),
      ),
    ),
    Effect.tap(([rawPasswordFailure, missingInvocationFailure]) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthAccountCreationInvalidRequest)(rawPasswordFailure)).toBe(true);
        expect(Schema.is(CommercePortalAuthAccountCreationInvalidRequest)(missingInvocationFailure)).toBe(true);
        expect(gatewayCalls).toBe(0);
        expect(providerCalls).toBe(0);
      }),
    ),
  );
});

it.effect('keeps session references namespaced and rejects raw tokens', () =>
  Effect.all([
    encodeCommerceSessionReference(sessionId),
    parseCommerceSessionReference(sessionRef),
    parseCommerceSessionReference('raw-session-token'),
  ] as const).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthSessionReferenceError)(failure)).toBe(true);
      }),
    ),
  ),
);

it.effect('parses isolated configuration and exposes explicit provider policy', () =>
  parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@localhost/commerce_auth',
    COMMERCE_PORTAL_AUTH_NODE_ENV: 'production',
    COMMERCE_PORTAL_AUTH_SECRET: 'a'.repeat(32),
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test,https://portal.example.test',
    COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
  }).pipe(
    Effect.tap((configuration) =>
      Effect.sync(() => {
        expect(configuration.baseUrl).toBe('https://portal.example.test');
        expect(configuration.secureCookies).toBe(true);
        expect(configuration.trustedOrigins).toStrictEqual(['https://portal.example.test']);
        expect(configuration.policy.csrf.enabled).toBe(true);
        expect(configuration.policy.cookie.domain).toBeUndefined();
        expect(configuration.policy.cookie.namePrefix).toBe('commerce-portal');
        expect(configuration.policy.cookie.path).toBe('/');
        expect(configuration.policy.session.cookieCacheEnabled).toBe(false);
        expect(configuration.policy.session.absoluteLifetimeSeconds).toBe(86_400);
        expect(configuration.policy.session.inactivityLifetimeSeconds).toBe(28_800);
        expect(configuration.policy.session.identifierRotation.onSignIn).toBe(true);
        expect(configuration.policy.session.identifierRotation.onRefresh).toBe(false);
        expect(configuration.policy.session.concurrentDevice.overflow).toBe('reject-new');
      }),
    ),
  ),
);

it.effect('keeps the Better Auth table inventory in the isolated commerce_auth schema', () =>
  Effect.sync(() => {
    expect(COMMERCE_PORTAL_AUTH_SCHEMA_NAME).toBe('commerce_auth');
    // MFA (two_factor) and step-up challenge state are provider state; they belong to this
    // isolated schema and never to Core or Staff.
    expect(COMMERCE_PORTAL_AUTH_TABLE_INVENTORY).toStrictEqual([
      'user',
      'session',
      'account',
      'verification',
      'rateLimit',
      'twoFactor',
      'stepUpChallenge',
      'stepUpChallengeAttempt',
      'recoveryReconciliation',
      'recoveryResetLedger',
      'portalAuthAuditEvent',
    ]);
    // The governed invocation that created an account is a column on the account row, never a
    // table of its own: a second row written after the user transaction committed could fail on
    // its own and leave exactly the uncorrelated account it exists to recover.
    expect(COMMERCE_PORTAL_AUTH_TABLES.map((table) => getTableConfig(table).name)).not.toContain(
      'account_creation_correlation',
    );
    expect(getTableConfig(user).columns.map((column) => column.name)).toContain('enrollment_owner_invocation_id');
    expect(Object.keys(commercePortalAuthDatabaseSchema)).toStrictEqual([
      'account',
      'rateLimit',
      'recoveryReconciliation',
      'recoveryResetLedger',
      'session',
      'stepUpChallenge',
      'stepUpChallengeAttempt',
      'twoFactor',
      'user',
      'verification',
    ]);
  }),
);

it.effect('rejects malformed isolated configuration', () =>
  Effect.flip(
    parseCommercePortalAuthConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_URL: 'https://not-postgres.example.test/db',
      COMMERCE_PORTAL_AUTH_SECRET: 'short',
      COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
    }),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthConfigError)(failure)).toBe(true);
      }),
    ),
  ),
);

it.effect('rejects malformed Better Auth rotation keys', () =>
  Effect.flip(
    parseCommercePortalAuthConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@localhost/commerce_auth',
      COMMERCE_PORTAL_AUTH_SECRET: 'a'.repeat(32),
      COMMERCE_PORTAL_AUTH_SECRETS: `1:${'b'.repeat(32)},1:${'c'.repeat(32)}`,
      COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
    }),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthConfigError)(failure)).toBe(true);
      }),
    ),
  ),
);

it.effect('builds Better Auth options with isolated cookies, CSRF, verification and rate limits', () =>
  parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@localhost/commerce_auth',
    COMMERCE_PORTAL_AUTH_SECRET: 'a'.repeat(32),
    COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
  }).pipe(
    Effect.flatMap((configuration) =>
      makeCommercePortalAuthOptions({
        configuration,
        databaseAdapter: testDatabaseAdapter,
        emailDelivery: {
          sendOTP: otpDeliveryCallback,
          sendResetPassword: () => Promise.resolve(),
          sendVerificationEmail: () => Promise.resolve(),
        },
      }),
    ),
    Effect.tap((options) =>
      Effect.sync(() => {
        expect(options.advanced?.disableCSRFCheck).toBe(false);
        expect(options.advanced?.disableOriginCheck).toBe(false);
        expect(options.advanced?.defaultCookieAttributes?.path).toBe('/');
        expect(options.advanced?.defaultCookieAttributes?.domain).toBeUndefined();
        expect(options.advanced?.crossSubDomainCookies?.enabled).toBe(false);
        expect(options.advanced?.cookiePrefix).toBe(COMMERCE_PORTAL_AUTH_POLICY.cookie.namePrefix);
        expect(options.session?.cookieCache?.enabled).toBe(false);
        expect(options.session?.disableSessionRefresh).toBe(false);
        expect(options.session?.expiresIn).toBe(28_800);
        expect(options.session?.updateAge).toBe(0);
        expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
        expect(options.rateLimit?.storage).toBe('database');
        expect(options.account?.accountLinking?.enabled).toBe(false);
        expect(options.verification?.storeIdentifier).toBe('hashed');
      }),
    ),
  ),
);

it.effect('always configures the Commerce two-factor plugin with the provider delivery callback', () =>
  parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@localhost/commerce_auth',
    COMMERCE_PORTAL_AUTH_SECRET: 'a'.repeat(32),
    COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
  }).pipe(
    Effect.flatMap((configuration) =>
      makeCommercePortalAuthOptions({
        configuration,
        databaseAdapter: testDatabaseAdapter,
        emailDelivery: {
          sendOTP: otpDeliveryCallback,
          sendResetPassword: () => Promise.resolve(),
          sendVerificationEmail: () => Promise.resolve(),
        },
      }),
    ),
    Effect.tap((options) =>
      Effect.sync(() => {
        const [plugin] = options.plugins ?? [];
        expect(plugin?.id).toBe('two-factor');
        expect(plugin?.options?.otpOptions?.sendOTP).toBe(otpDeliveryCallback);
      }),
    ),
  ),
);

it.effect('passes explicitly configured Better Auth rotation keys without exposing them', () =>
  parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@localhost/commerce_auth',
    COMMERCE_PORTAL_AUTH_SECRET: 'a'.repeat(32),
    COMMERCE_PORTAL_AUTH_SECRETS: `2:${'b'.repeat(32)},1:${'c'.repeat(32)}`,
    COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
  }).pipe(
    Effect.flatMap((configuration) =>
      makeCommercePortalAuthOptions({
        configuration,
        databaseAdapter: testDatabaseAdapter,
        emailDelivery: {
          sendOTP: otpDeliveryCallback,
          sendResetPassword: () => Promise.resolve(),
          sendVerificationEmail: () => Promise.resolve(),
        },
      }),
    ),
    Effect.tap((options) =>
      Effect.sync(() => {
        expect(options.secrets).toStrictEqual([
          { value: 'b'.repeat(32), version: 2 },
          { value: 'c'.repeat(32), version: 1 },
        ]);
      }),
    ),
  ),
);

it.effect('keeps the provider operation identifier exact', () =>
  Effect.sync(() => {
    expect(COMMERCE_PORTAL_AUTH_VERIFY_OPERATION).toBe(
      'commerce-portal-authentication.verify-external-authentication.v1',
    );
    expect(Schema.is(CommerceSessionReferenceSchema)(sessionRef)).toBe(true);
    expect(Schema.is(CommerceSessionReferenceSchema)('better-auth-session:other.v1:session_safe-1')).toBe(false);
    expect(CommercePortalAuthSessionReadUnavailable).toBeDefined();
    expect(CommercePortalAuthAccountCreationService).toBeDefined();
    expect(CommercePortalAuthAccountCreationRejected).toBeDefined();
  }),
);

it.effect('normalizes the address once before the duplicate guard, the provider call and the persistence check', () => {
  const probedEmails: string[] = [];
  let providerBody: unknown;
  const auth: CommercePortalAuthAccountCreationProvider = {
    api: {
      sendVerificationEmail: () => Effect.void,
      signUpEmail: (signUpRequest) => {
        providerBody = signUpRequest;
        return providerSuccess({ user: { id: providerSubjectId } });
      },
    },
  };
  return makeAccountGateway(auth, {
    existsByEmail: ({ email }) =>
      Effect.sync(() => {
        probedEmails.push(email);
        return false;
      }),
    existsByProviderSubject: ({ email }) =>
      Effect.sync(() => {
        probedEmails.push(email ?? '');
        return true;
      }),
    subjectForOwnerInvocation: () => Effect.succeedNone,
  }).pipe(
    Effect.flatMap((gateway) =>
      gateway.create({
        email: ' Buyer@Example.TEST ',
        enrollmentAttemptId,
        name: 'Buyer',
        ownerInvocationId,
        password: testPassword,
        tenantId,
      }),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        // The stored column holds the normalized form, so a guard comparing the caller's casing
        // would miss the existing row and let a second account through for the same address.
        expect(probedEmails).toStrictEqual(['buyer@example.test', 'buyer@example.test']);
        expect(providerBody).toStrictEqual({
          body: { email: 'buyer@example.test', name: 'Buyer', password: 'P'.repeat(24) },
          headers: {
            'x-commerce-portal-account-attempt': enrollmentAttemptId,
            'x-commerce-portal-account-owner-invocation': ownerInvocationId,
            'x-commerce-portal-account-tenant': tenantId,
          },
        });
      }),
    ),
  );
});
