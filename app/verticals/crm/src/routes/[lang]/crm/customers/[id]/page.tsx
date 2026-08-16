import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link as RouterLink, useParams } from '@modern-js/plugin-tanstack/runtime';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect as EffectRuntime, Random, Schema } from 'effect';
import { useMemo, useRef, useState } from 'react';
import type { ContactListResponse, CustomerDetailResponse } from '../../../../../../shared/api.ts';
import { CrmUuidSchema } from '../../../../../../shared/apis/customer-detail.ts';
import {
  getContactList,
  getCustomerDetail,
  runEffectRequest,
} from '../../../../../api/crm-client.ts';
import type { Effect } from '../../../../../api/crm-client.ts';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

type CustomerDetailPageRouteParams = Readonly<Partial<Record<'id', string>>>;

interface CustomerDetailPageProps {
  readonly routeParams: CustomerDetailPageRouteParams;
}

type CustomerDetailClientError = Effect.Error<ReturnType<typeof getCustomerDetail>>;
type ContactListClientError = Effect.Error<ReturnType<typeof getContactList>>;
type ContactListUnavailableReason = 'backend' | 'decode' | 'internal' | 'transport';
type ContactListErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'parent_not_found' }
  | { readonly reason: ContactListUnavailableReason; readonly state: 'unavailable' };
type CustomerDetailUnavailableReason = 'backend' | 'decode' | 'internal' | 'transport';
type CustomerDetailErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'not_found' }
  | { readonly reason: CustomerDetailUnavailableReason; readonly state: 'unavailable' };

interface CustomerDetailReadyModel {
  readonly createdAt: string;
  readonly createdAtIso: string;
  readonly customerId: string;
  readonly lifecycle: 'active' | 'archived';
  readonly name: string;
  readonly updatedAt: string;
  readonly updatedAtIso: string;
}

interface ContactListRowModel {
  readonly contactId: string;
  readonly email: string;
  readonly name: string;
  readonly phone: string;
}

type ContactListViewState =
  | ContactListErrorState
  | { readonly state: 'empty' }
  | { readonly state: 'loading' }
  | {
      readonly items: readonly ContactListRowModel[];
      readonly nextOffset: null | number;
      readonly state: 'populated';
    };

type CustomerDetailViewState =
  | CustomerDetailErrorState
  | { readonly state: 'loading' }
  | { readonly customer: CustomerDetailReadyModel; readonly state: 'ready' };

interface CustomerDetailCopy {
  readonly authenticationExpired: string;
  readonly back: string;
  readonly createdAt: string;
  readonly customerId: string;
  readonly decode: string;
  readonly forbidden: string;
  readonly internal: string;
  readonly loading: string;
  readonly notFound: string;
  readonly retry: string;
  readonly retrying: string;
  readonly status: string;
  readonly statusActive: string;
  readonly statusArchived: string;
  readonly title: string;
  readonly transport: string;
  readonly unavailable: string;
  readonly updatedAt: string;
}

interface ContactListCopy {
  readonly authenticationExpired: string;
  readonly decode: string;
  readonly emailColumn: string;
  readonly empty: string;
  readonly forbidden: string;
  readonly heading: string;
  readonly internal: string;
  readonly loading: string;
  readonly nameColumn: string;
  readonly next: string;
  readonly paginationLabel: string;
  readonly parentNotFound: string;
  readonly phoneColumn: string;
  readonly previous: string;
  readonly retry: string;
  readonly retrying: string;
  readonly tableCaption: string;
  readonly transport: string;
  readonly unavailable: string;
}

interface CustomerDetailViewProps {
  readonly backHref: string;
  readonly copy: CustomerDetailCopy;
  readonly onRetry: () => Promise<unknown>;
  readonly retrying: boolean;
  readonly view: CustomerDetailViewState;
}

export const decodeCustomerDetailId = (value: string | undefined): string | undefined =>
  value !== undefined && value.length <= 200 && Schema.is(CrmUuidSchema)(value) ? value : undefined;

export const customerDetailQueryKey = (customerId: string) =>
  ['crm', 'customers', 'detail', customerId] as const;

export const CONTACT_LIST_PAGE_SIZE = 25;

export const contactListQueryKey = (customerId: string, offset: number) =>
  ['crm', 'customers', customerId, 'contacts', { limit: CONTACT_LIST_PAGE_SIZE, offset }] as const;

export const classifyContactListError = (error: ContactListClientError): ContactListErrorState => {
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
    case 'ContactListAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'ContactListForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
    }
    case 'ContactListNotFoundProblem': {
      return { state: 'parent_not_found' };
    }
    case 'ContactListUnavailableProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem': {
      return { reason: 'backend', state: 'unavailable' };
    }
    case 'ContactListInternalProblem':
    case 'ContactListInvalidProblem':
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

export const classifyCustomerDetailError = (
  error: CustomerDetailClientError,
): CustomerDetailErrorState => {
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
    case 'CustomerDetailAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'CustomerDetailForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
    }
    case 'CustomerDetailInvalidProblem':
    case 'CustomerDetailNotFoundProblem': {
      return { state: 'not_found' };
    }
    case 'CustomerDetailUnavailableProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem': {
      return { reason: 'backend', state: 'unavailable' };
    }
    case 'CustomerDetailInternalProblem':
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

const LoadingCustomerDetail = ({ copy }: { readonly copy: CustomerDetailCopy }) => (
  <div aria-busy="true" className="crm:grid crm:min-w-0 crm:gap-6">
    <h1 className="crm:sr-only" id="customer-detail-heading">
      {copy.loading}
    </h1>
    <Skeleton.Text aria-hidden="true" noOfLines={1} size="xl" />
    <StatusText status="default">
      <output>{copy.loading}</output>
    </StatusText>
    <dl className="crm:grid crm:min-w-0 crm:gap-x-6 crm:gap-y-4 crm:sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
      {[copy.customerId, copy.status, copy.createdAt, copy.updatedAt].map((label) => (
        <div className="crm:contents" key={label}>
          <dt className="crm:font-medium">{label}</dt>
          <dd className="crm:min-w-0">
            <Skeleton.Text aria-hidden="true" noOfLines={1} size="sm" />
          </dd>
        </div>
      ))}
    </dl>
  </div>
);

const ReadyCustomerDetail = ({
  copy,
  customer,
}: {
  readonly copy: CustomerDetailCopy;
  readonly customer: CustomerDetailReadyModel;
}) => (
  <div className="crm:grid crm:min-w-0 crm:gap-6">
    <h1
      className="crm:break-words crm:text-3xl crm:font-bold crm:sm:text-4xl"
      id="customer-detail-heading"
    >
      {customer.name}
    </h1>
    <dl className="crm:grid crm:min-w-0 crm:gap-x-6 crm:gap-y-4 crm:sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
      <dt className="crm:font-medium">{copy.customerId}</dt>
      <dd className="crm:min-w-0 crm:break-all">{customer.customerId}</dd>
      <dt className="crm:font-medium">{copy.status}</dt>
      <dd>{customer.lifecycle === 'active' ? copy.statusActive : copy.statusArchived}</dd>
      <dt className="crm:font-medium">{copy.createdAt}</dt>
      <dd>
        <time dateTime={customer.createdAtIso}>{customer.createdAt}</time>
      </dd>
      <dt className="crm:font-medium">{copy.updatedAt}</dt>
      <dd>
        <time dateTime={customer.updatedAtIso}>{customer.updatedAt}</time>
      </dd>
    </dl>
  </div>
);

const ContactTableHeader = ({ copy }: { readonly copy: ContactListCopy }) => (
  <Table.Header>
    <Table.Row>
      <Table.ColumnHeader scope="col">{copy.nameColumn}</Table.ColumnHeader>
      <Table.ColumnHeader scope="col">{copy.emailColumn}</Table.ColumnHeader>
      <Table.ColumnHeader scope="col">{copy.phoneColumn}</Table.ColumnHeader>
    </Table.Row>
  </Table.Header>
);

const LoadingContactTable = ({ copy }: { readonly copy: ContactListCopy }) => (
  <div
    className="crm:max-w-full crm:overflow-x-auto"
    data-testid="customer-contacts-table-overflow"
  >
    <Table aria-busy="true" className="crm:min-w-xl" size="sm" variant="line">
      <Table.Caption>{copy.tableCaption}</Table.Caption>
      <ContactTableHeader copy={copy} />
      <Table.Body>
        {Array.from({ length: 3 }, (_row, rowIndex) => (
          <Table.Row key={`loading-${rowIndex}`}>
            {Array.from({ length: 3 }, (_cell, cellIndex) => (
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

const PopulatedContactTable = ({
  copy,
  items,
}: {
  readonly copy: ContactListCopy;
  readonly items: readonly ContactListRowModel[];
}) => (
  <div
    className="crm:max-w-full crm:overflow-x-auto"
    data-testid="customer-contacts-table-overflow"
  >
    <Table className="crm:min-w-xl" size="sm" variant="line">
      <Table.Caption>{copy.tableCaption}</Table.Caption>
      <ContactTableHeader copy={copy} />
      <Table.Body>
        {items.map((contact) => (
          <Table.Row key={contact.contactId}>
            <Table.Cell>{contact.name}</Table.Cell>
            <Table.Cell className="crm:whitespace-nowrap">{contact.email}</Table.Cell>
            <Table.Cell className="crm:whitespace-nowrap">{contact.phone}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  </div>
);

interface CustomerContactsProps {
  readonly copy: ContactListCopy;
  readonly offset: number;
  readonly onNext: (offset: number) => void;
  readonly onPrevious: () => void;
  readonly onRetry: () => Promise<unknown>;
  readonly retrying: boolean;
  readonly view: ContactListViewState;
}

const CustomerContacts = ({
  copy,
  offset,
  onNext,
  onPrevious,
  onRetry,
  retrying,
  view,
}: CustomerContactsProps) => {
  const resultsRef = useRef<HTMLDivElement>(null);
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
  const nextOffset = view.state === 'populated' ? view.nextOffset : null;

  return (
    <section
      aria-labelledby="customer-contacts-heading"
      className="crm:grid crm:min-w-0 crm:w-full crm:gap-4"
    >
      <h2 className="crm:text-2xl crm:font-bold" id="customer-contacts-heading">
        {copy.heading}
      </h2>
      <div
        aria-live="polite"
        data-testid="customer-contacts-results"
        ref={resultsRef}
        tabIndex={-1}
      >
        {view.state === 'loading' ? (
          <div className="crm:grid crm:gap-3">
            <StatusText status="default">
              <output>{copy.loading}</output>
            </StatusText>
            <LoadingContactTable copy={copy} />
          </div>
        ) : null}
        {view.state === 'empty' ? (
          <StatusText status="default">
            <output>{copy.empty}</output>
          </StatusText>
        ) : null}
        {view.state === 'forbidden' ? (
          <StatusText showIcon status="error">
            <output>{copy.forbidden}</output>
          </StatusText>
        ) : null}
        {view.state === 'parent_not_found' ? (
          <StatusText showIcon status="error">
            <output>{copy.parentNotFound}</output>
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
            <PopulatedContactTable copy={copy} items={view.items} />
            {offset > 0 || nextOffset !== null ? (
              <nav aria-label={copy.paginationLabel} className="crm:flex crm:flex-wrap crm:gap-3">
                {offset > 0 ? (
                  <Button
                    onClick={onPrevious}
                    size="sm"
                    theme="outlined"
                    type="button"
                    variant="secondary"
                  >
                    {copy.previous}
                  </Button>
                ) : null}
                {nextOffset === null ? null : (
                  <Button
                    onClick={() => onNext(nextOffset)}
                    size="sm"
                    theme="outlined"
                    type="button"
                    variant="primary"
                  >
                    {copy.next}
                  </Button>
                )}
              </nav>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
};

export const CustomerDetailView = ({
  backHref,
  copy,
  onRetry,
  retrying,
  view,
}: CustomerDetailViewProps) => {
  const resultsRef = useRef<HTMLDivElement>(null);
  const retry = () => {
    resultsRef.current?.focus();
    return onRetry();
  };
  const unavailableCopy =
    view.state === 'unavailable'
      ? {
          backend: copy.unavailable,
          decode: copy.decode,
          internal: copy.internal,
          transport: copy.transport,
        }[view.reason]
      : copy.unavailable;
  let failureCopy = unavailableCopy;
  if (view.state === 'authentication_expired') {
    failureCopy = copy.authenticationExpired;
  } else if (view.state === 'forbidden') {
    failureCopy = copy.forbidden;
  } else if (view.state === 'not_found') {
    failureCopy = copy.notFound;
  }
  const retryable = view.state === 'authentication_expired' || view.state === 'unavailable';

  return (
    <section
      aria-labelledby="customer-detail-heading"
      className="crm:grid crm:min-w-0 crm:w-full crm:gap-6"
    >
      <div>
        <Link as={RouterLink} to={backHref}>
          {copy.back}
        </Link>
      </div>
      <div aria-live="polite" data-testid="customer-detail-results" ref={resultsRef} tabIndex={-1}>
        {view.state === 'loading' ? <LoadingCustomerDetail copy={copy} /> : null}
        {view.state === 'ready' ? (
          <ReadyCustomerDetail copy={copy} customer={view.customer} />
        ) : null}
        {view.state !== 'loading' && view.state !== 'ready' ? (
          <div className="crm:grid crm:justify-items-start crm:gap-4">
            <h1 className="crm:text-3xl crm:font-bold crm:sm:text-4xl" id="customer-detail-heading">
              {copy.title}
            </h1>
            <StatusText showIcon status="error">
              <output>{failureCopy}</output>
            </StatusText>
            {retryable ? (
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

const toReadyModel = (
  customer: CustomerDetailResponse,
  language: string,
): CustomerDetailReadyModel => ({
  createdAt: formatCustomerTimestamp(customer.createdAt, language),
  createdAtIso: customer.createdAt,
  customerId: customer.customerId,
  lifecycle: customer.archivedAt === null ? 'active' : 'archived',
  name: customer.name,
  updatedAt: formatCustomerTimestamp(customer.updatedAt, language),
  updatedAtIso: customer.updatedAt,
});

const CustomerContactsQuery = ({
  copy,
  customerId,
  language,
}: {
  readonly copy: ContactListCopy;
  readonly customerId: string;
  readonly language: string;
}) => {
  const [offset, setOffset] = useState(0);
  const query = useQuery<ContactListResponse, ContactListClientError>({
    queryFn: () =>
      runEffectRequest(
        getContactList(
          {
            customerId,
            filter: 'active',
            limit: CONTACT_LIST_PAGE_SIZE,
            offset,
          },
          {
            baseUrl: ULTRAMODERN_CRM_API_BASE_URL,
            correlationId: createCorrelationId(),
            locale: language,
          },
        ),
      ),
    queryKey: contactListQueryKey(customerId, offset),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const refetch = () => query.refetch();
  let view: ContactListViewState;
  if (query.isPending) {
    view = { state: 'loading' };
  } else if (query.isError) {
    view = classifyContactListError(query.error);
  } else if (query.data.items.length === 0) {
    view = { state: 'empty' };
  } else {
    view = {
      items: query.data.items.map((contact) => ({
        contactId: contact.contactId,
        email: contact.email,
        name: contact.name,
        phone: contact.phone,
      })),
      nextOffset: query.data.nextOffset,
      state: 'populated',
    };
  }

  return (
    <CustomerContacts
      copy={copy}
      offset={offset}
      onNext={setOffset}
      onPrevious={() => setOffset((current) => Math.max(0, current - CONTACT_LIST_PAGE_SIZE))}
      onRetry={refetch}
      retrying={query.isFetching && !query.isPending}
      view={view}
    />
  );
};

const CustomerDetailQuery = ({
  backHref,
  contactCopy,
  copy,
  customerId,
  language,
}: {
  readonly backHref: string;
  readonly contactCopy: ContactListCopy;
  readonly copy: CustomerDetailCopy;
  readonly customerId: string;
  readonly language: string;
}) => {
  const query = useQuery<CustomerDetailResponse, CustomerDetailClientError>({
    queryFn: () =>
      runEffectRequest(
        getCustomerDetail(
          { customerId },
          {
            baseUrl: ULTRAMODERN_CRM_API_BASE_URL,
            correlationId: createCorrelationId(),
            locale: language,
          },
        ),
      ),
    queryKey: customerDetailQueryKey(customerId),
    retry: false,
  });
  const refetch = () => query.refetch();
  let view: CustomerDetailViewState;
  if (query.isPending) {
    view = { state: 'loading' };
  } else if (query.isError) {
    view = classifyCustomerDetailError(query.error);
  } else {
    view = { customer: toReadyModel(query.data, language), state: 'ready' };
  }

  return (
    <div className="crm:grid crm:min-w-0 crm:gap-10">
      <CustomerDetailView
        backHref={backHref}
        copy={copy}
        onRetry={refetch}
        retrying={query.isFetching && !query.isPending}
        view={view}
      />
      {view.state === 'ready' ? (
        <CustomerContactsQuery
          copy={contactCopy}
          customerId={customerId}
          key={customerId}
          language={language}
        />
      ) : null}
    </div>
  );
};

const CustomerDetailFeature = ({ routeParams }: CustomerDetailPageProps) => {
  const { language, t } = useModernI18n();
  const customerId = decodeCustomerDetailId(routeParams.id);
  const copy: CustomerDetailCopy = {
    authenticationExpired: t('crm.pages.customerDetail.states.authenticationExpired'),
    back: t('crm.pages.customerDetail.back'),
    createdAt: t('crm.pages.customerDetail.fields.createdAt'),
    customerId: t('crm.pages.customerDetail.fields.customerId'),
    decode: t('crm.pages.customerDetail.states.decode'),
    forbidden: t('crm.pages.customerDetail.states.forbidden'),
    internal: t('crm.pages.customerDetail.states.internal'),
    loading: t('crm.pages.customerDetail.states.loading'),
    notFound: t('crm.pages.customerDetail.states.notFound'),
    retry: t('crm.pages.customerDetail.states.retry'),
    retrying: t('crm.pages.customerDetail.states.retrying'),
    status: t('crm.pages.customerDetail.fields.status'),
    statusActive: t('crm.pages.customerDetail.lifecycle.active'),
    statusArchived: t('crm.pages.customerDetail.lifecycle.archived'),
    title: t('crm.pages.customerDetail.title'),
    transport: t('crm.pages.customerDetail.states.transport'),
    unavailable: t('crm.pages.customerDetail.states.unavailable'),
    updatedAt: t('crm.pages.customerDetail.fields.updatedAt'),
  };
  const contactCopy: ContactListCopy = {
    authenticationExpired: t('crm.pages.customerDetail.contacts.states.authenticationExpired'),
    decode: t('crm.pages.customerDetail.contacts.states.decode'),
    emailColumn: t('crm.pages.customerDetail.contacts.table.email'),
    empty: t('crm.pages.customerDetail.contacts.states.empty'),
    forbidden: t('crm.pages.customerDetail.contacts.states.forbidden'),
    heading: t('crm.pages.customerDetail.contacts.heading'),
    internal: t('crm.pages.customerDetail.contacts.states.internal'),
    loading: t('crm.pages.customerDetail.contacts.states.loading'),
    nameColumn: t('crm.pages.customerDetail.contacts.table.name'),
    next: t('crm.pages.customerDetail.contacts.pagination.next'),
    paginationLabel: t('crm.pages.customerDetail.contacts.pagination.label'),
    parentNotFound: t('crm.pages.customerDetail.contacts.states.parentNotFound'),
    phoneColumn: t('crm.pages.customerDetail.contacts.table.phone'),
    previous: t('crm.pages.customerDetail.contacts.pagination.previous'),
    retry: t('crm.pages.customerDetail.contacts.states.retry'),
    retrying: t('crm.pages.customerDetail.contacts.states.retrying'),
    tableCaption: t('crm.pages.customerDetail.contacts.table.caption'),
    transport: t('crm.pages.customerDetail.contacts.states.transport'),
    unavailable: t('crm.pages.customerDetail.contacts.states.unavailable'),
  };
  const backHref = `/${language}/crm/customers`;

  return customerId === undefined ? (
    <CustomerDetailView
      backHref={backHref}
      copy={copy}
      onRetry={() => Promise.resolve()}
      retrying={false}
      view={{ state: 'not_found' }}
    />
  ) : (
    <CustomerDetailQuery
      backHref={backHref}
      contactCopy={contactCopy}
      copy={copy}
      customerId={customerId}
      language={language}
    />
  );
};

export const CustomerDetailPage = ({ routeParams }: CustomerDetailPageProps) => {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );

  return (
    <>
      <UltramodernRouteHead />
      <div className="crm:mx-auto crm:min-w-0 crm:w-full crm:max-w-5xl crm:px-4 crm:py-8 crm:sm:px-8 crm:lg:px-12">
        <QueryClientProvider client={queryClient}>
          <CustomerDetailFeature routeParams={routeParams} />
        </QueryClientProvider>
      </div>
    </>
  );
};

const StandaloneCustomerDetailPage = () => {
  const routeParams = useParams({ strict: false });

  return (
    <CustomerDetailPage routeParams={routeParams.id === undefined ? {} : { id: routeParams.id }} />
  );
};

export default StandaloneCustomerDetailPage;
