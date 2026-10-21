// @effect-diagnostics globalFetch:off globalFetchInEffect:off asyncFunction:off preferSchemaOverJson:off -- Browser boundary: the connect screens call the session-authenticated connect endpoints and Better Auth directly from the shell origin. expires: 2027-03-31.
import {
  ConnectApproveResponseSchema,
  ConnectDenyResponseSchema,
  ConnectDraftResponseSchema,
  ConnectDraftSummarySchema,
  ConnectOptionsSchema,
  OAUTH_CONNECTION_PATHS,
} from '@app/shared-contracts/oauth-connections';
import type { ConnectDraftRequest } from '@app/shared-contracts/oauth-connections';
import { Effect, Schema } from 'effect';

import { navigationTarget } from './connect-view-model.ts';
import type { ConnectFailure } from './connect-view-model.ts';

const BETTER_AUTH_CONTINUE_PATH = '/shell-super-app-api/oauth/oauth2/continue';
const BETTER_AUTH_CONSENT_PATH = '/shell-super-app-api/oauth/oauth2/consent';

export type ConnectOutcome<Value> =
  | { readonly reason: ConnectFailure; readonly status: 'failed' }
  | { readonly status: 'ok'; readonly value: Value };

type Failed = { readonly reason: ConnectFailure; readonly status: 'failed' };
type Answer =
  | Failed
  | { readonly json: unknown; readonly redirected: boolean; readonly status: 'ok'; readonly url: string };

const failed = (reason: ConnectFailure): Failed => ({ reason, status: 'failed' });

const failureOf = (status: number): ConnectFailure => {
  if (status === 401) {
    return 'signedOut';
  }
  if (status === 400 || status === 404) {
    return 'expired';
  }
  if (status === 403) {
    return 'forbidden';
  }
  return 'error';
};

/** POSTs one JSON body with the session cookie; a 2xx answer is returned as raw JSON for the caller's schema. */
const sendJson = (path: string, body: unknown): Promise<Answer> =>
  fetch(path, {
    body: JSON.stringify(body),
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    method: 'POST',
  }).then((response): Promise<Answer> => {
    if (!response.ok) {
      return Promise.resolve(failed(failureOf(response.status)));
    }
    return response.json().then((json: unknown): Answer => ({ json, redirected: response.redirected, status: 'ok', url: response.url }));
  }).catch((): Answer => failed('error'));

const postJson = (path: string, body: unknown): Effect.Effect<Answer> => Effect.promise(() => sendJson(path, body));

/** Posts to an OntOS connect endpoint and decodes a 2xx answer with its contract schema. */
const callDecoded = <Value, Err>(
  path: string,
  body: unknown,
  decode: (input: unknown) => Effect.Effect<Value, Err>,
): Effect.Effect<ConnectOutcome<Value>> =>
  postJson(path, body).pipe(
    Effect.flatMap(
      (answer): Effect.Effect<ConnectOutcome<Value>> => {
        if (answer.status === 'failed') {
          return Effect.succeed(answer);
        }
        return decode(answer.json).pipe(
          Effect.map((value): ConnectOutcome<Value> => ({ status: 'ok', value })),
          Effect.orElseSucceed((): ConnectOutcome<Value> => failed('error')),
        );
      },
    ),
  );

const decodeOptions = Schema.decodeUnknownEffect(ConnectOptionsSchema);
const decodeDraft = Schema.decodeUnknownEffect(ConnectDraftResponseSchema);
const decodeSummary = Schema.decodeUnknownEffect(ConnectDraftSummarySchema);
const decodeApprove = Schema.decodeUnknownEffect(ConnectApproveResponseSchema);
const decodeDeny = Schema.decodeUnknownEffect(ConnectDenyResponseSchema);

export const loadConnectOptions = (oauthQuery: string) =>
  callDecoded(OAUTH_CONNECTION_PATHS.connectOptions, { oauthQuery }, decodeOptions);

export const createDraft = (request: ConnectDraftRequest) =>
  callDecoded(OAUTH_CONNECTION_PATHS.connectDraft, request, decodeDraft);

export const loadDraftSummary = (oauthQuery: string) =>
  callDecoded(OAUTH_CONNECTION_PATHS.connectDraftSummary, { oauthQuery }, decodeSummary);

export const approveDraft = (grantId: string, oauthQuery: string) =>
  callDecoded(OAUTH_CONNECTION_PATHS.connectApprove, { grantId, oauthQuery }, decodeApprove);

/** `grantId` null when the person cancels on screen 2 before any draft exists. */
export const denyConnection = (grantId: string | null, oauthQuery: string) =>
  callDecoded(OAUTH_CONNECTION_PATHS.connectDeny, { grantId, oauthQuery }, decodeDeny);

const navigateTo = (path: string, body: unknown): Effect.Effect<ConnectOutcome<string>> =>
  postJson(path, body).pipe(
    Effect.map((answer): ConnectOutcome<string> => {
      if (answer.status === 'failed') {
        return answer;
      }
      const target = navigationTarget(answer.json, answer.redirected, answer.url);
      return target === undefined ? failed('error') : { status: 'ok', value: target };
    }),
  );

/** Screen 2 hand-off: Better Auth continues the authorization after login (postLogin). */
export const continueOAuth = (oauthQuery: string): Effect.Effect<ConnectOutcome<string>> =>
  navigateTo(BETTER_AUTH_CONTINUE_PATH, { oauth_query: oauthQuery, postLogin: true });

/** Screen 3 hand-off: Better Auth issues the code after consent. */
export const consentOAuth = (oauthQuery: string): Effect.Effect<ConnectOutcome<string>> =>
  navigateTo(BETTER_AUTH_CONSENT_PATH, { accept: true, oauth_query: oauthQuery });

/** Screen 2 "Pokračovat": create the draft, then continue the authorization. */
export const createDraftAndContinue = (request: ConnectDraftRequest): Effect.Effect<ConnectOutcome<string>> =>
  createDraft(request).pipe(
    Effect.flatMap(
      (draft): Effect.Effect<ConnectOutcome<string>> =>
        draft.status === 'failed' ? Effect.succeed(draft) : continueOAuth(request.oauthQuery),
    ),
  );

/** Screen 3 "Povolit přístup": approve the draft, then issue the code. */
export const approveDraftAndConsent = (grantId: string, oauthQuery: string): Effect.Effect<ConnectOutcome<string>> =>
  approveDraft(grantId, oauthQuery).pipe(
    Effect.flatMap(
      (approved): Effect.Effect<ConnectOutcome<string>> =>
        approved.status === 'failed' ? Effect.succeed(approved) : consentOAuth(oauthQuery),
    ),
  );
