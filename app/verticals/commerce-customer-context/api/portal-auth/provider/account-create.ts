import { isAPIError } from 'better-auth/api';
import type { Auth } from 'better-auth';
import { Duration, Effect, Layer, Option, Redacted, Schema } from 'effect';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  ExternalUserSubjectSchema,
} from '../../../shared/portal-auth-contracts.ts';
import { CommerceEnrollmentProofService } from '../enrollment-proof-port.ts';
import { CommercePortalAuthInstance } from './auth.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from './config.ts';
import type { CommercePortalAuthAccountCreationGateway } from './account-creation-gateway-service.ts';
import { CommercePortalAuthAccountCreationService } from './account-creation-service.ts';
import { CommercePortalAuthAccountCreationInvalidRequest } from './account-creation-invalid-request.ts';
import { CommercePortalAuthAccountCreationRejected } from './account-creation-rejected.ts';
import { CommercePortalAuthAccountCreationUnavailable } from './account-creation-unavailable.ts';
import { CommercePortalAuthAccountCreationProviderService } from './account-creation-provider-service.ts';
import { CommercePortalAuthAccountLookupService } from './account-lookup-service.ts';
import { CommercePortalAuthAccountCreationGatewayService } from './account-creation-gateway-service.ts';

export { CommercePortalAuthAccountCreationInvalidRequest } from './account-creation-invalid-request.ts';
export { CommercePortalAuthAccountCreationRejected } from './account-creation-rejected.ts';
export { CommercePortalAuthAccountCreationUnavailable } from './account-creation-unavailable.ts';
export { CommercePortalAuthAccountCreationGatewayService } from './account-creation-gateway-service.ts';
export { CommercePortalAuthAccountCreationProviderService } from './account-creation-provider-service.ts';
export { CommercePortalAuthAccountCreationService } from './account-creation-service.ts';
export { CommercePortalAuthAccountLookupService } from './account-lookup-service.ts';
export type { CommercePortalAuthAccountLookup } from './account-lookup-service.ts';
export type { CommercePortalAuthAccountCreationGateway } from './account-creation-gateway-service.ts';

const uuid = Schema.String.check(Schema.isUUID());
const enrollmentAttemptId = uuid.pipe(Schema.brand('EnrollmentAttemptId'));
const name = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200));
const email = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(3), Schema.isMaxLength(320));
const ownerInvocationId = uuid.pipe(Schema.brand('ActionInvocationId'));
const password = Schema.Redacted(Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128)));
const tenantId = uuid.pipe(Schema.brand('TenantId'));
/** Provider failure codes are bounded diagnostic text; an oversized or empty code is unusable. */
const providerCode = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const BetterAuthAccountCreateResponseSchema = Schema.Struct({
  // Better Auth may also return a token or other provider fields. The adapter deliberately
  // decodes only the user subject and never projects those fields into its result.
  user: Schema.Struct({ id: Schema.String }),
});
const UNUSABLE_ACCOUNT_RESPONSE_REASON = 'Better Auth returned an unusable account response';

/** Private service input. The password must already be redacted by the owner boundary. */
export const CommercePortalAccountCreateInputSchema = Schema.Struct({
  email,
  enrollmentAttemptId,
  name,
  ownerInvocationId,
  password,
  tenantId,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommercePortalAccountCreateInput = typeof CommercePortalAccountCreateInputSchema.Type;
export type CommercePortalAccountCreateInputBoundary = Schema.Codec.Encoded<
  typeof CommercePortalAccountCreateInputSchema
>;

/**
 * Better Auth exposes storage failures through the same 422 status used by some validation and
 * conflict responses. Only these stable request-side codes are safe to report as a rejection;
 * unknown codes, including FAILED_TO_CREATE_USER, fail closed as provider unavailability.
 */
const DEFINITIVE_ACCOUNT_CREATION_REJECTION_CODES = new Set<string>([
  'BODY_MUST_BE_AN_OBJECT',
  'FIELD_NOT_ALLOWED',
  'INVALID_EMAIL',
  'INVALID_PASSWORD',
  'MISSING_FIELD',
  'PASSWORD_TOO_LONG',
  'PASSWORD_TOO_SHORT',
  'USER_ALREADY_EXISTS',
  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  'VALIDATION_ERROR',
]);

const CommercePortalAuthAccountCreationProviderFailureFields = {
  providerCode: Schema.optionalKey(providerCode),
  providerUnavailable: Schema.Boolean,
} as const;
const CommercePortalAuthAccountCreationProviderFailureSchema = Schema.TaggedStruct(
  'CommercePortalAuthAccountCreationProviderFailure',
  CommercePortalAuthAccountCreationProviderFailureFields,
);
const CommercePortalAuthAccountCreationProviderFailureValue = Schema.TaggedError<
  typeof CommercePortalAuthAccountCreationProviderFailureSchema.Type
>()('CommercePortalAuthAccountCreationProviderFailure', CommercePortalAuthAccountCreationProviderFailureFields);
type CommercePortalAuthAccountCreationProviderFailure = InstanceType<
  typeof CommercePortalAuthAccountCreationProviderFailureValue
>;

const withCause = <ErrorType extends object>(error: ErrorType, cause: unknown): ErrorType =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

/**
 * Reads the stable request-side provider code from a Better Auth API error. Anything else — a
 * foreign throwable, a missing code, or text outside the bounded grammar — yields no code, so the
 * mapper below cannot infer a rejection from an unknown provider payload.
 */
const providerCodeOf = (cause: unknown): string | undefined => {
  if (!isAPIError(cause)) {
    return undefined;
  }
  const { body: apiBody } = cause;
  const { code: candidateCode } = apiBody ?? {};
  return Schema.is(providerCode)(candidateCode) ? candidateCode : undefined;
};

/**
 * Classifies a provider throwable once, at its source: `providerUnavailable` is set whenever the
 * throwable is not a Better Auth API error, and the code is kept only when it is bounded text. The
 * raw throwable never enters a schema field; it stays on the non-schema `cause` property.
 */
const providerCallFailure = (cause: unknown): CommercePortalAuthAccountCreationProviderFailure => {
  const providerUnavailable = !isAPIError(cause);
  const code = providerCodeOf(cause);
  // The bounded code is left off the value entirely when absent: a missing code must stay a
  // genuine absence rather than an explicit `undefined` under `exactOptionalPropertyTypes`.
  const failure =
    code === undefined
      ? new CommercePortalAuthAccountCreationProviderFailureValue({ providerUnavailable })
      : new CommercePortalAuthAccountCreationProviderFailureValue({ providerCode: code, providerUnavailable });
  return withCause(failure, cause);
};

/**
 * Splits a classified provider failure into the owner's rejection/unavailable pair. Only a provider
 * API error carrying a definitive request-side code is a rejection; an unavailable provider, an
 * absent code and an unknown code all stay fail-closed as provider unavailability.
 */
const mapBetterAuthAccountCreationFailure = (
  cause: unknown,
): CommercePortalAuthAccountCreationRejected | CommercePortalAuthAccountCreationUnavailable => {
  if (Schema.is(CommercePortalAuthAccountCreationUnavailable)(cause)) {
    return cause;
  }
  const providerFailure = Schema.is(CommercePortalAuthAccountCreationProviderFailureValue)(cause)
    ? cause
    : providerCallFailure(cause);
  const { providerCode: code, providerUnavailable } = providerFailure;
  const failure =
    !providerUnavailable && code !== undefined && DEFINITIVE_ACCOUNT_CREATION_REJECTION_CODES.has(code)
      ? new CommercePortalAuthAccountCreationRejected({
          reason: 'Better Auth rejected the Commerce portal account creation request',
        })
      : new CommercePortalAuthAccountCreationUnavailable({
          reason: 'Better Auth account creation is unavailable',
        });
  return withCause(failure, cause);
};

const enrollmentProofRejected = () =>
  Effect.fail(
    new CommercePortalAuthAccountCreationRejected({
      reason: 'The enrollment Attempt did not authorize this account creation invocation',
    }),
  );
const enrollmentProofUnavailable = () =>
  Effect.fail(
    new CommercePortalAuthAccountCreationUnavailable({
      reason: 'The enrollment Attempt authorization is unavailable',
    }),
  );

export interface CommercePortalAuthCreatedAccount {
  readonly providerSubjectId: string;
}

/** Narrow provider API used by the private gateway; no Better Auth handler leaks across the seam. */
export interface CommercePortalAuthAccountCreationProvider {
  readonly api: {
    readonly signUpEmail: (
      input: Parameters<Auth['api']['signUpEmail']>[0],
    ) => Effect.Effect<Option.Option<CommercePortalAuthAccountCreateResponse>, Error>;
  };
}

/** Provider response shape before the schema decoder projects only the subject id. */
export interface CommercePortalAuthAccountCreateResponse {
  readonly token?: string | null;
  readonly user?: {
    readonly id?: string;
  };
}

/**
 * Real Better Auth adapter seam. It intentionally projects the response to the provider subject
 * id and discards any raw session token returned by Better Auth.
 */
export const makeCommercePortalAuthAccountCreationGateway = Effect.fn('CommercePortalAuthAccountCreationGateway.make')(
  function* makeCommercePortalAuthAccountCreationGatewayEffect(): Effect.fn.Return<
    CommercePortalAuthAccountCreationGateway,
    never,
    CommercePortalAuthAccountCreationProviderService | CommercePortalAuthAccountLookupService
  > {
    const auth = yield* CommercePortalAuthAccountCreationProviderService;
    const accountLookup = yield* CommercePortalAuthAccountLookupService;
    const create = Effect.fn('CommercePortalAuthAccountCreationGateway.create')(function* createAccount(
      input: Pick<CommercePortalAccountCreateInput, 'email' | 'name' | 'password'>,
    ): Effect.fn.Return<
      CommercePortalAuthCreatedAccount,
      CommercePortalAuthAccountCreationRejected | CommercePortalAuthAccountCreationUnavailable
    > {
      // This is only a provider-local duplicate guard. It never identifies an existing account to
      // the caller or treats email equality as continuity for a Core subject/binding.
      const alreadyExists = yield* accountLookup.existsByEmail({ email: input.email });
      if (alreadyExists) {
        return yield* new CommercePortalAuthAccountCreationRejected({
          reason: 'Commerce portal account creation did not produce a new account',
        });
      }

      const providerRequest = {
        body: {
          email: input.email,
          name: input.name,
          password: Redacted.value(input.password),
        },
      };
      const responseOption = yield* auth.api.signUpEmail(providerRequest).pipe(
        Effect.mapError(mapBetterAuthAccountCreationFailure),
        Effect.timeoutOrElse({
          duration: Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.accountCreation.providerCallTimeoutMilliseconds),
          orElse: () =>
            Effect.fail(
              new CommercePortalAuthAccountCreationUnavailable({
                reason: 'Better Auth account creation timed out',
              }),
            ),
        }),
      );
      if (Option.isNone(responseOption)) {
        return yield* new CommercePortalAuthAccountCreationUnavailable({
          reason: UNUSABLE_ACCOUNT_RESPONSE_REASON,
        });
      }
      const { value: response } = responseOption;
      if (!Schema.is(BetterAuthAccountCreateResponseSchema)(response)) {
        return yield* new CommercePortalAuthAccountCreationUnavailable({
          reason: UNUSABLE_ACCOUNT_RESPONSE_REASON,
        });
      }
      const decodedResponse = yield* Schema.decodeEffect(BetterAuthAccountCreateResponseSchema)(response).pipe(
        Effect.mapError((cause) =>
          withCause(
            new CommercePortalAuthAccountCreationUnavailable({
              reason: UNUSABLE_ACCOUNT_RESPONSE_REASON,
            }),
            cause,
          ),
        ),
      );
      const providerSubject = yield* Schema.decodeEffect(ExternalUserSubjectSchema)({
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        providerSubjectId: decodedResponse.user.id,
        subjectType: 'user',
      }).pipe(
        Effect.mapError((cause) =>
          withCause(
            new CommercePortalAuthAccountCreationUnavailable({
              reason: 'Better Auth returned an unusable account identity',
            }),
            cause,
          ),
        ),
      );
      const { providerSubjectId } = providerSubject;
      const persisted = yield* accountLookup.existsByProviderSubjectAndEmail({
        email: input.email,
        providerSubjectId,
      });
      if (!persisted) {
        return yield* new CommercePortalAuthAccountCreationRejected({
          reason: 'Better Auth did not persist a new Commerce portal account',
        });
      }
      // `response.token` is deliberately never read or copied into the result.
      return { providerSubjectId };
    });
    return { create };
  },
);

export interface CommercePortalAccountCreateResult {
  readonly enrollmentAttemptId: string;
  readonly evidenceRef: string;
  readonly outcome: 'CREATED';
  readonly providerSubjectId: string;
  readonly revision: number;
}

export type CommercePortalAuthAccountCreationFailure =
  | CommercePortalAuthAccountCreationInvalidRequest
  | CommercePortalAuthAccountCreationRejected
  | CommercePortalAuthAccountCreationUnavailable;

/**
 * Account creation is a two-party operation: the owner-local Attempt service authorizes the exact
 * invocation first, then the provider performs one Better Auth effect. No public sign-up seam is
 * created here, and no provider token crosses this port.
 */
export const makeCommercePortalAuthAccountCreationService = Effect.fn('CommercePortalAuthAccountCreation.make')(
  function* makeCommercePortalAuthAccountCreationServiceEffect(): Effect.fn.Return<
    CommercePortalAuthAccountCreationService['Service'],
    never,
    CommerceEnrollmentProofService | CommercePortalAuthAccountCreationGatewayService
  > {
    const gateway = yield* CommercePortalAuthAccountCreationGatewayService;
    const enrollmentProof = yield* CommerceEnrollmentProofService;
    const createAccount = Effect.fn('CommercePortalAuthAccountCreation.create')(function* create(
      input: CommercePortalAccountCreateInputBoundary,
    ): Effect.fn.Return<CommercePortalAccountCreateResult, CommercePortalAuthAccountCreationFailure> {
      const request = yield* Schema.decodeEffect(CommercePortalAccountCreateInputSchema)(input).pipe(
        Effect.mapError((cause) =>
          withCause(
            new CommercePortalAuthAccountCreationInvalidRequest({
              reason: 'Commerce portal account creation input is invalid',
            }),
            cause,
          ),
        ),
      );

      const proof = yield* enrollmentProof
        .authorizeAccountCreation({
          enrollmentAttemptId: request.enrollmentAttemptId,
          ownerInvocationId: request.ownerInvocationId,
          tenantId: request.tenantId,
        })
        .pipe(
          Effect.map((value) => ({ outcome: 'AUTHORIZED' as const, value })),
          Effect.catchTags({
            CommerceEnrollmentProofRejected: enrollmentProofRejected,
            CommerceEnrollmentProofUnavailable: enrollmentProofUnavailable,
          }),
        );

      const account = yield* gateway.create({
        email: request.email,
        name: request.name,
        password: request.password,
      });
      return {
        enrollmentAttemptId: request.enrollmentAttemptId,
        evidenceRef: proof.value.evidenceRef,
        outcome: 'CREATED' as const,
        providerSubjectId: account.providerSubjectId,
        revision: proof.value.revision,
      };
    });
    return { createAccount };
  },
);

/**
 * Better Auth's Promise API is kept behind this narrow provider-owned Effect bridge. The throwable
 * is classified once here, at its source, so the request-side code of a Better Auth `APIError`
 * survives the crossing while the raw throwable stays on the non-schema `cause` property; anything
 * that is not a provider API error is already marked unavailable and can never become a rejection.
 */
const signUpEmailForRealm =
  (
    auth: Pick<Auth, 'api'>,
  ): ((
    input: Parameters<Auth['api']['signUpEmail']>[0],
  ) => Effect.Effect<
    Option.Option<CommercePortalAuthAccountCreateResponse>,
    CommercePortalAuthAccountCreationProviderFailure
  >) =>
  (input) =>
    Effect.tryPromise({
      catch: providerCallFailure,
      try: auth.api.signUpEmail.bind(auth.api, input),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.accountCreation.providerCallTimeoutMilliseconds),
        orElse: () => Effect.fail(providerCallFailure({ reason: 'PROVIDER_TIMEOUT' })),
      }),
      Effect.map(Option.fromNullishOr),
    );

const makeCommercePortalAuthAccountCreationProvider = (
  auth: Pick<Auth, 'api'>,
): CommercePortalAuthAccountCreationProvider => ({ api: { signUpEmail: signUpEmailForRealm(auth) } });

/** The constructed realm stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthAccountCreationProviderLive = Layer.effect(
  CommercePortalAuthAccountCreationProviderService,
  Effect.gen(function* makeCommercePortalAuthAccountCreationProviderLive() {
    const auth = yield* CommercePortalAuthInstance;
    return makeCommercePortalAuthAccountCreationProvider(auth);
  }),
);

/** The provider-local duplicate guard reads the realm's own account directory, never Core. */
export const CommercePortalAuthAccountCreationGatewayLive = Layer.effect(
  CommercePortalAuthAccountCreationGatewayService,
  makeCommercePortalAuthAccountCreationGateway(),
);

/**
 * The private two-party capability. Its owner half — the Attempt-scoped enrollment proof — and its
 * provider half stay separate visible requirements, so a composition that installs one without the
 * other cannot be built at all.
 */
export const CommercePortalAuthAccountCreationServiceLive = Layer.effect(
  CommercePortalAuthAccountCreationService,
  makeCommercePortalAuthAccountCreationService(),
);
