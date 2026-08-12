/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- the route preserves Effect failures until the framework boundary */
import { Effect, Random } from 'effect';
import type { executeCreateContactAction } from '../../../api/create-contact-action-client.ts';
import type { executeCreateCustomerAction } from '../../../api/create-customer-action-client.ts';
import { executeCustomerDirectory } from '../../../api/customer-directory-client.ts';
import type { executeDeleteContactAction } from '../../../api/delete-contact-action-client.ts';
import type { executeDeleteCustomerAction } from '../../../api/delete-customer-action-client.ts';
import type { executeEditContactAction } from '../../../api/edit-contact-action-client.ts';
import type { executeEditCustomerAction } from '../../../api/edit-customer-action-client.ts';
import { runEffectRequest } from '../../../api/crm-client.ts';
import type {
  ContactView,
  CustomerDirectoryRequest,
  CustomerDirectoryResponse,
  CustomerView,
} from '../../../../shared/apis/customer-directory.ts';
import { decodeContactCursorValue } from '../../../../shared/apis/customer-directory.ts';
import type {
  ContactDeleteResult,
  ContactDetailModel,
  ContactMutationResult,
  ContactPanelModel,
  ContactRouteValidationReason,
} from '../../../contacts/contact-view-model.ts';
import { customerRecordToDetail } from '../../../customers/customer-view-model.ts';
import type {
  CustomerDeleteResult,
  CustomerMutationResult,
  CustomerPageModel,
  CustomerRecordModel,
  CustomerRouteValidationReason,
} from '../../../customers/customer-view-model.ts';

const pageSize = 20;
const contactPageSize = 20;
const maximumPage = 100;
const customerCursorPattern =
  /^[A-Za-z0-9_-]+\.[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const entityIdPattern = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;

export type CustomerDirectoryFailure = Effect.Error<ReturnType<typeof executeCustomerDirectory>>;
export type CustomerMutationClientFailure =
  | Effect.Error<ReturnType<typeof executeCreateCustomerAction>>
  | Effect.Error<ReturnType<typeof executeEditCustomerAction>>;
export type CustomerDeleteClientFailure = Effect.Error<
  ReturnType<typeof executeDeleteCustomerAction>
>;
export type ContactMutationClientFailure =
  | Effect.Error<ReturnType<typeof executeCreateContactAction>>
  | Effect.Error<ReturnType<typeof executeEditContactAction>>;
export type ContactDeleteClientFailure = Effect.Error<
  ReturnType<typeof executeDeleteContactAction>
>;

export interface CustomerRouteState {
  readonly contactCursor?: string;
  readonly contactPage?: number;
  readonly cursor?: string;
  readonly page: number;
  readonly selectedContactId?: string;
  readonly selectedCustomerId?: string;
}

export type CustomerRouteParseResult =
  | {
      readonly contactValidationReason?: ContactRouteValidationReason;
      readonly state: 'valid';
      readonly value: CustomerRouteState;
    }
  | { readonly reason: CustomerRouteValidationReason; readonly state: 'invalid' };

export interface CustomerPageClients {
  readonly directory: (
    payload: CustomerDirectoryRequest,
    correlationId: string,
  ) => Effect.Effect<CustomerDirectoryResponse, CustomerDirectoryFailure>;
}

const defaultClients: CustomerPageClients = {
  directory: executeCustomerDirectory as CustomerPageClients['directory'],
};

const singleParameter = (parameters: URLSearchParams, name: string) => {
  const values = parameters.getAll(name);
  return values.length > 1 ? undefined : (values[0] ?? null);
};

const parseBoundedPage = (value: string | null | undefined) => {
  if (value === null) {
    return 1;
  }
  if (value === undefined) {
    return;
  }
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= maximumPage && `${page}` === value
    ? page
    : undefined;
};

const isValidCustomerCursor = (cursor: string | null | undefined, page: number) =>
  cursor !== undefined &&
  (cursor === null ||
    (cursor.length >= 39 && cursor.length <= 900 && customerCursorPattern.test(cursor))) &&
  (page === 1 || cursor !== null);

interface ParsedContactRoute {
  readonly invalidCustomerSelection: boolean;
  readonly route: Pick<CustomerRouteState, 'contactCursor' | 'contactPage' | 'selectedContactId'>;
  readonly validationReason?: ContactRouteValidationReason;
}

const parseContactRoute = (
  parameters: URLSearchParams,
  selectedCustomerId: string | null,
): ParsedContactRoute => {
  const contactPageValue = singleParameter(parameters, 'contactPage');
  const contactCursor = singleParameter(parameters, 'contactCursor');
  const selectedContactId = singleParameter(parameters, 'contact');
  const hasContactState =
    contactPageValue !== null || contactCursor !== null || selectedContactId !== null;
  if (selectedCustomerId === null && hasContactState) {
    return { invalidCustomerSelection: true, route: {} };
  }
  const contactPage = parseBoundedPage(contactPageValue);
  if (contactPage === undefined) {
    return { invalidCustomerSelection: false, route: {}, validationReason: 'invalid_page' };
  }
  const validCursor =
    contactCursor !== undefined &&
    (contactCursor === null ||
      (contactCursor.length >= 39 &&
        contactCursor.length <= 2400 &&
        decodeContactCursorValue(contactCursor) !== undefined)) &&
    (contactPage === 1 || contactCursor !== null);
  if (!validCursor) {
    return { invalidCustomerSelection: false, route: {}, validationReason: 'invalid_cursor' };
  }
  if (
    selectedContactId === undefined ||
    (selectedContactId !== null && !entityIdPattern.test(selectedContactId))
  ) {
    return { invalidCustomerSelection: false, route: {}, validationReason: 'invalid_selection' };
  }
  return {
    invalidCustomerSelection: false,
    route: {
      ...(typeof contactCursor === 'string' ? { contactCursor } : {}),
      ...(contactPageValue === null ? {} : { contactPage }),
      ...(typeof selectedContactId === 'string' ? { selectedContactId } : {}),
    },
  };
};

export const parseCustomerRouteState = (url: URL): CustomerRouteParseResult => {
  const pageValue = singleParameter(url.searchParams, 'page');
  const page = parseBoundedPage(pageValue);
  if (page === undefined) {
    return { reason: 'invalid_page', state: 'invalid' };
  }

  const cursor = singleParameter(url.searchParams, 'cursor');
  if (!isValidCustomerCursor(cursor, page)) {
    return { reason: 'invalid_cursor', state: 'invalid' };
  }

  const selectedCustomerId = singleParameter(url.searchParams, 'customer');
  if (
    selectedCustomerId === undefined ||
    (selectedCustomerId !== null && !entityIdPattern.test(selectedCustomerId))
  ) {
    return { reason: 'invalid_selection', state: 'invalid' };
  }

  const contact = parseContactRoute(url.searchParams, selectedCustomerId);
  if (contact.invalidCustomerSelection) {
    return { reason: 'invalid_selection', state: 'invalid' };
  }

  return {
    ...(contact.validationReason === undefined
      ? {}
      : { contactValidationReason: contact.validationReason }),
    state: 'valid',
    value: {
      ...contact.route,
      ...(typeof cursor === 'string' ? { cursor } : {}),
      page,
      ...(selectedCustomerId === null ? {} : { selectedCustomerId }),
    },
  };
};

const cleanHref = (url: URL) => url.pathname;

const customerHref = (
  url: URL,
  state: CustomerRouteState,
  changes: {
    readonly cursor?: string | null;
    readonly page?: number;
    readonly selectedCustomerId?: string | null;
  },
) => {
  const parameters = new URLSearchParams();
  const page = changes.page ?? state.page;
  const cursor = changes.cursor === undefined ? state.cursor : changes.cursor;
  const selectedCustomerId =
    changes.selectedCustomerId === undefined
      ? state.selectedCustomerId
      : changes.selectedCustomerId;
  if (page > 1) {
    parameters.set('page', `${page}`);
  }
  if (cursor !== undefined && cursor !== null) {
    parameters.set('cursor', cursor);
  }
  if (selectedCustomerId !== undefined && selectedCustomerId !== null) {
    parameters.set('customer', selectedCustomerId);
  }
  const query = parameters.toString();
  return query.length === 0 ? url.pathname : `${url.pathname}?${query}`;
};

const contactHref = (
  url: URL,
  state: CustomerRouteState,
  changes: {
    readonly contactCursor?: string | null;
    readonly contactPage?: number;
    readonly selectedContactId?: string | null;
  },
) => {
  const parameters = new URLSearchParams();
  if (state.page > 1) {
    parameters.set('page', `${state.page}`);
  }
  if (state.cursor !== undefined) {
    parameters.set('cursor', state.cursor);
  }
  if (state.selectedCustomerId !== undefined) {
    parameters.set('customer', state.selectedCustomerId);
  }
  const contactPage = changes.contactPage ?? state.contactPage ?? 1;
  const contactCursor =
    changes.contactCursor === undefined ? state.contactCursor : changes.contactCursor;
  const selectedContactId =
    changes.selectedContactId === undefined ? state.selectedContactId : changes.selectedContactId;
  if (contactPage > 1) {
    parameters.set('contactPage', `${contactPage}`);
  }
  if (contactCursor !== undefined && contactCursor !== null) {
    parameters.set('contactCursor', contactCursor);
  }
  if (selectedContactId !== undefined && selectedContactId !== null) {
    parameters.set('contact', selectedContactId);
  }
  const query = parameters.toString();
  return query.length === 0 ? url.pathname : `${url.pathname}?${query}`;
};

export const hrefWithSelectedCustomer = (href: string, customerId: string | null) => {
  const url = new URL(href, 'https://crm.invalid');
  const parsed = parseCustomerRouteState(url);
  const state = parsed.state === 'valid' ? parsed.value : { page: 1 };
  return customerHref(url, state, { selectedCustomerId: customerId });
};

export const hrefWithSelectedContact = (href: string, contactId: string | null) => {
  const url = new URL(href, 'https://crm.invalid');
  const parsed = parseCustomerRouteState(url);
  const state = parsed.state === 'valid' ? parsed.value : { page: 1 };
  return contactHref(url, state, { selectedContactId: contactId });
};

export const customerViewToRecord = (customer: CustomerView): CustomerRecordModel => ({
  address: customer.address,
  companyRegistrationNumber: customer.companyRegistrationNumber,
  customerId: customer.customerId,
  email: customer.email,
  name: customer.name,
  phone: customer.phone,
  taxIdentificationNumber: customer.taxIdentificationNumber,
  version: customer.version,
  website: customer.website,
});

export const contactViewToRecord = (contact: ContactView): ContactDetailModel => ({
  contactId: contact.contactId,
  customerId: contact.customerId,
  email: contact.email,
  firstName: contact.firstName,
  jobTitle: contact.jobTitle,
  lastName: contact.lastName,
  phone: contact.phone,
  version: contact.version,
});

const readFailureModel = (
  error: CustomerDirectoryFailure,
  retryHref: string,
): CustomerPageModel => {
  switch (error._tag) {
    case 'CustomerDirectoryValidationProblem': {
      return {
        reason: 'invalid_cursor',
        resetHref: retryHref.split('?')[0] ?? retryHref,
        state: 'validation',
      };
    }
    case 'CustomerDirectoryAuthenticationProblem':
    case 'CustomerDirectoryForbiddenProblem': {
      return { state: 'forbidden' };
    }
    case 'CustomerDirectoryNotFoundProblem': {
      return { state: 'not_found' };
    }
    case 'CustomerDirectoryPolicyProblem': {
      return {
        reason: 'policy',
        resetHref: retryHref.split('?')[0] ?? retryHref,
        state: 'validation',
      };
    }
    case 'CustomerDirectoryInternalProblem':
    case 'CustomerDirectoryPolicyConflictProblem':
    case 'CustomerDirectoryUnavailableProblem':
    case 'GatewayAudienceInvalidProblem':
    case 'GatewayInternalProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem':
    case 'HttpClientError':
    case 'SchemaError': {
      return { retryHref, state: 'unavailable' };
    }
    case 'GatewayAuthenticationRequiredProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
    }
    default: {
      return error satisfies never;
    }
  }
};

const routeCorrelationId = () => `customer-page-${Effect.runSync(Random.nextInt)}`;

const contactReadFailureModel = (
  error: CustomerDirectoryFailure,
  context: { readonly customerId: string; readonly customerName: string },
  resetHref: string,
  retryHref: string,
): ContactPanelModel => {
  switch (error._tag) {
    case 'CustomerDirectoryValidationProblem': {
      return { ...context, reason: 'invalid_cursor', resetHref, state: 'validation' };
    }
    case 'CustomerDirectoryPolicyProblem': {
      return { ...context, reason: 'policy', resetHref, state: 'validation' };
    }
    case 'CustomerDirectoryAuthenticationProblem':
    case 'CustomerDirectoryForbiddenProblem': {
      return { ...context, state: 'forbidden' };
    }
    case 'CustomerDirectoryNotFoundProblem': {
      return { ...context, state: 'not_found' };
    }
    case 'CustomerDirectoryPolicyConflictProblem': {
      return { ...context, retryHref, state: 'conflict' };
    }
    case 'CustomerDirectoryInternalProblem':
    case 'CustomerDirectoryUnavailableProblem':
    case 'GatewayAudienceInvalidProblem':
    case 'GatewayInternalProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem':
    case 'HttpClientError':
    case 'SchemaError': {
      return { ...context, retryHref, state: 'unavailable' };
    }
    case 'GatewayAuthenticationRequiredProblem':
    case 'GatewayForbiddenProblem': {
      return { ...context, state: 'forbidden' };
    }
    default: {
      return error satisfies never;
    }
  }
};

const loadContactPanelModelEffect = (
  url: URL,
  route: CustomerRouteState,
  customer: CustomerView,
  clients: CustomerPageClients,
  contactValidationReason?: ContactRouteValidationReason,
): Effect.Effect<ContactPanelModel, never> => {
  const context = { customerId: customer.customerId, customerName: customer.name };
  const resetHref = contactHref(url, route, {
    contactCursor: null,
    contactPage: 1,
    selectedContactId: null,
  });
  const retryHref = contactHref(url, route, {});
  if (contactValidationReason !== undefined) {
    return Effect.succeed({
      ...context,
      reason: contactValidationReason,
      resetHref,
      state: 'validation',
    });
  }
  const contactPage = route.contactPage ?? 1;
  type ContactListResponse = Extract<CustomerDirectoryResponse, { readonly operation: 'contacts' }>;
  interface ContactReadResult {
    readonly detail: ContactView | undefined;
    readonly foreignSelection: boolean;
    readonly list: ContactListResponse;
  }
  return clients
    .directory(
      {
        ...(route.contactCursor === undefined ? {} : { cursor: route.contactCursor }),
        customerId: customer.customerId,
        limit: contactPageSize,
        operation: 'contacts',
      },
      routeCorrelationId(),
    )
    .pipe(
      Effect.flatMap((response): Effect.Effect<ContactReadResult, CustomerDirectoryFailure> => {
        if (response.operation !== 'contacts' || response.customerId !== customer.customerId) {
          return Effect.die('Customer directory returned an invalid Contact list response.');
        }
        if (route.selectedContactId === undefined) {
          return Effect.succeed({
            detail: undefined,
            foreignSelection: false,
            list: response,
          });
        }
        return clients
          .directory(
            { contactId: route.selectedContactId, operation: 'contact_detail' },
            routeCorrelationId(),
          )
          .pipe(
            Effect.flatMap((detail) => {
              if (detail.operation !== 'contact_detail') {
                return Effect.die(
                  'Customer directory returned a non-Contact response for Contact detail.',
                );
              }
              return Effect.succeed({
                detail: detail.contact,
                foreignSelection: detail.contact.customerId !== customer.customerId,
                list: response,
              });
            }),
          );
      }),
      Effect.map(({ detail, foreignSelection, list }): ContactPanelModel => {
        if (foreignSelection) {
          return {
            ...context,
            reason: 'foreign_selection',
            resetHref,
            state: 'validation',
          };
        }
        const pagination = {
          ...(list.nextCursor === null || contactPage >= maximumPage
            ? {}
            : {
                nextHref: contactHref(url, route, {
                  contactCursor: list.nextCursor,
                  contactPage: contactPage + 1,
                }),
              }),
          page: contactPage,
        };
        if (list.items.length === 0 && detail === undefined) {
          return { ...context, pagination, state: 'empty' };
        }
        return {
          ...context,
          ...(detail === undefined ? {} : { detail: contactViewToRecord(detail) }),
          pagination,
          rows: list.items.map((contact) => ({
            contactId: contact.contactId,
            email: contact.email,
            firstName: contact.firstName,
            href: contactHref(url, route, { selectedContactId: contact.contactId }),
            jobTitle: contact.jobTitle,
            lastName: contact.lastName,
            phone: contact.phone,
            selected: contact.contactId === route.selectedContactId,
          })),
          state: 'resolved',
        };
      }),
      Effect.catch((error) =>
        Effect.succeed(contactReadFailureModel(error, context, resetHref, retryHref)),
      ),
    );
};

export const loadCustomerPageModel = (
  request: Pick<Request, 'url'>,
  clients: CustomerPageClients = defaultClients,
): Promise<CustomerPageModel> => {
  const url = new URL(request.url);
  const parsed = parseCustomerRouteState(url);
  if (parsed.state === 'invalid') {
    return Promise.resolve({
      reason: parsed.reason,
      resetHref: cleanHref(url),
      state: 'validation',
    });
  }
  const route = parsed.value;
  const listEffect = clients.directory(
    {
      ...(route.cursor === undefined ? {} : { cursor: route.cursor }),
      limit: pageSize,
      operation: 'list',
    },
    routeCorrelationId(),
  );
  type CustomerListResponse = Extract<CustomerDirectoryResponse, { readonly operation: 'list' }>;
  interface CustomerReadResult {
    readonly contacts: ContactPanelModel | undefined;
    readonly detail: CustomerView | undefined;
    readonly list: CustomerListResponse;
  }
  const read = listEffect.pipe(
    Effect.flatMap((response): Effect.Effect<CustomerReadResult, CustomerDirectoryFailure> => {
      if (response.operation !== 'list') {
        return Effect.die('Customer directory returned a detail response for a list request.');
      }
      if (route.selectedCustomerId === undefined) {
        return Effect.succeed({ contacts: undefined, detail: undefined, list: response });
      }
      return clients
        .directory(
          { customerId: route.selectedCustomerId, operation: 'detail' },
          routeCorrelationId(),
        )
        .pipe(
          Effect.flatMap((detail) => {
            if (detail.operation !== 'detail') {
              return Effect.die(
                'Customer directory returned a list response for a detail request.',
              );
            }
            return loadContactPanelModelEffect(
              url,
              route,
              detail.customer,
              clients,
              parsed.contactValidationReason,
            ).pipe(
              Effect.map((contacts) => ({ contacts, detail: detail.customer, list: response })),
            );
          }),
        );
    }),
    Effect.map(({ contacts, detail, list: listResponse }): CustomerPageModel => {
      const pagination = {
        ...(listResponse.nextCursor === null || route.page >= maximumPage
          ? {}
          : {
              nextHref: customerHref(url, route, {
                cursor: listResponse.nextCursor,
                page: route.page + 1,
              }),
            }),
        page: route.page,
      };
      if (listResponse.items.length === 0 && detail === undefined) {
        return { pagination, state: 'empty' };
      }
      return {
        ...(contacts === undefined ? {} : { contacts }),
        ...(detail === undefined
          ? {}
          : { detail: customerRecordToDetail(customerViewToRecord(detail)) }),
        pagination,
        rows: listResponse.items.map((customer) => ({
          city: customer.address?.city ?? null,
          companyRegistrationNumber: customer.companyRegistrationNumber,
          customerId: customer.customerId,
          email: customer.email,
          href: customerHref(url, route, { selectedCustomerId: customer.customerId }),
          name: customer.name,
          selected: customer.customerId === route.selectedCustomerId,
        })),
        state: 'resolved',
      };
    }),
    Effect.catch((error) => Effect.succeed(readFailureModel(error, customerHref(url, route, {})))),
  );
  return runEffectRequest(read);
};

type MutationClientFailure =
  | CustomerMutationClientFailure
  | CustomerDeleteClientFailure
  | ContactMutationClientFailure
  | ContactDeleteClientFailure;

type MutationFailureTag = MutationClientFailure['_tag'];
type MappedMutationFailure =
  | {
      readonly issues: readonly [{ readonly code: 'server_validation' }];
      readonly state: 'validation';
    }
  | { readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable' };

const mutationFailureCategory = {
  CreateContactAuthenticationProblem: 'forbidden',
  CreateContactConflictProblem: 'conflict',
  CreateContactForbiddenProblem: 'forbidden',
  CreateContactInternalProblem: 'unavailable',
  CreateContactNotFoundProblem: 'not_found',
  CreateContactPreconditionProblem: 'unavailable',
  CreateContactRejectedProblem: 'validation',
  CreateContactUnavailableProblem: 'unavailable',
  CreateContactValidationProblem: 'validation',
  CreateCustomerAuthenticationProblem: 'forbidden',
  CreateCustomerConflictProblem: 'conflict',
  CreateCustomerForbiddenProblem: 'forbidden',
  CreateCustomerInternalProblem: 'unavailable',
  CreateCustomerNotFoundProblem: 'not_found',
  CreateCustomerPreconditionProblem: 'unavailable',
  CreateCustomerRejectedProblem: 'validation',
  CreateCustomerUnavailableProblem: 'unavailable',
  CreateCustomerValidationProblem: 'validation',
  DeleteContactAuthenticationProblem: 'forbidden',
  DeleteContactConflictProblem: 'conflict',
  DeleteContactForbiddenProblem: 'forbidden',
  DeleteContactInternalProblem: 'unavailable',
  DeleteContactNotFoundProblem: 'not_found',
  DeleteContactPreconditionProblem: 'unavailable',
  DeleteContactRejectedProblem: 'validation',
  DeleteContactUnavailableProblem: 'unavailable',
  DeleteContactValidationProblem: 'validation',
  DeleteCustomerAuthenticationProblem: 'forbidden',
  DeleteCustomerConflictProblem: 'conflict',
  DeleteCustomerForbiddenProblem: 'forbidden',
  DeleteCustomerInternalProblem: 'unavailable',
  DeleteCustomerNotFoundProblem: 'not_found',
  DeleteCustomerPreconditionProblem: 'unavailable',
  DeleteCustomerRejectedProblem: 'validation',
  DeleteCustomerUnavailableProblem: 'unavailable',
  DeleteCustomerValidationProblem: 'validation',
  EditContactAuthenticationProblem: 'forbidden',
  EditContactConflictProblem: 'conflict',
  EditContactForbiddenProblem: 'forbidden',
  EditContactInternalProblem: 'unavailable',
  EditContactNotFoundProblem: 'not_found',
  EditContactPreconditionProblem: 'unavailable',
  EditContactRejectedProblem: 'validation',
  EditContactUnavailableProblem: 'unavailable',
  EditContactValidationProblem: 'validation',
  EditCustomerAuthenticationProblem: 'forbidden',
  EditCustomerConflictProblem: 'conflict',
  EditCustomerForbiddenProblem: 'forbidden',
  EditCustomerInternalProblem: 'unavailable',
  EditCustomerNotFoundProblem: 'not_found',
  EditCustomerPreconditionProblem: 'unavailable',
  EditCustomerRejectedProblem: 'validation',
  EditCustomerUnavailableProblem: 'unavailable',
  EditCustomerValidationProblem: 'validation',
  GatewayAudienceInvalidProblem: 'unavailable',
  GatewayAuthenticationRequiredProblem: 'forbidden',
  GatewayForbiddenProblem: 'forbidden',
  GatewayInternalProblem: 'unavailable',
  GatewayRateLimitedProblem: 'unavailable',
  GatewayUnavailableProblem: 'unavailable',
  HttpClientError: 'unavailable',
  SchemaError: 'unavailable',
} as const satisfies Record<
  MutationFailureTag,
  'conflict' | 'forbidden' | 'not_found' | 'unavailable' | 'validation'
>;

const mutationFailureFromTag = (tag: MutationFailureTag): MappedMutationFailure => {
  const category = mutationFailureCategory[tag];
  switch (category) {
    case 'validation': {
      return { issues: [{ code: 'server_validation' }], state: 'validation' };
    }
    case 'forbidden': {
      return { state: 'forbidden' };
    }
    case 'not_found': {
      return { state: 'not_found' };
    }
    case 'conflict': {
      return { state: 'conflict' };
    }
    case 'unavailable': {
      return { state: 'unavailable' };
    }
    default: {
      return category satisfies never;
    }
  }
};

export const mutationFailure = (
  error: CustomerMutationClientFailure,
): Exclude<CustomerMutationResult, { state: 'success' }> => mutationFailureFromTag(error._tag);

export const deleteFailure = (
  error: CustomerDeleteClientFailure,
): Exclude<CustomerDeleteResult, { state: 'success' }> => {
  const failure = mutationFailureFromTag(error._tag);
  return failure.state === 'validation' ? { state: 'unavailable' } : failure;
};

export const contactMutationFailure = (
  error: ContactMutationClientFailure,
): Exclude<ContactMutationResult, { state: 'success' }> => mutationFailureFromTag(error._tag);

export const contactDeleteFailure = (
  error: ContactDeleteClientFailure,
): Exclude<ContactDeleteResult, { state: 'success' }> => {
  const failure = mutationFailureFromTag(error._tag);
  return failure.state === 'validation' ? { state: 'unavailable' } : failure;
};

export const isCustomerPageModel = (value: unknown): value is CustomerPageModel => {
  if (typeof value !== 'object' || value === null || !('state' in value)) {
    return false;
  }
  return [
    'empty',
    'forbidden',
    'loading',
    'not_found',
    'resolved',
    'unavailable',
    'validation',
  ].includes(`${value.state}`);
};

interface CustomerLoaderArguments {
  readonly request: Request;
}

export const loader = ({ request }: CustomerLoaderArguments): Promise<CustomerPageModel> =>
  loadCustomerPageModel(request);
