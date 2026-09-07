import { ActionRuntime } from '@app/core-runtime';
import type { ActionRegistration, DomainEventContractMap } from '@app/core-runtime';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { Cause, Exit, Redacted, Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import type {
  ContactsMutationHeadersSchema,
  ContactsProblem,
} from '../shared/engagement-profile-api.ts';
import { archiveOrganizationEngagementAction } from '../src/actions/archive-organization-engagement.action.ts';
import { archivePersonEngagementAction } from '../src/actions/archive-person-engagement.action.ts';
import { attachOrganizationEngagementAction } from '../src/actions/attach-organization-engagement.action.ts';
import { attachPersonEngagementAction } from '../src/actions/attach-person-engagement.action.ts';
import { unarchiveOrganizationEngagementAction } from '../src/actions/unarchive-organization-engagement.action.ts';
import { unarchivePersonEngagementAction } from '../src/actions/unarchive-person-engagement.action.ts';
import { verifyOperationPrincipal } from './auth/action-principal.ts';
import {
  engagementProblem,
  failEngagementProblem,
  mapEngagementAttachProblem,
  recoverEngagementFailure,
} from './engagement-profile-problems.ts';
import type { EngagementActionError } from './engagement-profile-problems.ts';
import { organizationEngagementProfileReadApiLive } from './organization-engagement-profile-read-server.ts';
import { personEngagementProfileReadApiLive } from './person-engagement-profile-read-server.ts';

interface EngagementActionTransportRequest {
  readonly correlationId: string;
  idempotencyKey?: string;
  traceId?: string;
}

const verifyPrincipal = (authorization: Redacted.Redacted<string | undefined>) =>
  verifyOperationPrincipal(authorization).pipe(
    Effect.catchTags({
      ActionPrincipalConfigurationError: (_error) => Effect.fail(engagementProblem.unavailable()),
      ActionPrincipalExpiredError: (_error) =>
        failEngagementProblem(engagementProblem.authentication()),
      ActionPrincipalInvalidError: (_error) =>
        failEngagementProblem(engagementProblem.authentication()),
      ActionPrincipalMissingError: (_error) =>
        failEngagementProblem(engagementProblem.authentication()),
      ActionPrincipalScopeError: (_error) =>
        failEngagementProblem(engagementProblem.authentication()),
      ActionPrincipalUnavailableError: (_error) => Effect.fail(engagementProblem.unavailable()),
    }),
  );

const RequestHeadersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Undefined]),
);
type RequestHeaders = Schema.Schema.Type<typeof RequestHeadersSchema>;
type ContactsMutationHeaders = Schema.Schema.Type<typeof ContactsMutationHeadersSchema>;

const recoverUnexpectedEngagementDefect = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, Failure | ContactsProblem, Requirements> =>
  Effect.exit(effect).pipe(
    Effect.flatMap((exit): Effect.Effect<Value, Failure | ContactsProblem> => {
      if (Exit.isSuccess(exit)) {
        return Effect.succeed(exit.value);
      }
      return exit.cause.reasons.some(Cause.isDieReason)
        ? Effect.logError('Unexpected engagement Action BFF defect', exit.cause).pipe(
            Effect.andThen(Effect.fail(engagementProblem.internal())),
          )
        : Effect.failCause(exit.cause);
    }),
  );

const runEngagementAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<EngagementActionError>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
>(
  registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    never
  >,
  payload: Schema.Schema.Type<PayloadSchema>,
  headers: ContactsMutationHeaders,
  requestHeaders: RequestHeaders,
) =>
  Effect.gen(function* executeEngagementAction() {
    const correlationId = requestHeaders['x-correlation-id'];
    if (correlationId === undefined || correlationId.trim().length === 0) {
      return yield* failEngagementProblem(engagementProblem.invalid());
    }
    const principal = yield* verifyPrincipal(Redacted.make(requestHeaders['authorization']));
    const runtime = yield* ActionRuntime;
    const idempotencyKey = headers['idempotency-key'];
    const traceId = requestHeaders['x-trace-id'];
    const transport: EngagementActionTransportRequest = { correlationId };
    if (idempotencyKey !== undefined) {
      transport.idempotencyKey = idempotencyKey;
    }
    if (traceId !== undefined) {
      transport.traceId = traceId;
    }
    return yield* runtime.runAction({ payload, principal, registration, transport });
  }).pipe(Effect.catchEager(recoverEngagementFailure), recoverUnexpectedEngagementDefect);

const organizationEngagementMutationsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'organizationEngagementMutations',
  (handlers) =>
    handlers
      .handle('attach', ({ headers, payload, request }) =>
        runEngagementAction(
          attachOrganizationEngagementAction,
          payload,
          headers,
          request.headers,
        ).pipe(Effect.mapError(mapEngagementAttachProblem)),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runEngagementAction(archiveOrganizationEngagementAction, payload, headers, request.headers),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runEngagementAction(
          unarchiveOrganizationEngagementAction,
          payload,
          headers,
          request.headers,
        ),
      ),
);

const personEngagementMutationsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'personEngagementMutations',
  (handlers) =>
    handlers
      .handle('attach', ({ headers, payload, request }) =>
        runEngagementAction(attachPersonEngagementAction, payload, headers, request.headers).pipe(
          Effect.mapError(mapEngagementAttachProblem),
        ),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runEngagementAction(archivePersonEngagementAction, payload, headers, request.headers),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runEngagementAction(unarchivePersonEngagementAction, payload, headers, request.headers),
      ),
);

export const engagementProfileApiHandlersLive = Layer.mergeAll(
  organizationEngagementMutationsLive,
  personEngagementMutationsLive,
  organizationEngagementProfileReadApiLive,
  personEngagementProfileReadApiLive,
);
