import { Effect, Match } from 'effect';

import {
  createAccessAdministrationIdempotencyKey,
  decideAccessApproval,
  executeAccessApproval,
  listAccessApprovals,
} from '../../../api/auth-client.ts';
import type { AccessAdministrationClientError } from '../../../api/auth-client.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../shell-authentication-client-options.ts';
import { ApprovalClientFailure } from './approvals-contract.ts';
import type { ApprovalsClient } from './approvals-contract.ts';

type ClientFailure =
  | AccessAdministrationClientError
  | Effect.Error<ReturnType<typeof shellAuthenticationClientOptionsFromRequest>>;

const approvalFailure = (error: ClientFailure): ApprovalClientFailure =>
  new ApprovalClientFailure({
    reason: Match.value(error).pipe(
      Match.tag('AccessAdminAuthenticationRequired', () => 'unauthenticated' as const),
      Match.tag('AccessAdminForbidden', () => 'forbidden' as const),
      Match.tag('AccessAdminConflict', () => 'conflict' as const),
      Match.tag('AccessAdminInvalidRequest', 'AccessAdminUnprocessable', () => 'invalid' as const),
      Match.tag(
        'AccessAdminUnavailable',
        'AccessAdminInternal',
        'HttpClientError',
        'SchemaError',
        'ConfigError',
        () => 'unavailable' as const,
      ),
      Match.exhaustive,
    ),
  });

export const createApprovalKey: Effect.Effect<string, ApprovalClientFailure> = Effect.suspend(() =>
  createAccessAdministrationIdempotencyKey(),
).pipe(Effect.catchTag('PlatformError', () => Effect.fail(new ApprovalClientFailure({ reason: 'unavailable' }))));

/** Native Shell BFF only; execution availability is server-projected and rechecked by the execute endpoint. */
export const approvalsClient: ApprovalsClient = {
  decide: (command, request, idempotencyKey) =>
    shellAuthenticationClientOptionsFromRequest(request).pipe(
      Effect.flatMap((options) => decideAccessApproval(command, { ...options, idempotencyKey })),
      Effect.asVoid,
      Effect.mapError(approvalFailure),
    ),
  execute: (command, request, idempotencyKey) =>
    shellAuthenticationClientOptionsFromRequest(request).pipe(
      Effect.flatMap((options) => executeAccessApproval(command, { ...options, idempotencyKey })),
      Effect.asVoid,
      Effect.mapError(approvalFailure),
    ),
  list: (request, cursor) =>
    shellAuthenticationClientOptionsFromRequest(request).pipe(
      Effect.flatMap((options) =>
        listAccessApprovals(cursor === undefined ? { limit: 25 } : { cursor, limit: 25 }, options),
      ),
      Effect.mapError(approvalFailure),
    ),
};
