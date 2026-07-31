import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export interface SafeAuthenticatedIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface AnonymousSession {
  readonly state: 'anonymous';
}

export interface AuthenticatedSession {
  readonly identity: SafeAuthenticatedIdentity;
  readonly state: 'authenticated';
}

export type CurrentSession = AnonymousSession | AuthenticatedSession;

export interface SignInPayload {
  readonly email: string;
  readonly password: string;
}

export interface SignInResponse {
  readonly identity: SafeAuthenticatedIdentity;
}

export interface SignOutResponse {
  readonly signedOut: true;
}

interface ProblemDetails {
  readonly detail: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
}

export interface InvalidCredentialsProblem extends ProblemDetails {
  readonly _tag: 'InvalidCredentialsProblem';
}

export interface OntosIdentityForbiddenProblem extends ProblemDetails {
  readonly _tag: 'OntosIdentityForbiddenProblem';
}

export interface AuthenticationUnavailableProblem extends ProblemDetails {
  readonly _tag: 'AuthenticationUnavailableProblem';
}

export interface AuthenticationInternalProblem extends ProblemDetails {
  readonly _tag: 'AuthenticationInternalProblem';
}

export type AuthenticationProblem =
  | InvalidCredentialsProblem
  | OntosIdentityForbiddenProblem
  | AuthenticationUnavailableProblem
  | AuthenticationInternalProblem;

export const SafeAuthenticatedIdentitySchema: Schema.Codec<SafeAuthenticatedIdentity> =
  Schema.Struct({
    displayName: Schema.String,
    email: Schema.String,
    principalId: Schema.String,
    tenantId: Schema.String,
  });

export const AnonymousSessionSchema: Schema.Codec<AnonymousSession> = Schema.Struct({
  state: Schema.Literal('anonymous'),
});

export const AuthenticatedSessionSchema: Schema.Codec<AuthenticatedSession> = Schema.Struct({
  identity: SafeAuthenticatedIdentitySchema,
  state: Schema.Literal('authenticated'),
});

export const CurrentSessionSchema: Schema.Codec<CurrentSession> = Schema.Union([
  AnonymousSessionSchema,
  AuthenticatedSessionSchema,
]);

export const SignInPayloadSchema: Schema.Codec<SignInPayload> = Schema.Struct({
  email: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.String.check(Schema.isMinLength(1)),
});

export const SignInResponseSchema: Schema.Codec<SignInResponse> = Schema.Struct({
  identity: SafeAuthenticatedIdentitySchema,
});

export const SignOutResponseSchema: Schema.Codec<SignOutResponse> = Schema.Struct({
  signedOut: Schema.Literal(true),
});

const authenticationProblemFields = {
  detail: Schema.String,
  status: Schema.Finite,
  title: Schema.String,
  type: Schema.String,
};

export const InvalidCredentialsProblemSchema = Schema.TaggedStruct('InvalidCredentialsProblem', {
  ...authenticationProblemFields,
}).pipe(HttpApiSchema.status(401));

export const OntosIdentityForbiddenProblemSchema = Schema.TaggedStruct(
  'OntosIdentityForbiddenProblem',
  {
    ...authenticationProblemFields,
  },
).pipe(HttpApiSchema.status(403));

export const AuthenticationUnavailableProblemSchema = Schema.TaggedStruct(
  'AuthenticationUnavailableProblem',
  {
    ...authenticationProblemFields,
  },
).pipe(HttpApiSchema.status(503));

export const AuthenticationInternalProblemSchema = Schema.TaggedStruct(
  'AuthenticationInternalProblem',
  {
    ...authenticationProblemFields,
  },
).pipe(HttpApiSchema.status(500));

export const ShellAuthenticationApi = HttpApi.make('shellAuthenticationApi').add(
  HttpApiGroup.make('authentication')
    .add(
      HttpApiEndpoint.post('signIn', '/auth/sign-in', {
        error: [
          InvalidCredentialsProblemSchema,
          OntosIdentityForbiddenProblemSchema,
          AuthenticationUnavailableProblemSchema,
          AuthenticationInternalProblemSchema,
        ],
        payload: SignInPayloadSchema,
        success: SignInResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('currentSession', '/auth/session', {
        error: [
          InvalidCredentialsProblemSchema,
          OntosIdentityForbiddenProblemSchema,
          AuthenticationUnavailableProblemSchema,
          AuthenticationInternalProblemSchema,
        ],
        success: CurrentSessionSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('signOut', '/auth/sign-out', {
        error: [
          InvalidCredentialsProblemSchema,
          OntosIdentityForbiddenProblemSchema,
          AuthenticationUnavailableProblemSchema,
          AuthenticationInternalProblemSchema,
        ],
        success: SignOutResponseSchema,
      }),
    ),
);

export const shellAuthenticationApiContract = {
  apiPrefix: '/shell-super-app-api',
  currentSessionPath: '/shell-super-app-api/auth/session',
  ownerId: 'shell-super-app',
  signInPath: '/shell-super-app-api/auth/sign-in',
  signOutPath: '/shell-super-app-api/auth/sign-out',
} as const;
