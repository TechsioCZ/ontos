import type {
  ConnectApproveRequest,
  ConnectApproveResponse,
  ConnectDenyRequest,
  ConnectDenyResponse,
  ConnectDraftRequest,
  ConnectDraftResponse,
  ConnectDraftSummary,
  ConnectOptions,
} from '@app/shared-contracts/oauth-connections';
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type { HttpClientError } from '@modern-js/bff-effect/effect-client';
import { Effect, Match, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

import { ShellAuthenticationApi, shellAuthenticationApiContract } from '../../../../shared/api.ts';
import type { OAuthConnectProblem } from '../../../../shared/oauth-connect-api.ts';
import { navigationTarget } from './connect-view-model.ts';
import type { ConnectFailure } from './connect-view-model.ts';

const BETTER_AUTH_CONTINUE_PATH = '/shell-super-app-api/oauth/oauth2/continue';
const BETTER_AUTH_CONSENT_PATH = '/shell-super-app-api/oauth/oauth2/consent';

export type ConnectOutcome<Value> =
  | { readonly reason: ConnectFailure; readonly status: 'failed' }
  | { readonly status: 'ok'; readonly value: Value };

interface Failed {
  readonly reason: ConnectFailure;
  readonly status: 'failed';
}

const failed = (reason: ConnectFailure): Failed => ({ reason, status: 'failed' });

const client = makeEffectHttpApiClient(ShellAuthenticationApi, {
  transformClient: HttpClient.mapRequest((request) =>
    HttpClientRequest.prependUrl(request, shellAuthenticationApiContract.apiPrefix),
  ),
});

type ConnectClientError = OAuthConnectProblem | HttpClientError.HttpClientError | Schema.SchemaError;

const toOutcome = <Value>(operation: Effect.Effect<Value, ConnectClientError>): Effect.Effect<ConnectOutcome<Value>> =>
  operation.pipe(
    Effect.timeout('30 seconds'),
    Effect.match({
      onFailure: (error) =>
        Match.value(error).pipe(
          Match.tag('OAuthConnectNotFoundProblem', (problem) =>
            failed(problem.code === 'connection_active' ? 'connected' : 'expired'),
          ),
          Match.tag('OAuthConnectInvalidProblem', () => failed('expired')),
          Match.tag('OAuthConnectUnauthorizedProblem', () => failed('signedOut')),
          Match.tag('OAuthConnectForbiddenProblem', (problem) =>
            failed(problem.code === 'acting_principal_forbidden' ? 'agentGone' : 'forbidden'),
          ),
          Match.tag('HttpClientError', 'SchemaError', 'TimeoutError', 'OAuthConnectUnavailableProblem', () =>
            failed('error'),
          ),
          Match.exhaustive,
        ),
      onSuccess: (value): ConnectOutcome<Value> => ({ status: 'ok', value }),
    }),
  );

export const loadConnectOptions = Effect.fn('OAuthConnect.loadOptions')(
  (oauthQuery: string): Effect.Effect<ConnectOutcome<ConnectOptions>> =>
    toOutcome(client.pipe(Effect.flatMap((api) => api.oauthConnect.connectOptions({ payload: { oauthQuery } })))),
);

export const createDraft = Effect.fn('OAuthConnect.createDraft')(
  (request: ConnectDraftRequest): Effect.Effect<ConnectOutcome<ConnectDraftResponse>> =>
    toOutcome(client.pipe(Effect.flatMap((api) => api.oauthConnect.connectDraft({ payload: request })))),
);

export const loadDraftSummary = Effect.fn('OAuthConnect.loadDraftSummary')(
  (oauthQuery: string): Effect.Effect<ConnectOutcome<ConnectDraftSummary>> =>
    toOutcome(client.pipe(Effect.flatMap((api) => api.oauthConnect.connectDraftSummary({ payload: { oauthQuery } })))),
);

export const approveDraft = Effect.fn('OAuthConnect.approveDraft')(
  (
    grantId: ConnectApproveRequest['grantId'],
    oauthQuery: string,
  ): Effect.Effect<ConnectOutcome<ConnectApproveResponse>> =>
    toOutcome(
      client.pipe(Effect.flatMap((api) => api.oauthConnect.connectApprove({ payload: { grantId, oauthQuery } }))),
    ),
);

/** `grantId` null when the person cancels on screen 2 before any draft exists. */
export const denyConnection = Effect.fn('OAuthConnect.deny')(
  (grantId: ConnectDenyRequest['grantId'], oauthQuery: string): Effect.Effect<ConnectOutcome<ConnectDenyResponse>> =>
    toOutcome(
      client.pipe(Effect.flatMap((api) => api.oauthConnect.connectDeny({ payload: { grantId, oauthQuery } }))),
    ).pipe(
      Effect.map((outcome) =>
        outcome.status === 'ok' && navigationTarget({ url: outcome.value.redirectTo }, false, '') === undefined
          ? failed('error')
          : outcome,
      ),
    ),
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const ProblemCode = Schema.Struct({ code: Schema.optionalKey(Schema.String) });
// Better Auth owns the body; only these transport fields affect the hand-off. Their values can be non-string.
const HandoffResponseSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.Json),
  redirect_uri: Schema.optionalKey(Schema.Json),
  url: Schema.optionalKey(Schema.Json),
});

const failureOf = (status: number, code: string | undefined): ConnectFailure => {
  if (status === 404 && code === 'connection_active') {
    return 'connected';
  }
  if (status === 401) {
    return 'signedOut';
  }
  if (status === 400 || status === 404) {
    return 'expired';
  }
  if (status === 403 && code === 'acting_principal_forbidden') {
    return 'agentGone';
  }
  return status === 403 ? 'forbidden' : 'error';
};

/** Better Auth owns these hand-off responses, including the final URL of a followed redirect. */
const navigateTo = Effect.fn('OAuthConnect.handoff')(
  (path: string, body: Schema.Json): Effect.Effect<ConnectOutcome<string>, never, HttpClient.HttpClient> =>
    Effect.gen(function* navigateToEffect() {
      const encodedBody = yield* encodeJson(body);
      const http = yield* HttpClient.HttpClient;
      const requestUrl = new URL(path, globalThis.location.href).href;
      const response = yield* http.execute(
        HttpClientRequest.post(requestUrl).pipe(
          HttpClientRequest.setHeader('accept', 'application/json'),
          HttpClientRequest.bodyText(encodedBody, 'application/json'),
        ),
      );
      const ok = response.status >= 200 && response.status < 300;
      const json = yield* response.json.pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(HandoffResponseSchema)(value).pipe(
            Effect.orElseSucceed((): typeof HandoffResponseSchema.Type => ({})),
          ),
        ),
        Effect.catch((error) => (ok ? Effect.fail(error) : Effect.succeed(null))),
      );
      if (!ok) {
        const problem = yield* Schema.decodeUnknownEffect(ProblemCode)(json).pipe(
          Effect.orElseSucceed((): typeof ProblemCode.Type => ({})),
        );
        return failed(failureOf(response.status, problem.code));
      }
      const target = navigationTarget(json, response.url !== requestUrl, response.url);
      return target === undefined ? failed('error') : { status: 'ok' as const, value: target };
    }).pipe(
      Effect.timeout('30 seconds'),
      Effect.orElseSucceed(() => failed('error')),
    ),
);

/** Screen 2 hand-off: Better Auth continues the authorization after login (postLogin). */
export const continueOAuth = Effect.fn('OAuthConnect.continue')((oauthQuery: string) =>
  navigateTo(BETTER_AUTH_CONTINUE_PATH, { oauth_query: oauthQuery, postLogin: true }),
);

/** Screen 3 hand-off: Better Auth issues the code after consent. */
export const consentOAuth = Effect.fn('OAuthConnect.consent')((oauthQuery: string) =>
  navigateTo(BETTER_AUTH_CONSENT_PATH, { accept: true, oauth_query: oauthQuery }),
);

/** Screen 2 "Pokračovat": create the draft, then continue the authorization. */
export const createDraftAndContinue = Effect.fn('OAuthConnect.createAndContinue')((request: ConnectDraftRequest) =>
  createDraft(request).pipe(
    Effect.filterOrElse(
      (outcome) => outcome.status === 'failed',
      () => continueOAuth(request.oauthQuery),
    ),
  ),
);

/** Screen 3 "Povolit přístup": approve the draft, then issue the code. */
export const approveDraftAndConsent = Effect.fn('OAuthConnect.approveAndConsent')(
  (grantId: ConnectApproveRequest['grantId'], oauthQuery: string) =>
    approveDraft(grantId, oauthQuery).pipe(
      Effect.filterOrElse(
        (outcome) => outcome.status === 'failed',
        () => consentOAuth(oauthQuery),
      ),
    ),
);
