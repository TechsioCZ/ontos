/** The owning Effect API client maps connection responses to the panels' explicit UI outcomes. */
import type {
  ConnectionAdminListRequest,
  ConnectionAdminListResponse,
  ConnectionListResponse,
  ConnectionMutationResponse,
  ConnectionRevokeRequest,
  ConnectionUpdateRequest,
} from '@app/shared-contracts/agent-access';
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Effect, Match, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

import { ShellAuthenticationApi, shellAuthenticationApiContract } from '../../../../shared/api.ts';
import type { IdentityClientError } from '../../../api/auth-client.ts';

export const ConnectionsFailureSchema = Schema.Literals([
  'conflict',
  'error',
  'forbidden',
  'invalid',
  'notFound',
  'signedOut',
]);
export type ConnectionsFailure = typeof ConnectionsFailureSchema.Type;

export type ConnectionsOutcome<Value> =
  | { readonly detail: string | null; readonly reason: ConnectionsFailure; readonly status: 'failed' }
  | { readonly status: 'ok'; readonly value: Value };

const client = makeEffectHttpApiClient(ShellAuthenticationApi, {
  transformClient: HttpClient.mapRequest((request) =>
    HttpClientRequest.prependUrl(request, shellAuthenticationApiContract.apiPrefix),
  ),
});

const failed = (reason: ConnectionsFailure, detail: string | null) => ({ detail, reason, status: 'failed' as const });

const toOutcome = <Value>(
  operation: Effect.Effect<Value, IdentityClientError>,
): Effect.Effect<ConnectionsOutcome<Value>> =>
  operation.pipe(
    Effect.timeout('30 seconds'),
    Effect.match({
      onFailure: (error) =>
        Match.value(error).pipe(
          Match.tag('ShellAuthenticationRequiredProblem', () => failed('signedOut', null)),
          Match.tag('ShellTargetForbiddenProblem', (problem) => failed('forbidden', problem.detail)),
          Match.tag('ShellTargetNotFoundProblem', (problem) => failed('notFound', problem.detail)),
          Match.tag('ShellPolicyConflictProblem', (problem) => failed('conflict', problem.detail)),
          Match.tag('ShellPolicyUnprocessableProblem', (problem) => failed('invalid', problem.detail)),
          Match.tag('ShellInvalidRequestProblem', () => failed('invalid', null)),
          Match.tag(
            'HttpClientError',
            'SchemaError',
            'TimeoutError',
            'ShellPreconditionRequiredProblem',
            'ShellRateLimitedProblem',
            'ShellCapabilityUnavailableProblem',
            'ShellInternalProblem',
            () => failed('error', null),
          ),
          Match.exhaustive,
        ),
      onSuccess: (value): ConnectionsOutcome<Value> => ({ status: 'ok', value }),
    }),
  );

export const loadMyConnections: Effect.Effect<ConnectionsOutcome<ConnectionListResponse>> = toOutcome(
  client.pipe(Effect.flatMap((api) => api.oauthConnectionsAdmin.listMyConnections({ payload: {} }))),
);

export const loadCompanyConnections = Effect.fn('Connections.loadCompany')(
  (request: ConnectionAdminListRequest): Effect.Effect<ConnectionsOutcome<ConnectionAdminListResponse>> =>
    toOutcome(
      client.pipe(Effect.flatMap((api) => api.oauthConnectionsAdmin.listCompanyConnections({ payload: request }))),
    ),
);

export const updateConnectionAccess = Effect.fn('Connections.updateAccess')(
  (request: ConnectionUpdateRequest): Effect.Effect<ConnectionsOutcome<ConnectionMutationResponse>> =>
    toOutcome(
      client.pipe(Effect.flatMap((api) => api.oauthConnectionsAdmin.updateConnectionAccess({ payload: request }))),
    ),
);

export const revokeConnection = Effect.fn('Connections.revoke')(
  (request: ConnectionRevokeRequest): Effect.Effect<ConnectionsOutcome<ConnectionMutationResponse>> =>
    toOutcome(client.pipe(Effect.flatMap((api) => api.oauthConnectionsAdmin.revokeConnection({ payload: request })))),
);
