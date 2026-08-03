import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type {
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  HttpClientError,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { ShellAuthenticationApi, shellAuthenticationApiContract } from '../../shared/api.ts';
import type {
  CurrentSession,
  AuthenticationInternalProblem,
  AuthenticationUnavailableProblem,
  InvalidCredentialsProblem,
  OntosIdentityForbiddenProblem,
  SignInPayload,
  SignInResponse,
  SignOutResponse,
} from '../../shared/api.ts';

export { issueGatewayContext } from '@app/shared-contracts';
export type {
  GatewayContextClientError,
  GatewayContextClientOptions,
  GatewayContextRequest,
  GatewayContextResponse,
} from '@app/shared-contracts';

type ShellAuthenticationApiGroups =
  typeof ShellAuthenticationApi extends HttpApi.HttpApi<infer _ApiId, infer Groups>
    ? Groups
    : never;

export type ShellAuthenticationClient = HttpApiClient.Client<
  Extract<ShellAuthenticationApiGroups, HttpApiGroup.Any>,
  never,
  never
>;

export interface ShellAuthenticationClientOptions {
  readonly baseUrl?: string | URL;
  readonly cookie?: string;
  readonly locale?: string;
}

export type ShellAuthenticationClientError =
  | InvalidCredentialsProblem
  | OntosIdentityForbiddenProblem
  | AuthenticationUnavailableProblem
  | AuthenticationInternalProblem
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export type ShellAuthenticationClientEffect<Success> = Effect.Effect<
  Success,
  ShellAuthenticationClientError
>;

const createShellAuthenticationClient = (
  options: ShellAuthenticationClientOptions = {},
): Effect.Effect<ShellAuthenticationClient> => {
  const requestContext =
    options.locale === undefined
      ? {}
      : {
          requestContext: {
            locale: options.locale,
          },
        };
  const transformClient =
    options.cookie === undefined
      ? {}
      : {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader('cookie', options.cookie),
          ),
        };

  return makeEffectHttpApiClient(ShellAuthenticationApi, {
    baseUrl: options.baseUrl ?? shellAuthenticationApiContract.apiPrefix,
    ...requestContext,
    ...transformClient,
  });
};

export const signIn = (
  payload: SignInPayload,
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<SignInResponse> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.authentication.signIn({ payload })),
  );

export const currentSession = (
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<CurrentSession> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.authentication.currentSession({})),
  );

export const signOut = (
  options: ShellAuthenticationClientOptions = {},
): ShellAuthenticationClientEffect<SignOutResponse> =>
  createShellAuthenticationClient(options).pipe(
    Effect.flatMap((client) => client.authentication.signOut({})),
  );

export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';
