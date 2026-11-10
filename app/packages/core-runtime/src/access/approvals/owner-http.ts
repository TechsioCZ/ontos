import { Cause, Effect, Exit, Match, Redacted, Schema } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/http';
import type { HttpServerRequest } from 'effect/http';
import { HttpApiMiddleware } from 'effect/http-api';

import type { TrustedPrincipalContext } from '../../actions/principal-context.ts';
import { transportIdentifier } from '../../actions/string-schemas.ts';
import type { PrincipalAuthenticationProblems } from '../../http/principal-authentication.ts';
import {
  OwnerActionApprovalAuthenticationSchema,
  OwnerActionApprovalConflictSchema,
  OwnerActionApprovalForbiddenSchema,
  OwnerActionApprovalInternalSchema,
  OwnerActionApprovalInvalidSchema,
  OwnerActionApprovalSchemaErrorMiddleware,
  OwnerActionApprovalUnavailableSchema,
} from './owner-api.ts';
import type { OwnerActionApprovalRequest } from './owner-api.ts';
import type { OwnerActionApprovalError } from './owner-errors.ts';
import { OwnerActionApprovals } from './owner-runtime.ts';

type Authentication = typeof OwnerActionApprovalAuthenticationSchema.Type;
type Unavailable = typeof OwnerActionApprovalUnavailableSchema.Type;

/** The existing owner helper verifies and redeems its audience-bound gateway assertion. */
export type OwnerActionApprovalHttpAuthentication<Requirements> = (
  authorization: Redacted.Redacted<string | undefined>,
  problems: PrincipalAuthenticationProblems<Authentication, Unavailable>,
) => Effect.Effect<TrustedPrincipalContext, Authentication | Unavailable, Requirements>;

const problemType = 'https://ontos.dev/problems/owner-action-approval';
const problems = {
  authentication: () =>
    OwnerActionApprovalAuthenticationSchema.make({
      detail: 'A valid receiving-owner Bearer assertion is required.',
      status: 401,
      title: 'Authentication required',
      type: `${problemType}/authentication`,
    }),
  conflict: () =>
    OwnerActionApprovalConflictSchema.make({
      detail: 'The proposal is no longer pending and current.',
      status: 409,
      title: 'Proposal changed',
      type: `${problemType}/conflict`,
    }),
  forbidden: () =>
    OwnerActionApprovalForbiddenSchema.make({
      detail: 'This proposal cannot be approved in the current context.',
      status: 403,
      title: 'Approval refused',
      type: `${problemType}/forbidden`,
    }),
  internal: () =>
    OwnerActionApprovalInternalSchema.make({
      detail: 'The approval request could not be completed.',
      status: 500,
      title: 'Approval failed',
      type: `${problemType}/internal`,
    }),
  invalid: () =>
    OwnerActionApprovalInvalidSchema.make({
      detail: 'The approval request is invalid.',
      status: 400,
      title: 'Invalid approval request',
      type: `${problemType}/invalid`,
    }),
  unavailable: () =>
    OwnerActionApprovalUnavailableSchema.make({
      detail: 'Approval authority is temporarily unavailable.',
      retryable: true,
      status: 503,
      title: 'Approval unavailable',
      type: `${problemType}/unavailable`,
    }),
};
const mapFailure = (failure: OwnerActionApprovalError) =>
  Match.value(failure.code).pipe(
    Match.when('authentication_required', problems.authentication),
    Match.when('approval_conflict', problems.conflict),
    Match.when('approval_refused', problems.forbidden),
    Match.when('approval_unavailable', problems.unavailable),
    Match.exhaustive,
  );
const recoverDefect = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  Effect.exit(effect).pipe(
    Effect.flatMap((exit): Effect.Effect<Value, Failure | typeof OwnerActionApprovalInternalSchema.Type> => {
      if (Exit.isSuccess(exit)) {
        return Effect.succeed(exit.value);
      }
      return exit.cause.reasons.some(Cause.isDieReason)
        ? Effect.logError('Unexpected owner Action approval HTTP defect').pipe(
            Effect.andThen(Effect.fail(problems.internal())),
          )
        : Effect.failCause(exit.cause);
    }),
  );
const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);

const challengeAuthentication = <Failure>(failure: Failure) =>
  Schema.is(OwnerActionApprovalAuthenticationSchema)(failure) ? bearerChallenge : Effect.void;

/** The parts of an `ownerActionApprovals` endpoint request the handlers read. */
interface OwnerActionApprovalEndpointRequest {
  readonly payload: OwnerActionApprovalRequest;
  readonly request: HttpServerRequest.HttpServerRequest;
}

const authenticatedApprovalInput = <Requirements>(
  authenticateOperationPrincipal: OwnerActionApprovalHttpAuthentication<Requirements>,
) =>
  Effect.fn('OwnerActionApprovalHttp.authenticate')(function* authenticateRequest(
    payload: OwnerActionApprovalRequest,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const correlationId = yield* Schema.decodeUnknownEffect(transportIdentifier)(
      request.headers['x-correlation-id'],
    ).pipe(Effect.mapError(problems.invalid));
    const principal = yield* authenticateOperationPrincipal(Redacted.make(request.headers['authorization']), problems);
    return {
      principal,
      request: payload,
      requestHeaders: { 'x-correlation-id': correlationId },
    };
  });

/**
 * Handler for the `approve` endpoint. The owner mounts it in `HttpApiBuilder.group` on its own
 * API, which already adds `OwnerActionApprovalApi`. It never dispatches or resolves an Action
 * handler. The root provides OwnerActionApprovals and OwnerActionApprovalSchemaErrorLive to that
 * group. Authentication's request ports stay explicit and use HttpRouter.provideRequest.
 */
export const makeOwnerActionApproveHandler = <Requirements>(
  authenticateOperationPrincipal: OwnerActionApprovalHttpAuthentication<Requirements>,
) => {
  const authenticate = authenticatedApprovalInput(authenticateOperationPrincipal);
  const execute = Effect.fn('OwnerActionApprovalHttp.approve')(function* executeApprovalRequest(
    payload: OwnerActionApprovalRequest,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const service = yield* OwnerActionApprovals;
    const input = yield* authenticate(payload, request);
    const approved = yield* service.approve(input).pipe(Effect.mapError(mapFailure));
    return { proposalId: approved.proposalId, status: approved.status };
  });
  return ({ payload, request }: OwnerActionApprovalEndpointRequest) =>
    recoverDefect(execute(payload, request)).pipe(Effect.tapError(challengeAuthentication));
};

/** Handler for the `inspect` endpoint, mounted beside `makeOwnerActionApproveHandler`. */
export const makeOwnerActionInspectHandler = <Requirements>(
  authenticateOperationPrincipal: OwnerActionApprovalHttpAuthentication<Requirements>,
) => {
  const authenticate = authenticatedApprovalInput(authenticateOperationPrincipal);
  const inspect = Effect.fn('OwnerActionApprovalHttp.inspect')(function* inspectApprovalRequest(
    payload: OwnerActionApprovalRequest,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const service = yield* OwnerActionApprovals;
    const input = yield* authenticate(payload, request);
    const inspection = yield* service.inspect(input).pipe(Effect.mapError(mapFailure));
    return { canApprove: inspection.canApprove, proposalId: inspection.proposalId };
  });
  return ({ payload, request }: OwnerActionApprovalEndpointRequest) =>
    recoverDefect(inspect(payload, request)).pipe(Effect.tapError(challengeAuthentication));
};

/** The application root provides this middleware once beside the owner-bound handler Layer. */
export const OwnerActionApprovalSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  OwnerActionApprovalSchemaErrorMiddleware,
  () => Effect.fail(problems.invalid()),
);
