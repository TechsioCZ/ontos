/* eslint-disable oxc/no-barrel-file, sonarjs/no-wildcard-import -- This is the public contract aggregate for the generated API seams. */
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { OrganizationEngagementProfileApi } from './apis/organization-engagement-profile.ts';
import { PersonEngagementProfileApi } from './apis/person-engagement-profile.ts';
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

export interface ContactsMarker {
  readonly appId: string;
  readonly build: string;
  readonly buildMarker: string;
  readonly deployProfile: string;
  readonly packageName: string;
  readonly sourceRevision: string;
  readonly surface: string;
  readonly unitId: string;
  readonly version: string;
}

export interface ContactsReadiness {
  readonly checks: {
    readonly api: 'ready';
    readonly moduleFederation: 'ready';
    readonly ssr: 'ready';
    readonly translations: 'ready';
  };
  readonly marker: ContactsMarker;
  readonly status: 'ready';
  readonly versionSkew: 'none';
}

export const contactsMarkerSchema: Schema.Codec<ContactsMarker> = Schema.Struct({
  appId: Schema.String,
  build: Schema.String,
  buildMarker: Schema.String,
  deployProfile: Schema.String,
  packageName: Schema.String,
  sourceRevision: Schema.String,
  surface: Schema.String,
  unitId: Schema.String,
  version: Schema.String,
});

export const contactsReadinessSchema: Schema.Codec<ContactsReadiness> = Schema.Struct({
  checks: Schema.Struct({
    api: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: contactsMarkerSchema,
  status: Schema.Literal('ready'),
  versionSkew: Schema.Literal('none'),
});

export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: 'client' | 'server' | 'generated-client' | 'effect-adapter' | 'data-platform' | 'unknown';
  traceId?: string;
}

export const ContactsMutationHeadersSchema = Schema.Struct({
  'idempotency-key': Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ),
});

const problemFields = {
  detail: Schema.String,
  title: Schema.String,
  type: Schema.String,
} as const;
const asProblemDetails = HttpApiSchema.asJson({ contentType: 'application/problem+json' });
export const ContactsInvalidRequestProblemSchema = Schema.TaggedStruct(
  'ContactsInvalidRequestProblem',
  { ...problemFields, status: Schema.Literal(400) },
).pipe(asProblemDetails, HttpApiSchema.status(400));
export const ContactsAuthenticationProblemSchema = Schema.TaggedStruct(
  'ContactsAuthenticationProblem',
  { ...problemFields, status: Schema.Literal(401) },
).pipe(asProblemDetails, HttpApiSchema.status(401));
export const ContactsForbiddenProblemSchema = Schema.TaggedStruct('ContactsForbiddenProblem', {
  ...problemFields,
  status: Schema.Literal(403),
}).pipe(asProblemDetails, HttpApiSchema.status(403));
export const ContactsNotFoundProblemSchema = Schema.TaggedStruct('ContactsNotFoundProblem', {
  ...problemFields,
  status: Schema.Literal(404),
}).pipe(asProblemDetails, HttpApiSchema.status(404));
export const ContactsConflictProblemSchema = Schema.TaggedStruct('ContactsConflictProblem', {
  ...problemFields,
  code: Schema.Literals([
    'contacts_counterparty_customer_role_required',
    'contacts_engagement_profile_already_exists',
    'contacts_engagement_profile_lifecycle_conflict',
    'contacts_party_counterparty_mismatch',
    'contacts_party_alias_requires_canonical_reference',
    'contacts_party_archived',
    'contacts_party_type_mismatch',
  ]),
  status: Schema.Literal(409),
}).pipe(asProblemDetails, HttpApiSchema.status(409));
export const ContactsPreconditionRequiredProblemSchema = Schema.TaggedStruct(
  'ContactsPreconditionRequiredProblem',
  { ...problemFields, status: Schema.Literal(428) },
).pipe(asProblemDetails, HttpApiSchema.status(428));
export const ContactsUnavailableProblemSchema = Schema.TaggedStruct('ContactsUnavailableProblem', {
  ...problemFields,
  retryable: Schema.Literal(true),
  status: Schema.Literal(503),
}).pipe(asProblemDetails, HttpApiSchema.status(503));
export const ContactsInternalProblemSchema = Schema.TaggedStruct('ContactsInternalProblem', {
  ...problemFields,
  status: Schema.Literal(500),
}).pipe(asProblemDetails, HttpApiSchema.status(500));

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

export const contactsFoundationApi = HttpApi.make('ContactsFoundationApi').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/contacts/readiness', {
      success: contactsReadinessSchema,
    }),
  ),
);

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

export const contactsApi = HttpApi.make('ContactsApi')
  .addHttpApi(contactsFoundationApi)
  .addHttpApi(organizationEngagementMutationApi)
  .addHttpApi(personEngagementMutationApi)
  .addHttpApi(OrganizationEngagementProfileApi)
  .addHttpApi(PersonEngagementProfileApi);

const operation = (method: string, routePath: string): OperationContext => ({
  method,
  operationId: `ContactsApi:${routePath}`,
  routePath,
  source: 'generated-client',
});

export const contactsOperationContexts = {
  archiveOrganizationEngagement: operation('POST', '/contacts/engagement/organizations/archive'),
  archivePersonEngagement: operation('POST', '/contacts/engagement/people/archive'),
  attachOrganizationEngagement: operation('POST', '/contacts/engagement/organizations/attach'),
  attachPersonEngagement: operation('POST', '/contacts/engagement/people/attach'),
  organizationEngagementProfile: operation('POST', '/reads/organization-engagement-profile'),
  personEngagementProfile: operation('POST', '/reads/person-engagement-profile'),
  readiness: operation('GET', '/contacts/readiness'),
  unarchiveOrganizationEngagement: operation(
    'POST',
    '/contacts/engagement/organizations/unarchive',
  ),
  unarchivePersonEngagement: operation('POST', '/contacts/engagement/people/unarchive'),
} satisfies Record<string, OperationContext>;

export const contactsApiContract = {
  apiPrefix: '/contacts-api',
  basePath: '/contacts-api/contacts',
  ownerId: 'contacts',
  readinessPath: '/contacts-api/contacts/readiness',
} as const;
