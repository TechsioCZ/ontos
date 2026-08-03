import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { GatewayContextApiGroup } from '@app/shared-contracts';

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

export interface ActiveModule {
  readonly moduleKey: string;
  readonly state: 'active';
}

export type ActiveModules = readonly ActiveModule[];

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

export interface ActiveModulesAuthenticationRequiredProblem extends ProblemDetails {
  readonly _tag: 'ActiveModulesAuthenticationRequiredProblem';
}

export interface ActiveModulesUnavailableProblem extends ProblemDetails {
  readonly _tag: 'ActiveModulesUnavailableProblem';
  readonly retryable: true;
}

export interface ActiveModulesInternalProblem extends ProblemDetails {
  readonly _tag: 'ActiveModulesInternalProblem';
}

export type ActiveModulesProblem =
  | ActiveModulesAuthenticationRequiredProblem
  | ActiveModulesUnavailableProblem
  | ActiveModulesInternalProblem;

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

export const ActiveModuleSchema: Schema.Codec<ActiveModule> = Schema.Struct({
  moduleKey: Schema.String,
  state: Schema.Literal('active'),
});

export const ActiveModulesSchema: Schema.Codec<ActiveModules> = Schema.Array(ActiveModuleSchema);

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

export const ActiveModulesAuthenticationRequiredProblemSchema = Schema.TaggedStruct(
  'ActiveModulesAuthenticationRequiredProblem',
  authenticationProblemFields,
).pipe(HttpApiSchema.status(401));

export const ActiveModulesUnavailableProblemSchema = Schema.TaggedStruct(
  'ActiveModulesUnavailableProblem',
  {
    ...authenticationProblemFields,
    retryable: Schema.Literal(true),
  },
).pipe(HttpApiSchema.status(503));

export const ActiveModulesInternalProblemSchema = Schema.TaggedStruct(
  'ActiveModulesInternalProblem',
  authenticationProblemFields,
).pipe(HttpApiSchema.status(500));

export const ShellAuthenticationApi = HttpApi.make('shellAuthenticationApi')
  .add(
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
  )
  .add(
    HttpApiGroup.make('modules').add(
      HttpApiEndpoint.get('activeModules', '/modules/active', {
        error: [
          ActiveModulesAuthenticationRequiredProblemSchema,
          ActiveModulesUnavailableProblemSchema,
          ActiveModulesInternalProblemSchema,
        ],
        success: ActiveModulesSchema,
      }),
    ),
  )
  .add(GatewayContextApiGroup);

export const shellAuthenticationApiContract = {
  activeModulesPath: '/shell-super-app-api/modules/active',
  apiPrefix: '/shell-super-app-api',
  currentSessionPath: '/shell-super-app-api/auth/session',
  issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
  ownerId: 'shell-super-app',
  signInPath: '/shell-super-app-api/auth/sign-in',
  signOutPath: '/shell-super-app-api/auth/sign-out',
} as const;
