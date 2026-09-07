import type { ActionRegistration, DomainEventContractMap } from '@app/core-runtime';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { Redacted, Schema } from 'effect';
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
import { bindActionHttpRunner } from './action-http-runner.ts';
import {
  engagementProblem,
  failEngagementProblem,
  mapEngagementAttachProblem,
  isEngagementAuthenticationProblem,
  mapEngagementActionProblem,
} from './engagement-profile-problems.ts';
import type {
  EngagementActionError,
  EngagementAttachProblem,
} from './engagement-profile-problems.ts';
import { organizationEngagementProfileReadApiLive } from './organization-engagement-profile-read-server.ts';
import { personEngagementProfileReadApiLive } from './person-engagement-profile-read-server.ts';

const runActionHttp = bindActionHttpRunner({
  authentication: engagementProblem.authentication,
  unavailable: engagementProblem.unavailable,
});

const RequestHeadersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Undefined]),
);
type RequestHeaders = Schema.Schema.Type<typeof RequestHeadersSchema>;
type ContactsMutationHeaders = Schema.Schema.Type<typeof ContactsMutationHeadersSchema>;

const attachActionProblem = (error: EngagementActionError): EngagementAttachProblem => {
  const mapped = mapEngagementActionProblem(error);
  return mapEngagementAttachProblem(mapped);
};

const runEngagementAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<EngagementActionError>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  Requirements,
  PublicProblem extends ContactsProblem,
>(
  registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    Requirements
  >,
  payload: Schema.Schema.Type<PayloadSchema>,
  headers: ContactsMutationHeaders,
  requestHeaders: RequestHeaders,
  mapError: (error: EngagementActionError) => PublicProblem,
) =>
  runActionHttp({
    endpointHeaders: {
      idempotencyKey: headers['idempotency-key'],
      traceId: requestHeaders['x-trace-id'],
    },
    internalProblem: engagementProblem.internal,
    invalidCorrelationProblem: engagementProblem.invalid,
    mapError,
    payload,
    registration,
    requestHeaders: {
      authorization: Redacted.make(requestHeaders['authorization']),
      'x-correlation-id': requestHeaders['x-correlation-id'],
    },
  }).pipe(Effect.catchIf(isEngagementAuthenticationProblem, failEngagementProblem));

export const organizationEngagementMutationsLive = HttpApiBuilder.group(
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
          attachActionProblem,
        ),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runEngagementAction(
          archiveOrganizationEngagementAction,
          payload,
          headers,
          request.headers,
          mapEngagementActionProblem,
        ),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runEngagementAction(
          unarchiveOrganizationEngagementAction,
          payload,
          headers,
          request.headers,
          mapEngagementActionProblem,
        ),
      ),
);

const personEngagementMutationsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'personEngagementMutations',
  (handlers) =>
    handlers
      .handle('attach', ({ headers, payload, request }) =>
        runEngagementAction(
          attachPersonEngagementAction,
          payload,
          headers,
          request.headers,
          attachActionProblem,
        ),
      )
      .handle('archive', ({ headers, payload, request }) =>
        runEngagementAction(
          archivePersonEngagementAction,
          payload,
          headers,
          request.headers,
          mapEngagementActionProblem,
        ),
      )
      .handle('unarchive', ({ headers, payload, request }) =>
        runEngagementAction(
          unarchivePersonEngagementAction,
          payload,
          headers,
          request.headers,
          mapEngagementActionProblem,
        ),
      ),
);

export const engagementProfileApiHandlersLive = Layer.mergeAll(
  organizationEngagementMutationsLive,
  personEngagementMutationsLive,
  organizationEngagementProfileReadApiLive,
  personEngagementProfileReadApiLive,
);
