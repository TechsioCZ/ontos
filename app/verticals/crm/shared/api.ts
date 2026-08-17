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

export interface CrmMarker {
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

export interface CrmReadiness {
  readonly checks: {
    readonly api: 'ready';
    readonly moduleFederation: 'ready';
    readonly ssr: 'ready';
    readonly translations: 'ready';
  };
  readonly marker: CrmMarker;
  readonly status: 'ready';
  readonly versionSkew: 'none';
}

export const crmMarkerSchema: Schema.Codec<CrmMarker> = Schema.Struct({
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

export const crmReadinessSchema: Schema.Codec<CrmReadiness> = Schema.Struct({
  checks: Schema.Struct({
    api: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: crmMarkerSchema,
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

export const CrmMutationHeadersSchema = Schema.Struct({
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
export const CrmInvalidRequestProblemSchema = Schema.TaggedStruct('CrmInvalidRequestProblem', {
  ...problemFields,
  status: Schema.Literal(400),
}).pipe(asProblemDetails, HttpApiSchema.status(400));
export const CrmAuthenticationProblemSchema = Schema.TaggedStruct('CrmAuthenticationProblem', {
  ...problemFields,
  status: Schema.Literal(401),
}).pipe(asProblemDetails, HttpApiSchema.status(401));
export const CrmForbiddenProblemSchema = Schema.TaggedStruct('CrmForbiddenProblem', {
  ...problemFields,
  status: Schema.Literal(403),
}).pipe(asProblemDetails, HttpApiSchema.status(403));
export const CrmNotFoundProblemSchema = Schema.TaggedStruct('CrmNotFoundProblem', {
  ...problemFields,
  status: Schema.Literal(404),
}).pipe(asProblemDetails, HttpApiSchema.status(404));
export const CrmConflictProblemSchema = Schema.TaggedStruct('CrmConflictProblem', {
  ...problemFields,
  status: Schema.Literal(409),
}).pipe(asProblemDetails, HttpApiSchema.status(409));
export const CrmPreconditionRequiredProblemSchema = Schema.TaggedStruct(
  'CrmPreconditionRequiredProblem',
  { ...problemFields, status: Schema.Literal(428) },
).pipe(asProblemDetails, HttpApiSchema.status(428));
export const CrmUnavailableProblemSchema = Schema.TaggedStruct('CrmUnavailableProblem', {
  ...problemFields,
  retryable: Schema.Literal(true),
  status: Schema.Literal(503),
}).pipe(asProblemDetails, HttpApiSchema.status(503));
export const CrmInternalProblemSchema = Schema.TaggedStruct('CrmInternalProblem', {
  ...problemFields,
  status: Schema.Literal(500),
}).pipe(asProblemDetails, HttpApiSchema.status(500));

export type CrmProblem =
  | typeof CrmInvalidRequestProblemSchema.Type
  | typeof CrmAuthenticationProblemSchema.Type
  | typeof CrmForbiddenProblemSchema.Type
  | typeof CrmNotFoundProblemSchema.Type
  | typeof CrmConflictProblemSchema.Type
  | typeof CrmPreconditionRequiredProblemSchema.Type
  | typeof CrmUnavailableProblemSchema.Type
  | typeof CrmInternalProblemSchema.Type;

const mutationErrors = [
  CrmInvalidRequestProblemSchema,
  CrmAuthenticationProblemSchema,
  CrmForbiddenProblemSchema,
  CrmConflictProblemSchema,
  CrmPreconditionRequiredProblemSchema,
  CrmUnavailableProblemSchema,
  CrmInternalProblemSchema,
] as const;

const addressedMutationErrors = [...mutationErrors, CrmNotFoundProblemSchema] as const;

export const crmFoundationApi = HttpApi.make('CrmFoundationApi').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/crm/readiness', {
      success: crmReadinessSchema,
    }),
  ),
);

export const crmCustomerMutationApi = HttpApi.make('CrmCustomerMutationApi').add(
  HttpApiGroup.make('customerMutations')
    .add(
      HttpApiEndpoint.post('createCustomer', '/crm/customers/create', {
        error: mutationErrors,
        headers: CrmMutationHeadersSchema,
        payload: CreateCustomerPayloadSchema,
        success: CustomerSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('editCustomer', '/crm/customers/edit', {
        error: addressedMutationErrors,
        headers: CrmMutationHeadersSchema,
        payload: EditCustomerPayloadSchema,
        success: CustomerSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('archiveCustomer', '/crm/customers/archive', {
        error: addressedMutationErrors,
        headers: CrmMutationHeadersSchema,
        payload: CustomerLifecyclePayloadSchema,
        success: CustomerSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('unarchiveCustomer', '/crm/customers/unarchive', {
        error: addressedMutationErrors,
        headers: CrmMutationHeadersSchema,
        payload: CustomerLifecyclePayloadSchema,
        success: CustomerSchema,
      }),
    ),
);

export const crmContactMutationApi = HttpApi.make('CrmContactMutationApi').add(
  HttpApiGroup.make('contactMutations')
    .add(
      HttpApiEndpoint.post('createContact', '/crm/contacts/create', {
        error: addressedMutationErrors,
        headers: CrmMutationHeadersSchema,
        payload: CreateContactPayloadSchema,
        success: ContactSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('editContact', '/crm/contacts/edit', {
        error: addressedMutationErrors,
        headers: CrmMutationHeadersSchema,
        payload: EditContactPayloadSchema,
        success: ContactSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('archiveContact', '/crm/contacts/archive', {
        error: addressedMutationErrors,
        headers: CrmMutationHeadersSchema,
        payload: ContactLifecyclePayloadSchema,
        success: ContactSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('unarchiveContact', '/crm/contacts/unarchive', {
        error: addressedMutationErrors,
        headers: CrmMutationHeadersSchema,
        payload: ContactLifecyclePayloadSchema,
        success: ContactSchema,
      }),
    ),
);

export const crmApi = HttpApi.make('CrmApi')
  .addHttpApi(crmFoundationApi)
  .addHttpApi(crmCustomerMutationApi)
  .addHttpApi(crmContactMutationApi)
  .addHttpApi(CustomerAresLookupApi)
  .addHttpApi(CustomerDetailApi)
  .addHttpApi(CustomerListApi)
  .addHttpApi(ContactDetailApi)
  .addHttpApi(ContactListApi);

const operation = (method: string, routePath: string): OperationContext => ({
  method,
  operationId: `CrmApi:${routePath}`,
  routePath,
  source: 'generated-client',
});

export const crmOperationContexts = {
  archiveContact: operation('POST', '/crm/contacts/archive'),
  archiveCustomer: operation('POST', '/crm/customers/archive'),
  createContact: operation('POST', '/crm/contacts/create'),
  createCustomer: operation('POST', '/crm/customers/create'),
  editContact: operation('POST', '/crm/contacts/edit'),
  editCustomer: operation('POST', '/crm/customers/edit'),
  getContact: operation('POST', '/crm/contacts/detail'),
  getContactList: operation('POST', '/crm/contacts/list'),
  getCustomerDetail: operation('POST', '/crm/customers/detail'),
  getCustomerList: operation('POST', '/crm/customers/list'),
  lookupCustomerAres: operation('POST', '/crm/customers/ares-lookup'),
  readiness: operation('GET', '/crm/readiness'),
  unarchiveContact: operation('POST', '/crm/contacts/unarchive'),
  unarchiveCustomer: operation('POST', '/crm/customers/unarchive'),
} satisfies Record<string, OperationContext>;

export const crmApiContract = {
  apiPrefix: '/crm-api',
  basePath: '/crm-api/crm',
  ownerId: 'crm',
  readinessPath: '/crm-api/crm/readiness',
} as const;
