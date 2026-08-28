/* eslint-disable import/no-duplicates, no-duplicate-imports -- The semantic API seam guard requires one exact API-only import per generated contract. */
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { ContactDetailApi } from './apis/contact-detail.ts';
import {
  ContactLifecyclePayloadSchema,
  ContactSchema,
  CreateContactPayloadSchema,
  EditContactPayloadSchema,
} from './apis/contact-detail.ts';
import { ContactListApi } from './apis/contact-list.ts';
import { CustomerAresLookupApi } from './apis/customer-ares-lookup.ts';
import { CustomerDetailApi } from './apis/customer-detail.ts';
import {
  CreateCustomerPayloadSchema,
  CustomerLifecyclePayloadSchema,
  CustomerSchema,
  EditCustomerPayloadSchema,
} from './apis/customer-detail.ts';
import { CustomerListApi } from './apis/customer-list.ts';

export type {
  Contact,
  ContactLifecyclePayload,
  CreateContactPayload,
  EditContactPayload,
} from './apis/contact-detail.ts';
export type {
  CreateCustomerPayload,
  Customer,
  CustomerLifecyclePayload,
  EditCustomerPayload,
} from './apis/customer-detail.ts';
export type { ContactDetailRequest, ContactDetailResponse } from './apis/contact-detail.ts';
export type { ContactListRequest, ContactListResponse } from './apis/contact-list.ts';
export type {
  CustomerAresLookupRequest,
  CustomerAresLookupResponse,
} from './apis/customer-ares-lookup.ts';
export type { CustomerDetailRequest, CustomerDetailResponse } from './apis/customer-detail.ts';
export type { CustomerListRequest, CustomerListResponse } from './apis/customer-list.ts';

export interface ProjectsMarker {
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

export interface ProjectsReadiness {
  readonly checks: {
    readonly api: 'ready';
    readonly moduleFederation: 'ready';
    readonly ssr: 'ready';
    readonly translations: 'ready';
  };
  readonly marker: ProjectsMarker;
  readonly status: 'ready';
  readonly versionSkew: 'none';
}

export const projectsMarkerSchema: Schema.Codec<ProjectsMarker> = Schema.Struct({
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

export const projectsReadinessSchema: Schema.Codec<ProjectsReadiness> = Schema.Struct({
  checks: Schema.Struct({
    api: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: projectsMarkerSchema,
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

export const ProjectsMutationHeadersSchema = Schema.Struct({
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
export const ProjectsInvalidRequestProblemSchema = Schema.TaggedStruct(
  'ProjectsInvalidRequestProblem',
  {
    ...problemFields,
    status: Schema.Literal(400),
  },
).pipe(asProblemDetails, HttpApiSchema.status(400));
export const ProjectsAuthenticationProblemSchema = Schema.TaggedStruct(
  'ProjectsAuthenticationProblem',
  {
    ...problemFields,
    status: Schema.Literal(401),
  },
).pipe(asProblemDetails, HttpApiSchema.status(401));
export const ProjectsForbiddenProblemSchema = Schema.TaggedStruct('ProjectsForbiddenProblem', {
  ...problemFields,
  status: Schema.Literal(403),
}).pipe(asProblemDetails, HttpApiSchema.status(403));
export const ProjectsNotFoundProblemSchema = Schema.TaggedStruct('ProjectsNotFoundProblem', {
  ...problemFields,
  status: Schema.Literal(404),
}).pipe(asProblemDetails, HttpApiSchema.status(404));
export const ProjectsConflictProblemSchema = Schema.TaggedStruct('ProjectsConflictProblem', {
  ...problemFields,
  code: Schema.Literals(['projects_conflict', 'projects_customer_ico_conflict']),
  status: Schema.Literal(409),
}).pipe(asProblemDetails, HttpApiSchema.status(409));
export const ProjectsPreconditionRequiredProblemSchema = Schema.TaggedStruct(
  'ProjectsPreconditionRequiredProblem',
  { ...problemFields, status: Schema.Literal(428) },
).pipe(asProblemDetails, HttpApiSchema.status(428));
export const ProjectsUnavailableProblemSchema = Schema.TaggedStruct('ProjectsUnavailableProblem', {
  ...problemFields,
  retryable: Schema.Literal(true),
  status: Schema.Literal(503),
}).pipe(asProblemDetails, HttpApiSchema.status(503));
export const ProjectsInternalProblemSchema = Schema.TaggedStruct('ProjectsInternalProblem', {
  ...problemFields,
  status: Schema.Literal(500),
}).pipe(asProblemDetails, HttpApiSchema.status(500));

export type ProjectsProblem =
  | typeof ProjectsInvalidRequestProblemSchema.Type
  | typeof ProjectsAuthenticationProblemSchema.Type
  | typeof ProjectsForbiddenProblemSchema.Type
  | typeof ProjectsNotFoundProblemSchema.Type
  | typeof ProjectsConflictProblemSchema.Type
  | typeof ProjectsPreconditionRequiredProblemSchema.Type
  | typeof ProjectsUnavailableProblemSchema.Type
  | typeof ProjectsInternalProblemSchema.Type;

const mutationErrors = [
  ProjectsInvalidRequestProblemSchema,
  ProjectsAuthenticationProblemSchema,
  ProjectsForbiddenProblemSchema,
  ProjectsConflictProblemSchema,
  ProjectsPreconditionRequiredProblemSchema,
  ProjectsUnavailableProblemSchema,
  ProjectsInternalProblemSchema,
] as const;

const addressedMutationErrors = [...mutationErrors, ProjectsNotFoundProblemSchema] as const;

export const projectsFoundationApi = HttpApi.make('ProjectsFoundationApi').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/projects/readiness', {
      success: projectsReadinessSchema,
    }),
  ),
);

export const projectsCustomerMutationApi = HttpApi.make('ProjectsCustomerMutationApi').add(
  HttpApiGroup.make('customerMutations')
    .add(
      HttpApiEndpoint.post('createCustomer', '/projects/customers/create', {
        error: mutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: CreateCustomerPayloadSchema,
        success: CustomerSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('editCustomer', '/projects/customers/edit', {
        error: addressedMutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: EditCustomerPayloadSchema,
        success: CustomerSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('archiveCustomer', '/projects/customers/archive', {
        error: addressedMutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: CustomerLifecyclePayloadSchema,
        success: CustomerSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('unarchiveCustomer', '/projects/customers/unarchive', {
        error: addressedMutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: CustomerLifecyclePayloadSchema,
        success: CustomerSchema,
      }),
    ),
);

export const projectsContactMutationApi = HttpApi.make('ProjectsContactMutationApi').add(
  HttpApiGroup.make('contactMutations')
    .add(
      HttpApiEndpoint.post('createContact', '/projects/contacts/create', {
        error: addressedMutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: CreateContactPayloadSchema,
        success: ContactSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('editContact', '/projects/contacts/edit', {
        error: addressedMutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: EditContactPayloadSchema,
        success: ContactSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('archiveContact', '/projects/contacts/archive', {
        error: addressedMutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: ContactLifecyclePayloadSchema,
        success: ContactSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('unarchiveContact', '/projects/contacts/unarchive', {
        error: addressedMutationErrors,
        headers: ProjectsMutationHeadersSchema,
        payload: ContactLifecyclePayloadSchema,
        success: ContactSchema,
      }),
    ),
);

export const projectsApi = HttpApi.make('ProjectsApi')
  .addHttpApi(projectsFoundationApi)
  .addHttpApi(projectsCustomerMutationApi)
  .addHttpApi(projectsContactMutationApi)
  .addHttpApi(CustomerAresLookupApi)
  .addHttpApi(CustomerDetailApi)
  .addHttpApi(CustomerListApi)
  .addHttpApi(ContactDetailApi)
  .addHttpApi(ContactListApi);

const operation = (method: string, routePath: string): OperationContext => ({
  method,
  operationId: `ProjectsApi:${routePath}`,
  routePath,
  source: 'generated-client',
});

export const projectsOperationContexts = {
  archiveContact: operation('POST', '/projects/contacts/archive'),
  archiveCustomer: operation('POST', '/projects/customers/archive'),
  createContact: operation('POST', '/projects/contacts/create'),
  createCustomer: operation('POST', '/projects/customers/create'),
  editContact: operation('POST', '/projects/contacts/edit'),
  editCustomer: operation('POST', '/projects/customers/edit'),
  getContact: operation('POST', '/projects/contacts/detail'),
  getContactList: operation('POST', '/projects/contacts/list'),
  getCustomerDetail: operation('POST', '/projects/customers/detail'),
  getCustomerList: operation('POST', '/projects/customers/list'),
  lookupCustomerAres: operation('POST', '/projects/customers/ares-lookup'),
  readiness: operation('GET', '/projects/readiness'),
  unarchiveContact: operation('POST', '/projects/contacts/unarchive'),
  unarchiveCustomer: operation('POST', '/projects/customers/unarchive'),
} satisfies Record<string, OperationContext>;

export const projectsApiContract = {
  apiPrefix: '/projects-api',
  basePath: '/projects-api/projects',
  ownerId: 'projects',
  readinessPath: '/projects-api/projects/readiness',
} as const;
