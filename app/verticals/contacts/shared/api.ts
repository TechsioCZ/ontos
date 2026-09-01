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
  {
    ...problemFields,
    status: Schema.Literal(400),
  },
).pipe(asProblemDetails, HttpApiSchema.status(400));
export const ContactsAuthenticationProblemSchema = Schema.TaggedStruct(
  'ContactsAuthenticationProblem',
  {
    ...problemFields,
    status: Schema.Literal(401),
  },
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
  code: Schema.Literals(['contacts_conflict', 'contacts_customer_ico_conflict']),
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

const addressedMutationErrors = [...mutationErrors, ContactsNotFoundProblemSchema] as const;

export const contactsFoundationApi = HttpApi.make('ContactsFoundationApi').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/contacts/readiness', {
      success: contactsReadinessSchema,
    }),
  ),
);

export const contactsCustomerMutationApi = HttpApi.make('ContactsCustomerMutationApi').add(
  HttpApiGroup.make('customerMutations')
    .add(
      HttpApiEndpoint.post('createCustomer', '/contacts/customers/create', {
        error: mutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: CreateCustomerPayloadSchema,
        success: CustomerSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('editCustomer', '/contacts/customers/edit', {
        error: addressedMutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: EditCustomerPayloadSchema,
        success: CustomerSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('archiveCustomer', '/contacts/customers/archive', {
        error: addressedMutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: CustomerLifecyclePayloadSchema,
        success: CustomerSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('unarchiveCustomer', '/contacts/customers/unarchive', {
        error: addressedMutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: CustomerLifecyclePayloadSchema,
        success: CustomerSchema,
      }),
    ),
);

export const contactsContactMutationApi = HttpApi.make('ContactsContactMutationApi').add(
  HttpApiGroup.make('contactMutations')
    .add(
      HttpApiEndpoint.post('createContact', '/contacts/contacts/create', {
        error: addressedMutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: CreateContactPayloadSchema,
        success: ContactSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('editContact', '/contacts/contacts/edit', {
        error: addressedMutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: EditContactPayloadSchema,
        success: ContactSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('archiveContact', '/contacts/contacts/archive', {
        error: addressedMutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: ContactLifecyclePayloadSchema,
        success: ContactSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('unarchiveContact', '/contacts/contacts/unarchive', {
        error: addressedMutationErrors,
        headers: ContactsMutationHeadersSchema,
        payload: ContactLifecyclePayloadSchema,
        success: ContactSchema,
      }),
    ),
);

export const contactsApi = HttpApi.make('ContactsApi')
  .addHttpApi(contactsFoundationApi)
  .addHttpApi(contactsCustomerMutationApi)
  .addHttpApi(contactsContactMutationApi)
  .addHttpApi(CustomerAresLookupApi)
  .addHttpApi(CustomerDetailApi)
  .addHttpApi(CustomerListApi)
  .addHttpApi(ContactDetailApi)
  .addHttpApi(ContactListApi);

const operation = (method: string, routePath: string): OperationContext => ({
  method,
  operationId: `ContactsApi:${routePath}`,
  routePath,
  source: 'generated-client',
});

export const contactsOperationContexts = {
  archiveContact: operation('POST', '/contacts/contacts/archive'),
  archiveCustomer: operation('POST', '/contacts/customers/archive'),
  createContact: operation('POST', '/contacts/contacts/create'),
  createCustomer: operation('POST', '/contacts/customers/create'),
  editContact: operation('POST', '/contacts/contacts/edit'),
  editCustomer: operation('POST', '/contacts/customers/edit'),
  getContact: operation('POST', '/contacts/contacts/detail'),
  getContactList: operation('POST', '/contacts/contacts/list'),
  getCustomerDetail: operation('POST', '/contacts/customers/detail'),
  getCustomerList: operation('POST', '/contacts/customers/list'),
  lookupCustomerAres: operation('POST', '/contacts/customers/ares-lookup'),
  readiness: operation('GET', '/contacts/readiness'),
  unarchiveContact: operation('POST', '/contacts/contacts/unarchive'),
  unarchiveCustomer: operation('POST', '/contacts/customers/unarchive'),
} satisfies Record<string, OperationContext>;

export const contactsApiContract = {
  apiPrefix: '/contacts-api',
  basePath: '/contacts-api/contacts',
  ownerId: 'contacts',
  readinessPath: '/contacts-api/contacts/readiness',
} as const;
