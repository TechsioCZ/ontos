import type {
  ActionRegistration,
  DomainEventContractMap,
} from '@app/core-runtime';
import {
  Effect,
  HttpApiBuilder,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
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

const runActionHttp = bindActionHttpRunner({
  authentication: engagementProblem.authentication,
  unavailable: engagementProblem.unavailable,
});

const RequestHeadersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Undefined])
);
type RequestHeaders = Schema.Schema.Type<typeof RequestHeadersSchema>;
type ContactsMutationHeaders = Schema.Schema.Type<
  typeof ContactsMutationHeadersSchema
>;

const attachActionProblem = (
  error: EngagementActionError
): EngagementAttachProblem => {
  const mapped = mapEngagementActionProblem(error);
  return mapEngagementAttachProblem(mapped);
};

const engagementActionHandler =
  <
    PayloadSchema extends Schema.ConstraintDecoder<unknown> &
      Schema.ConstraintEncoder<unknown>,
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
    mapError: (error: EngagementActionError) => PublicProblem
  ) =>
  ({
    payload,
    headers,
    request,
  }: {
    readonly payload: Schema.Schema.Type<PayloadSchema>;
    readonly headers: ContactsMutationHeaders;
    readonly request: { readonly headers: RequestHeaders };
  }) => {
    const requestHeaders = request.headers;
    return runActionHttp({
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
    }).pipe(
      Effect.catchIf(isEngagementAuthenticationProblem, failEngagementProblem)
    );
  };

export const organizationEngagementMutationsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'organizationEngagementMutations',
  (handlers) =>
    handlers
      .handle(
        'attach',
        engagementActionHandler(
          attachOrganizationEngagementAction,
          attachActionProblem
        )
      )
      .handle(
        'archive',
        engagementActionHandler(
          archiveOrganizationEngagementAction,
          mapEngagementActionProblem
        )
      )
      .handle(
        'unarchive',
        engagementActionHandler(
          unarchiveOrganizationEngagementAction,
          mapEngagementActionProblem
        )
      )
);

const personEngagementMutationsLive = HttpApiBuilder.group(
  partyRegistryApi,
  'personEngagementMutations',
  (handlers) =>
    handlers
      .handle(
        'attach',
        engagementActionHandler(
          attachPersonEngagementAction,
          attachActionProblem
        )
      )
      .handle(
        'archive',
        engagementActionHandler(
          archivePersonEngagementAction,
          mapEngagementActionProblem
        )
      )
      .handle(
        'unarchive',
        engagementActionHandler(
          unarchivePersonEngagementAction,
          mapEngagementActionProblem
        )
      )
);

export const engagementProfileApiHandlersLive = Layer.mergeAll(
  organizationEngagementMutationsLive,
  personEngagementMutationsLive
);
