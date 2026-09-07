import {
  makeProblemDetailsSchema,
  makeRetryableProblemDetailsSchema,
} from '@app/shared-contracts/problem-details';
/* eslint-disable oxc/no-barrel-file -- This is the generated public contract aggregate; remove-when: Codesmith emits direct re-exports. */
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { createMicroVerticalOperationContext } from '@app/shared-contracts';
import type { MicroVerticalOperationContext } from '@app/shared-contracts';
import {
  AttachOrganizationEngagementPayloadSchema,
  AttachPersonEngagementPayloadSchema,
  OrganizationEngagementLifecyclePayloadSchema,
  OrganizationEngagementProfileSchema,
  PersonEngagementLifecyclePayloadSchema,
  PersonEngagementProfileSchema,
} from './domain/engagement-profile.ts';

export * from './domain/engagement-profile.ts';
export * from './apis/organization-engagement-profile.ts';
export * from './apis/person-engagement-profile.ts';

export const ContactsMutationHeadersSchema = Schema.Struct({
  'idempotency-key': Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ),
});

export const ContactsInvalidRequestProblemSchema = makeProblemDetailsSchema(
  'ContactsInvalidRequestProblem',
  400,
);
export const ContactsAuthenticationProblemSchema = makeProblemDetailsSchema(
  'ContactsAuthenticationProblem',
  401,
);
export const ContactsForbiddenProblemSchema = makeProblemDetailsSchema(
  'ContactsForbiddenProblem',
  403,
);
export const ContactsNotFoundProblemSchema = makeProblemDetailsSchema(
  'ContactsNotFoundProblem',
  404,
);
export const ContactsConflictProblemSchema = makeProblemDetailsSchema(
  'ContactsConflictProblem',
  409,
  {
    code: Schema.Literals([
      'contacts_counterparty_customer_role_required',
      'contacts_engagement_profile_already_exists',
      'contacts_engagement_profile_lifecycle_conflict',
      'contacts_party_counterparty_mismatch',
      'contacts_party_alias_requires_canonical_reference',
      'contacts_party_archived',
      'contacts_party_type_mismatch',
    ]),
  },
);
export const ContactsPreconditionRequiredProblemSchema = makeProblemDetailsSchema(
  'ContactsPreconditionRequiredProblem',
  428,
);
export const ContactsUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'ContactsUnavailableProblem',
  503,
);
export const ContactsInternalProblemSchema = makeProblemDetailsSchema(
  'ContactsInternalProblem',
  500,
);

export type ContactsProblem =
  | typeof ContactsInvalidRequestProblemSchema.Type
  | typeof ContactsAuthenticationProblemSchema.Type
  | typeof ContactsForbiddenProblemSchema.Type
  | typeof ContactsNotFoundProblemSchema.Type
  | typeof ContactsConflictProblemSchema.Type
  | typeof ContactsPreconditionRequiredProblemSchema.Type
  | typeof ContactsUnavailableProblemSchema.Type
  | typeof ContactsInternalProblemSchema.Type;

const mutationErrors = [
  ContactsInvalidRequestProblemSchema,
  ContactsAuthenticationProblemSchema,
  ContactsForbiddenProblemSchema,
  ContactsConflictProblemSchema,
  ContactsPreconditionRequiredProblemSchema,
  ContactsUnavailableProblemSchema,
  ContactsInternalProblemSchema,
] as const;
const lifecycleErrors = [...mutationErrors, ContactsNotFoundProblemSchema] as const;

export const organizationEngagementMutationApi = HttpApi.make(
  'OrganizationEngagementMutationApi',
).add(
  HttpApiGroup.make('organizationEngagementMutations')
    .add(
      HttpApiEndpoint.post('attach', '/contacts/engagement/organizations/attach', {
        error: mutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: AttachOrganizationEngagementPayloadSchema,
        success: OrganizationEngagementProfileSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('archive', '/contacts/engagement/organizations/archive', {
        error: lifecycleErrors,
        headers: ContactsMutationHeadersSchema,
        payload: OrganizationEngagementLifecyclePayloadSchema,
        success: OrganizationEngagementProfileSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('unarchive', '/contacts/engagement/organizations/unarchive', {
        error: lifecycleErrors,
        headers: ContactsMutationHeadersSchema,
        payload: OrganizationEngagementLifecyclePayloadSchema,
        success: OrganizationEngagementProfileSchema,
      }),
    ),
);

export const personEngagementMutationApi = HttpApi.make('PersonEngagementMutationApi').add(
  HttpApiGroup.make('personEngagementMutations')
    .add(
      HttpApiEndpoint.post('attach', '/contacts/engagement/people/attach', {
        error: mutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: AttachPersonEngagementPayloadSchema,
        success: PersonEngagementProfileSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('archive', '/contacts/engagement/people/archive', {
        error: lifecycleErrors,
        headers: ContactsMutationHeadersSchema,
        payload: PersonEngagementLifecyclePayloadSchema,
        success: PersonEngagementProfileSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('unarchive', '/contacts/engagement/people/unarchive', {
        error: lifecycleErrors,
        headers: ContactsMutationHeadersSchema,
        payload: PersonEngagementLifecyclePayloadSchema,
        success: PersonEngagementProfileSchema,
      }),
    ),
);

const operation = <const Method extends string, const RoutePath extends string>(
  method: Method,
  routePath: RoutePath,
) =>
  createMicroVerticalOperationContext({
    method,
    operationId: `PartyRegistryApi:${routePath}` as const,
    routePath,
  });

export const engagementProfileOperationContexts = {
  archiveOrganizationEngagement: operation('POST', '/contacts/engagement/organizations/archive'),
  archivePersonEngagement: operation('POST', '/contacts/engagement/people/archive'),
  attachOrganizationEngagement: operation('POST', '/contacts/engagement/organizations/attach'),
  attachPersonEngagement: operation('POST', '/contacts/engagement/people/attach'),
  organizationEngagementProfile: operation('POST', '/reads/organization-engagement-profile'),
  personEngagementProfile: operation('POST', '/reads/person-engagement-profile'),
  unarchiveOrganizationEngagement: operation(
    'POST',
    '/contacts/engagement/organizations/unarchive',
  ),
  unarchivePersonEngagement: operation('POST', '/contacts/engagement/people/unarchive'),
} satisfies Record<string, MicroVerticalOperationContext>;
