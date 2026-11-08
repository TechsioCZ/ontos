import { Cause, Effect, Exit, Match, Redacted, Schema } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/http';
import type { HttpServerRequest } from 'effect/http';
import { HttpApi, HttpApiBuilder, HttpApiMiddleware } from 'effect/http-api';
import type { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

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
import type { OwnerActionApprovalGroupContract, OwnerActionApprovalRequest } from './owner-api.ts';
import type { OwnerActionApprovalError } from './owner-errors.ts';
import { OwnerActionApprovals } from './owner-runtime.ts';

type Authentication = typeof OwnerActionApprovalAuthenticationSchema.Type;
type Unavailable = typeof OwnerActionApprovalUnavailableSchema.Type;

type RoutedEndpoint<Endpoint, ApprovePath extends string, InspectPath extends string> =
  Endpoint extends HttpApiEndpoint.HttpApiEndpoint<
    infer Identifier,
    infer Method,
    infer _Path,
    infer Params,
    infer Query,
    infer Payload,
    infer Headers,
    infer Success,
    infer Failure,
    infer Middleware,
    infer MiddlewareServices
  >
    ? HttpApiEndpoint.HttpApiEndpoint<
        Identifier,
        Method,
        Identifier extends 'approve' ? ApprovePath : InspectPath,
        Params,
        Query,
        Payload,
        Headers,
        Success,
        Failure,
        Middleware,
        MiddlewareServices
      >
    : never;
type RoutedOwnerApprovalGroup<ApprovePath extends string, InspectPath extends string> = HttpApiGroup.HttpApiGroup<
  'ownerActionApprovals',
  RoutedEndpoint<HttpApiGroup.Endpoints<OwnerActionApprovalGroupContract>, ApprovePath, InspectPath>
>;
/** Structural API view preserves the receiving identity and every owner endpoint schema. */
export type OwnerActionApprovalApiBinding<
  ApiId extends string,
  ApprovePath extends string,
  InspectPath extends string,
  Groups extends HttpApiGroup.Constraint,
> = HttpApi.HttpApi<ApiId, Groups> & {
  readonly groups: {
    readonly ownerActionApprovals: RoutedOwnerApprovalGroup<ApprovePath, InspectPath>;
  };
};

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

/**
 * Mount on the actual owner's API. Neither operation dispatches or resolves an Action handler.
 * The root supplies OwnerActionApprovals and OwnerActionApprovalSchemaErrorLive when building
 * the group. Authentication's request ports remain explicit and use HttpRouter.provideRequest.
 */
export const makeOwnerActionApprovalApiLive = <
  ApiId extends string,
  ApprovePath extends string,
  InspectPath extends string,
  Groups extends HttpApiGroup.Constraint,
  Requirements,
>(
  api: OwnerActionApprovalApiBinding<ApiId, NoInfer<ApprovePath>, NoInfer<InspectPath>, Groups> & {
    readonly groups: {
      readonly ownerActionApprovals: {
        readonly endpoints: {
          readonly approve: { readonly path: ApprovePath };
          readonly inspect: { readonly path: InspectPath };
        };
      };
    };
  },
  authenticateOperationPrincipal: OwnerActionApprovalHttpAuthentication<Requirements>,
) => {
  // Native single-group view, not a reconstructed descriptor: add retains the receiving group's
  // exact object, including its real prefixes, middleware and schemas. Root annotations also apply.
  const binding = HttpApi.make(api.identifier).add(api.groups.ownerActionApprovals).annotateMerge(api.annotations);
  const handlers = HttpApiBuilder.group(
    binding,
    'ownerActionApprovals',
    Effect.fn('OwnerActionApprovalHttp.handlers')(function* buildOwnerApprovalHandlers(
      group: HttpApiBuilder.Handlers.FromGroup<RoutedOwnerApprovalGroup<NoInfer<ApprovePath>, NoInfer<InspectPath>>>,
    ) {
      const service = yield* OwnerActionApprovals;
      const authenticate = Effect.fn('OwnerActionApprovalHttp.authenticate')(function* authenticateRequest(
        payload: OwnerActionApprovalRequest,
        request: HttpServerRequest.HttpServerRequest,
      ) {
        const correlationId = yield* Schema.decodeUnknownEffect(transportIdentifier)(
          request.headers['x-correlation-id'],
        ).pipe(Effect.mapError(problems.invalid));
        const principal = yield* authenticateOperationPrincipal(
          Redacted.make(request.headers['authorization']),
          problems,
        );
        return {
          principal,
          request: payload,
          requestHeaders: { 'x-correlation-id': correlationId },
        };
      });
      const execute = Effect.fn('OwnerActionApprovalHttp.approve')(function* executeApprovalRequest(
        payload: OwnerActionApprovalRequest,
        request: HttpServerRequest.HttpServerRequest,
      ) {
        const input = yield* authenticate(payload, request);
        const approved = yield* service.approve(input).pipe(Effect.mapError(mapFailure));
        return { proposalId: approved.proposalId, status: approved.status };
      });
      const inspect = Effect.fn('OwnerActionApprovalHttp.inspect')(function* inspectApprovalRequest(
        payload: OwnerActionApprovalRequest,
        request: HttpServerRequest.HttpServerRequest,
      ) {
        const input = yield* authenticate(payload, request);
        const inspection = yield* service.inspect(input).pipe(Effect.mapError(mapFailure));
        return { canApprove: inspection.canApprove, proposalId: inspection.proposalId };
      });
      return group
        .handle('approve', ({ payload, request }) =>
          recoverDefect(execute(payload, request)).pipe(Effect.tapError(challengeAuthentication)),
        )
        .handle('inspect', ({ payload, request }) =>
          recoverDefect(inspect(payload, request)).pipe(Effect.tapError(challengeAuthentication)),
        );
    }),
  );
  return handlers;
};

/** The application root provides this middleware once beside the owner-bound handler Layer. */
export const OwnerActionApprovalSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  OwnerActionApprovalSchemaErrorMiddleware,
  () => Effect.fail(problems.invalid()),
);
