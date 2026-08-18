import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link, useLocation, useNavigate } from '@modern-js/plugin-tanstack/runtime';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link as UiLink } from '@techsio/ui-kit/atoms/link';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect as EffectRuntime, Random } from 'effect';
import { useMemo, useRef } from 'react';
import type { Customer, CustomerListResponse } from '../../../../../shared/api.ts';
import {
  archiveCustomer,
  getCustomerList,
  runEffectRequest,
  unarchiveCustomer,
} from '../../../../api/crm-client.ts';
import type { Effect } from '../../../../api/crm-client.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';

export const CUSTOMER_LIST_PAGE_SIZE = 25;
const MAX_CUSTOMER_LIST_OFFSET = Number.MAX_SAFE_INTEGER - CUSTOMER_LIST_PAGE_SIZE;

export type CustomerArchiveFilter = 'active' | 'archived' | 'all';

export interface CustomerListUrlState {
  readonly offset: number;
  readonly status: CustomerArchiveFilter;
}

export const parseCustomerListSearch = (search: string): CustomerListUrlState => {
  const parameters = new URLSearchParams(search);
  const statuses = parameters.getAll('status');
  const status =
    statuses.length === 1 &&
    (statuses[0] === 'active' || statuses[0] === 'archived' || statuses[0] === 'all')
      ? statuses[0]
      : 'active';
  const offsets = parameters.getAll('offset');
  const rawOffset = offsets.length === 1 ? offsets[0] : undefined;
  const parsedOffset =
    rawOffset === undefined || !/^(?:0|[1-9]\d*)$/u.test(rawOffset)
      ? Number.NaN
      : Number(rawOffset);
  const offset =
    Number.isSafeInteger(parsedOffset) &&
    parsedOffset >= 0 &&
    parsedOffset <= MAX_CUSTOMER_LIST_OFFSET
      ? parsedOffset
      : 0;

  return { offset, status };
};

export const customerListQueryKey = ({ offset, status }: CustomerListUrlState) =>
  ['crm', 'customers', 'list', { limit: CUSTOMER_LIST_PAGE_SIZE, offset, status }] as const;

export const buildCustomerListHref = (
  language: string,
  currentSearch: string,
  status: CustomerArchiveFilter,
  offset: number,
) => {
  const parameters = new URLSearchParams(currentSearch);
  parameters.delete('status');
  parameters.delete('offset');
  parameters.set('status', status);
  if (offset > 0) {
    parameters.set('offset', String(offset));
  }
  const search = parameters.toString();
  return `/${language}/crm/customers${search.length === 0 ? '' : `?${search}`}`;
};

type CustomerListClientError = Effect.Error<ReturnType<typeof getCustomerList>>;
type CustomerLifecycleClientError =
  | Effect.Error<ReturnType<typeof archiveCustomer>>
  | Effect.Error<ReturnType<typeof unarchiveCustomer>>;
type CustomerListUnavailableReason = 'backend' | 'decode' | 'internal' | 'transport';
type CustomerListErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'forbidden' }
  | { readonly reason: CustomerListUnavailableReason; readonly state: 'unavailable' };

export const classifyCustomerListError = (
  error: CustomerListClientError,
): CustomerListErrorState => {
  if (error._tag === 'HttpClientError') {
    if (error.reason._tag === 'TransportError') {
      return { reason: 'transport', state: 'unavailable' };
    }
    if (error.reason._tag === 'DecodeError' || error.reason._tag === 'EmptyBodyError') {
      return { reason: 'decode', state: 'unavailable' };
    }
    return { reason: 'internal', state: 'unavailable' };
  }
  if (error._tag === 'SchemaError') {
    return { reason: 'decode', state: 'unavailable' };
  }

  switch (error._tag) {
    case 'CustomerListForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
    }
    case 'CustomerListAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'CustomerListUnavailableProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem': {
      return { reason: 'backend', state: 'unavailable' };
    }
    case 'CustomerListInvalidProblem':
    case 'CustomerListInternalProblem':
    case 'GatewayAudienceInvalidProblem':
    case 'GatewayInternalProblem': {
      return { reason: 'internal', state: 'unavailable' };
    }
    default: {
      const unexpected: never = error;
      return unexpected;
    }
  }
};

type CustomerLifecycleErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'conflict' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'invalid' }
  | { readonly state: 'not_found' }
  | { readonly state: 'unavailable'; readonly uncertain: true }
  | { readonly state: 'unexpected' };

export const classifyCustomerLifecycleError = (
  error: CustomerLifecycleClientError,
): CustomerLifecycleErrorState => {
  if (error._tag === 'HttpClientError' || error._tag === 'SchemaError') {
    return { state: 'unavailable', uncertain: true };
  }

  switch (error._tag) {
    case 'CrmAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'CrmForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
    }
    case 'CrmInvalidRequestProblem': {
      return { state: 'invalid' };
    }
    case 'CrmNotFoundProblem': {
      return { state: 'not_found' };
    }
    case 'CrmConflictProblem':
    case 'CrmPreconditionRequiredProblem': {
      return { state: 'conflict' };
    }
    case 'CrmUnavailableProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem': {
      return { state: 'unavailable', uncertain: true };
    }
    case 'CrmInternalProblem':
    case 'GatewayAudienceInvalidProblem':
    case 'GatewayInternalProblem': {
      return { state: 'unexpected' };
    }
    default: {
      const unexpected: never = error;
      return unexpected;
    }
  }
};

interface CustomerListRowModel {
  readonly createdAt: string;
  readonly createdAtIso: string;
  readonly customerId: string;
  readonly detailHref: string;
  readonly editHref: string;
  readonly lifecycle: 'active' | 'archived';
  readonly name: string;
  readonly updatedAt: string;
  readonly updatedAtIso: string;
}

type CustomersListViewState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'empty' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'loading' }
  | {
      readonly items: readonly CustomerListRowModel[];
      readonly nextOffset: null | number;
      readonly state: 'populated';
    }
  | {
      readonly reason: CustomerListUnavailableReason;
      readonly state: 'unavailable';
    };

interface CustomersListCopy {
  readonly actionsColumn: string;
  readonly archive: string;
  readonly archiving: string;
  readonly authenticationExpired: string;
  readonly create: string;
  readonly empty: string;
  readonly filterActive: string;
  readonly filterAll: string;
  readonly filterArchived: string;
  readonly filterLabel: string;
  readonly filterPlaceholder: string;
  readonly forbidden: string;
  readonly edit: string;
  readonly internal: string;
  readonly loading: string;
  readonly lifecycleAuthenticationExpired: string;
  readonly lifecycleConflict: string;
  readonly lifecycleForbidden: string;
  readonly lifecycleInvalid: string;
  readonly lifecycleNotFound: string;
  readonly lifecycleUnavailable: string;
  readonly lifecycleUnexpected: string;
  readonly nameColumn: string;
  readonly next: string;
  readonly paginationLabel: string;
  readonly previous: string;
  readonly retry: string;
  readonly retrying: string;
  readonly statusActive: string;
  readonly statusArchived: string;
  readonly statusColumn: string;
  readonly tableCaption: string;
  readonly transport: string;
  readonly unarchive: string;
  readonly unarchiving: string;
  readonly decode: string;
  readonly unavailable: string;
  readonly createdAtColumn: string;
  readonly updatedAtColumn: string;
}

interface CustomersListViewProps {
  readonly copy: CustomersListCopy;
  readonly currentSearch: string;
  readonly language: string;
  readonly offset: number;
  readonly lifecycleError: null | string;
  readonly onToggleLifecycle: (customerId: string, lifecycle: 'active' | 'archived') => void;
  readonly pendingCustomerId: null | string;
  readonly onRetry: () => Promise<unknown>;
  readonly onStatusChange: (status: CustomerArchiveFilter) => void;
  readonly retrying: boolean;
  readonly status: CustomerArchiveFilter;
  readonly view: CustomersListViewState;
}

const CustomerTableHeader = ({ copy }: { readonly copy: CustomersListCopy }) => (
  <Table.Header>
    <Table.Row>
      <Table.ColumnHeader scope="col">{copy.nameColumn}</Table.ColumnHeader>
      <Table.ColumnHeader scope="col">{copy.statusColumn}</Table.ColumnHeader>
      <Table.ColumnHeader scope="col">{copy.createdAtColumn}</Table.ColumnHeader>
      <Table.ColumnHeader scope="col">{copy.updatedAtColumn}</Table.ColumnHeader>
      <Table.ColumnHeader scope="col">
        <span className="crm:flex crm:justify-end">{copy.actionsColumn}</span>
      </Table.ColumnHeader>
    </Table.Row>
  </Table.Header>
);

const LoadingCustomerTable = ({ copy }: { readonly copy: CustomersListCopy }) => (
  <div className="crm:max-w-full crm:overflow-x-auto" data-testid="customers-table-overflow">
    <Table aria-busy="true" className="crm:min-w-3xl" size="sm" variant="line">
      <Table.Caption>{copy.tableCaption}</Table.Caption>
      <CustomerTableHeader copy={copy} />
      <Table.Body>
        {Array.from({ length: 3 }, (_row, rowIndex) => (
          <Table.Row key={`loading-${rowIndex}`}>
            {Array.from({ length: 5 }, (_cell, cellIndex) => (
              <Table.Cell aria-hidden="true" key={`loading-${rowIndex}-${cellIndex}`}>
                <Skeleton.Text noOfLines={1} size="sm" />
              </Table.Cell>
            ))}
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  </div>
);

const CustomerTable = ({
  copy,
  items,
  onToggleLifecycle,
  pendingCustomerId,
}: {
  readonly copy: CustomersListCopy;
  readonly items: readonly CustomerListRowModel[];
  readonly onToggleLifecycle: (customerId: string, lifecycle: 'active' | 'archived') => void;
  readonly pendingCustomerId: null | string;
}) => {
  const emptyDescriptionId = items.length === 0 ? 'customers-empty-description' : undefined;

  return (
    <>
      <div className="crm:max-w-full crm:overflow-x-auto" data-testid="customers-table-overflow">
        <Table
          aria-describedby={emptyDescriptionId}
          className="crm:min-w-3xl"
          size="sm"
          variant="line"
        >
          <Table.Caption>{copy.tableCaption}</Table.Caption>
          <CustomerTableHeader copy={copy} />
          <Table.Body>
            {items.map((customer) => (
              <Table.Row key={customer.customerId}>
                <Table.Cell>
                  <UiLink as={Link} to={customer.detailHref}>
                    {customer.name}
                  </UiLink>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant={customer.lifecycle === 'active' ? 'success' : 'outline'}>
                    {customer.lifecycle === 'active' ? copy.statusActive : copy.statusArchived}
                  </Badge>
                </Table.Cell>
                <Table.Cell className="crm:whitespace-nowrap">
                  <time dateTime={customer.createdAtIso}>{customer.createdAt}</time>
                </Table.Cell>
                <Table.Cell className="crm:whitespace-nowrap">
                  <time dateTime={customer.updatedAtIso}>{customer.updatedAt}</time>
                </Table.Cell>
                <Table.Cell>
                  <div className="crm:flex crm:flex-wrap crm:justify-end crm:gap-2">
                    <LinkButton
                      as={Link}
                      href={customer.editHref}
                      size="sm"
                      to={customer.editHref}
                      variant="primary"
                    >
                      {copy.edit}
                    </LinkButton>
                    <Button
                      disabled={pendingCustomerId !== null}
                      isLoading={pendingCustomerId === customer.customerId}
                      loadingText={
                        customer.lifecycle === 'active' ? copy.archiving : copy.unarchiving
                      }
                      onClick={() => onToggleLifecycle(customer.customerId, customer.lifecycle)}
                      size="sm"
                      theme="outlined"
                      type="button"
                      variant={customer.lifecycle === 'active' ? 'danger' : 'warning'}
                    >
                      {customer.lifecycle === 'active' ? copy.archive : copy.unarchive}
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      {emptyDescriptionId === undefined ? null : (
        <p className="crm:sr-only" id={emptyDescriptionId}>
          {copy.empty}
        </p>
      )}
    </>
  );
};

export const CustomersListView = ({
  copy,
  currentSearch,
  language,
  lifecycleError,
  offset,
  onToggleLifecycle,
  pendingCustomerId,
  onRetry,
  onStatusChange,
  retrying,
  status,
  view,
}: CustomersListViewProps) => {
  const resultsRef = useRef<HTMLDivElement>(null);
  const createHref = `/${language}/crm/customers/context/new`;
  const statusItems = [
    { label: copy.filterActive, value: 'active' },
    { label: copy.filterArchived, value: 'archived' },
    { label: copy.filterAll, value: 'all' },
  ];
  const retry = () =>
    // oxlint-disable-next-line promise/prefer-await-to-then -- Retry callbacks stay non-async under strict Effect diagnostics.
    onRetry().then(() => {
      resultsRef.current?.focus();
    });
  const unavailableCopy =
    view.state === 'unavailable'
      ? {
          backend: copy.unavailable,
          decode: copy.decode,
          internal: copy.internal,
          transport: copy.transport,
        }[view.reason]
      : copy.unavailable;

  return (
    <section
      aria-labelledby="customers-list-heading"
      className="crm:grid crm:min-w-0 crm:w-full crm:gap-6"
    >
      <div className="crm:grid crm:gap-4 crm:sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] crm:sm:items-end">
        <div className="crm:flex crm:flex-wrap crm:items-center crm:justify-between crm:gap-3">
          <h1 className="crm:text-3xl crm:font-bold" id="customers-list-heading">
            {copy.tableCaption}
          </h1>
          <LinkButton as={Link} href={createHref} size="sm" to={createHref} variant="primary">
            {copy.create}
          </LinkButton>
        </div>
        <Select
          items={statusItems}
          name="customer-status"
          onValueChange={({ value }) => {
            const [nextStatus] = value;
            if (nextStatus === 'active' || nextStatus === 'archived' || nextStatus === 'all') {
              onStatusChange(nextStatus);
            }
          }}
          size="sm"
          value={[status]}
        >
          <Select.Label>{copy.filterLabel}</Select.Label>
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder={copy.filterPlaceholder} />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {statusItems.map((item) => (
                <Select.Item item={item} key={item.value}>
                  <Select.ItemText />
                  <Select.ItemIndicator />
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select>
      </div>

      <div aria-live="polite" data-testid="customers-results" ref={resultsRef} tabIndex={-1}>
        {view.state === 'loading' ? (
          <div className="crm:grid crm:gap-3">
            <StatusText status="default">
              <output>{copy.loading}</output>
            </StatusText>
            <LoadingCustomerTable copy={copy} />
          </div>
        ) : null}
        {lifecycleError === null ? null : (
          <StatusText showIcon status="error">
            <output>{lifecycleError}</output>
          </StatusText>
        )}
        {view.state === 'empty' ? (
          <CustomerTable
            copy={copy}
            items={[]}
            onToggleLifecycle={onToggleLifecycle}
            pendingCustomerId={pendingCustomerId}
          />
        ) : null}
        {view.state === 'forbidden' ? (
          <StatusText showIcon status="error">
            <output>{copy.forbidden}</output>
          </StatusText>
        ) : null}
        {view.state === 'authentication_expired' ? (
          <div className="crm:grid crm:justify-items-start crm:gap-3">
            <StatusText showIcon status="error">
              <output>{copy.authenticationExpired}</output>
            </StatusText>
            <Button
              disabled={retrying}
              isLoading={retrying}
              loadingText={copy.retrying}
              onClick={() => void retry()}
              size="sm"
              type="button"
              variant="primary"
            >
              {copy.retry}
            </Button>
          </div>
        ) : null}
        {view.state === 'unavailable' ? (
          <div className="crm:grid crm:justify-items-start crm:gap-3">
            <StatusText showIcon status="error">
              <output>{unavailableCopy}</output>
            </StatusText>
            <Button
              disabled={retrying}
              isLoading={retrying}
              loadingText={copy.retrying}
              onClick={() => void retry()}
              size="sm"
              type="button"
              variant="primary"
            >
              {copy.retry}
            </Button>
          </div>
        ) : null}
        {view.state === 'populated' ? (
          <div className="crm:grid crm:gap-4">
            <CustomerTable
              copy={copy}
              items={view.items}
              onToggleLifecycle={onToggleLifecycle}
              pendingCustomerId={pendingCustomerId}
            />
            {offset > 0 || view.nextOffset !== null ? (
              <nav aria-label={copy.paginationLabel} className="crm:flex crm:flex-wrap crm:gap-3">
                {offset > 0 ? (
                  <LinkButton
                    as={Link}
                    size="sm"
                    theme="outlined"
                    to={buildCustomerListHref(
                      language,
                      currentSearch,
                      status,
                      Math.max(0, offset - CUSTOMER_LIST_PAGE_SIZE),
                    )}
                    variant="secondary"
                  >
                    {copy.previous}
                  </LinkButton>
                ) : null}
                {view.nextOffset === null ? null : (
                  <LinkButton
                    as={Link}
                    size="sm"
                    theme="outlined"
                    to={buildCustomerListHref(language, currentSearch, status, view.nextOffset)}
                    variant="primary"
                  >
                    {copy.next}
                  </LinkButton>
                )}
              </nav>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
};

const formatCustomerTimestamp = (value: string, language: string) =>
  new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
    Date.parse(value),
  );

const createCorrelationId = () =>
  Array.from({ length: 4 }, () =>
    EffectRuntime.runSync(Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)).toString(36),
  ).join('-');

const CustomersListFeature = () => {
  const { language, t } = useModernI18n();
  const queryClient = useQueryClient();
  const search = useLocation({ select: (location) => location.searchStr });
  const navigate = useNavigate();
  const urlState = parseCustomerListSearch(search);
  const query = useQuery<CustomerListResponse, CustomerListClientError>({
    queryFn: () =>
      runEffectRequest(
        getCustomerList(
          {
            filter: urlState.status,
            limit: CUSTOMER_LIST_PAGE_SIZE,
            offset: urlState.offset,
          },
          {
            baseUrl: ULTRAMODERN_CRM_API_BASE_URL,
            correlationId: createCorrelationId(),
            locale: language,
          },
        ),
      ),
    queryKey: customerListQueryKey(urlState),
    retry: false,
  });
  const lifecycleMutation = useMutation<
    Customer,
    CustomerLifecycleClientError,
    {
      readonly customerId: string;
      readonly idempotencyKey: string;
      readonly operation: 'archive' | 'unarchive';
    }
  >({
    mutationFn: ({ customerId, idempotencyKey, operation }) =>
      runEffectRequest(
        (operation === 'archive' ? archiveCustomer : unarchiveCustomer)(
          { customerId },
          {
            baseUrl: ULTRAMODERN_CRM_API_BASE_URL,
            correlationId: createCorrelationId(),
            idempotencyKey,
            locale: language,
          },
        ),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: customerListQueryKey(urlState) }),
    retry: false,
  });
  const lifecycleAttemptRef = useRef<{
    readonly customerId: string;
    readonly idempotencyKey: string;
    readonly operation: 'archive' | 'unarchive';
    readonly uncertain: boolean;
  } | null>(null);
  const refetch = () => query.refetch();
  const copy: CustomersListCopy = {
    actionsColumn: t('crm.pages.customersList.table.actions'),
    archive: t('crm.pages.customersList.table.archive'),
    archiving: t('crm.pages.customersList.table.archiving'),
    authenticationExpired: t('crm.pages.customersList.states.authenticationExpired'),
    create: t('crm.pages.customerCreate.title'),
    createdAtColumn: t('crm.pages.customersList.table.createdAt'),
    decode: t('crm.pages.customersList.states.decode'),
    edit: t('crm.pages.customersList.table.edit'),
    empty: t('crm.pages.customersList.states.empty'),
    filterActive: t('crm.pages.customersList.filter.active'),
    filterAll: t('crm.pages.customersList.filter.all'),
    filterArchived: t('crm.pages.customersList.filter.archived'),
    filterLabel: t('crm.pages.customersList.filter.label'),
    filterPlaceholder: t('crm.pages.customersList.filter.placeholder'),
    forbidden: t('crm.pages.customersList.states.forbidden'),
    internal: t('crm.pages.customersList.states.internal'),
    lifecycleAuthenticationExpired: t('crm.pages.customersList.lifecycle.authenticationExpired'),
    lifecycleConflict: t('crm.pages.customersList.lifecycle.conflict'),
    lifecycleForbidden: t('crm.pages.customersList.lifecycle.forbidden'),
    lifecycleInvalid: t('crm.pages.customersList.lifecycle.invalid'),
    lifecycleNotFound: t('crm.pages.customersList.lifecycle.notFound'),
    lifecycleUnavailable: t('crm.pages.customersList.lifecycle.unavailable'),
    lifecycleUnexpected: t('crm.pages.customersList.lifecycle.unexpected'),
    loading: t('crm.pages.customersList.states.loading'),
    nameColumn: t('crm.pages.customersList.table.name'),
    next: t('crm.pages.customersList.pagination.next'),
    paginationLabel: t('crm.pages.customersList.pagination.label'),
    previous: t('crm.pages.customersList.pagination.previous'),
    retry: t('crm.pages.customersList.states.retry'),
    retrying: t('crm.pages.customersList.states.retrying'),
    statusActive: t('crm.pages.customersList.status.active'),
    statusArchived: t('crm.pages.customersList.status.archived'),
    statusColumn: t('crm.pages.customersList.table.status'),
    tableCaption: t('crm.pages.customersList.table.caption'),
    transport: t('crm.pages.customersList.states.transport'),
    unarchive: t('crm.pages.customersList.table.unarchive'),
    unarchiving: t('crm.pages.customersList.table.unarchiving'),
    unavailable: t('crm.pages.customersList.states.unavailable'),
    updatedAtColumn: t('crm.pages.customersList.table.updatedAt'),
  };
  const toggleLifecycle = (customerId: string, lifecycle: 'active' | 'archived') => {
    const operation = lifecycle === 'active' ? 'archive' : 'unarchive';
    const previousAttempt = lifecycleAttemptRef.current;
    const idempotencyKey =
      previousAttempt?.uncertain === true &&
      previousAttempt.customerId === customerId &&
      previousAttempt.operation === operation
        ? previousAttempt.idempotencyKey
        : createCorrelationId();
    lifecycleAttemptRef.current = { customerId, idempotencyKey, operation, uncertain: false };

    lifecycleMutation.mutate(
      { customerId, idempotencyKey, operation },
      {
        onError: (error) => {
          const state = classifyCustomerLifecycleError(error);
          lifecycleAttemptRef.current =
            state.state === 'unavailable'
              ? { customerId, idempotencyKey, operation, uncertain: true }
              : null;
        },
        onSuccess: () => {
          lifecycleAttemptRef.current = null;
        },
      },
    );
  };
  const lifecycleErrorState =
    lifecycleMutation.isError && lifecycleMutation.error !== null
      ? classifyCustomerLifecycleError(lifecycleMutation.error)
      : null;
  const lifecycleError =
    lifecycleErrorState === null
      ? null
      : {
          authentication_expired: copy.lifecycleAuthenticationExpired,
          conflict: copy.lifecycleConflict,
          forbidden: copy.lifecycleForbidden,
          invalid: copy.lifecycleInvalid,
          not_found: copy.lifecycleNotFound,
          unavailable: copy.lifecycleUnavailable,
          unexpected: copy.lifecycleUnexpected,
        }[lifecycleErrorState.state];
  let view: CustomersListViewState;
  if (query.isPending) {
    view = { state: 'loading' };
  } else if (query.isError) {
    view = classifyCustomerListError(query.error);
  } else if (query.data.items.length === 0) {
    view = { state: 'empty' };
  } else {
    view = {
      items: query.data.items.map((customer) => {
        const detailHref = `/${language}/crm/customers/${encodeURIComponent(customer.customerId)}`;
        return {
          createdAt: formatCustomerTimestamp(customer.createdAt, language),
          createdAtIso: customer.createdAt,
          customerId: customer.customerId,
          detailHref,
          editHref: `${detailHref}/edit`,
          lifecycle: customer.archivedAt === null ? 'active' : 'archived',
          name: customer.name,
          updatedAt: formatCustomerTimestamp(customer.updatedAt, language),
          updatedAtIso: customer.updatedAt,
        };
      }),
      nextOffset: query.data.nextOffset,
      state: 'populated',
    };
  }

  return (
    <CustomersListView
      copy={copy}
      currentSearch={search}
      language={language}
      lifecycleError={lifecycleError}
      offset={urlState.offset}
      onToggleLifecycle={toggleLifecycle}
      pendingCustomerId={
        lifecycleMutation.isPending ? (lifecycleMutation.variables?.customerId ?? null) : null
      }
      onRetry={refetch}
      onStatusChange={(status) =>
        void navigate({
          to: buildCustomerListHref(language, search, status, 0),
        })
      }
      retrying={query.isFetching && !query.isPending}
      status={urlState.status}
      view={view}
    />
  );
};

export const CustomersListPage = () => {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    [],
  );

  return (
    <>
      <UltramodernRouteHead />
      <div className="crm:mx-auto crm:min-w-0 crm:w-full crm:max-w-5xl crm:px-4 crm:py-8 crm:sm:px-8 crm:lg:px-12">
        <QueryClientProvider client={queryClient}>
          <CustomersListFeature />
        </QueryClientProvider>
      </div>
    </>
  );
};

export default CustomersListPage;
