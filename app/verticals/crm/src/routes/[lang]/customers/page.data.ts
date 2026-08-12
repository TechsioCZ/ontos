/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- the route preserves Effect failures until the framework boundary */
import { Effect, Random } from 'effect';
import { executeCustomerDirectory } from '../../../api/customer-directory-client.ts';
import { runEffectRequest } from '../../../api/crm-client.ts';
import type {
  CustomerDirectoryRequest,
  CustomerDirectoryResponse,
  CustomerView,
} from '../../../../shared/apis/customer-directory.ts';
import { customerRecordToDetail } from '../../../customers/customer-view-model.ts';
import type {
  CustomerDeleteResult,
  CustomerMutationResult,
  CustomerPageModel,
  CustomerRecordModel,
  CustomerRouteValidationReason,
} from '../../../customers/customer-view-model.ts';

const pageSize = 20;
const maximumPage = 100;
const customerCursorPattern =
  /^[A-Za-z0-9_-]+\.[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const customerIdPattern = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;

export interface CustomerRouteState {
  readonly cursor?: string;
  readonly page: number;
  readonly selectedCustomerId?: string;
}

export type CustomerRouteParseResult =
  | { readonly state: 'valid'; readonly value: CustomerRouteState }
  | { readonly reason: CustomerRouteValidationReason; readonly state: 'invalid' };

export interface CustomerPageClients {
  readonly directory: (
    payload: CustomerDirectoryRequest,
    correlationId: string,
  ) => Effect.Effect<CustomerDirectoryResponse, CustomerClientFailure>;
}

const defaultClients: CustomerPageClients = {
  directory: executeCustomerDirectory as CustomerPageClients['directory'],
};

const singleParameter = (parameters: URLSearchParams, name: string) => {
  const values = parameters.getAll(name);
  return values.length > 1 ? undefined : (values[0] ?? null);
};

export const parseCustomerRouteState = (url: URL): CustomerRouteParseResult => {
  const pageValue = singleParameter(url.searchParams, 'page');
  if (pageValue === undefined) {
    return { reason: 'invalid_page', state: 'invalid' };
  }
  const page = pageValue === null ? 1 : Number(pageValue);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > maximumPage ||
    (pageValue !== null && `${page}` !== pageValue)
  ) {
    return { reason: 'invalid_page', state: 'invalid' };
  }

  const cursor = singleParameter(url.searchParams, 'cursor');
  if (
    cursor === undefined ||
    (cursor !== null &&
      (cursor.length < 39 || cursor.length > 900 || !customerCursorPattern.test(cursor))) ||
    (page > 1 && cursor === null)
  ) {
    return { reason: 'invalid_cursor', state: 'invalid' };
  }

  const selectedCustomerId = singleParameter(url.searchParams, 'customer');
  if (
    selectedCustomerId === undefined ||
    (selectedCustomerId !== null && !customerIdPattern.test(selectedCustomerId))
  ) {
    return { reason: 'invalid_selection', state: 'invalid' };
  }

  return {
    state: 'valid',
    value: {
      ...(cursor === null ? {} : { cursor }),
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

export const hrefWithSelectedCustomer = (href: string, customerId: string | null) => {
  const url = new URL(href, 'https://crm.invalid');
  const parsed = parseCustomerRouteState(url);
  const state = parsed.state === 'valid' ? parsed.value : { page: 1 };
  return customerHref(url, state, { selectedCustomerId: customerId });
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

export interface CustomerClientFailure {
  readonly _tag?: string;
  readonly status?: number;
}

const clientErrorTag = (error: unknown): CustomerClientFailure =>
  typeof error === 'object' && error !== null ? (error as CustomerClientFailure) : {};

const readFailureModel = (error: unknown, retryHref: string): CustomerPageModel => {
  const { _tag: tag, status } = clientErrorTag(error);
  switch (tag) {
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
    default: {
      if (status === 401 || status === 403) {
        return { state: 'forbidden' };
      }
      if (status === 404) {
        return { state: 'not_found' };
      }
      return { retryHref, state: 'unavailable' };
    }
  }
};

const routeCorrelationId = () => `customer-page-${Effect.runSync(Random.nextInt)}`;

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
    readonly detail: CustomerView | undefined;
    readonly list: CustomerListResponse;
  }
  const read = listEffect.pipe(
    Effect.flatMap((response): Effect.Effect<CustomerReadResult, CustomerClientFailure> => {
      if (response.operation !== 'list') {
        return Effect.die('Customer directory returned a detail response for a list request.');
      }
      if (route.selectedCustomerId === undefined) {
        return Effect.succeed({ detail: undefined, list: response });
      }
      return clients
        .directory(
          { customerId: route.selectedCustomerId, operation: 'detail' },
          routeCorrelationId(),
        )
        .pipe(
          Effect.flatMap((detail) =>
            detail.operation === 'detail'
              ? Effect.succeed({ detail: detail.customer, list: response })
              : Effect.die('Customer directory returned a list response for a detail request.'),
          ),
        );
    }),
    Effect.map(({ detail, list: listResponse }): CustomerPageModel => {
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

export const mutationFailure = (
  error: unknown,
): Exclude<CustomerMutationResult, { state: 'success' }> => {
  const { _tag: tag, status } = clientErrorTag(error);
  if (tag?.endsWith('ValidationProblem') === true || status === 400 || status === 422) {
    return { issues: [{ code: 'server_validation' }], state: 'validation' };
  }
  if (tag?.endsWith('ForbiddenProblem') === true || status === 401 || status === 403) {
    return { state: 'forbidden' };
  }
  if (tag?.endsWith('NotFoundProblem') === true || status === 404) {
    return { state: 'not_found' };
  }
  if (tag?.endsWith('ConflictProblem') === true || status === 409) {
    return { state: 'conflict' };
  }
  return { state: 'unavailable' };
};

export const deleteFailure = (
  error: unknown,
): Exclude<CustomerDeleteResult, { state: 'success' }> => {
  const failure = mutationFailure(error);
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
