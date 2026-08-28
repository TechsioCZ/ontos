import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  Link as RouterLink,
  useLocation,
  useNavigate,
  useParams,
} from '@modern-js/plugin-tanstack/runtime';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect as EffectRuntime, Random, Schema } from 'effect';
import { useMemo, useRef } from 'react';
import type {
  Contact,
  ContactListResponse,
  CustomerDetailResponse,
} from '../../../../../../shared/api.ts';
import { ProjectsUuidSchema } from '../../../../../../shared/apis/customer-detail.ts';
import {
  archiveContact,
  getContactList,
  getCustomerDetail,
  runEffectRequest,
  unarchiveContact,
} from '../../../../../api/projects-client.ts';
import type { Effect } from '../../../../../api/projects-client.ts';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

type CustomerDetailPageRouteParams = Readonly<Partial<Record<'id', string>>>;

interface CustomerDetailPageProps {
  readonly routeParams: CustomerDetailPageRouteParams;
}

type CustomerDetailClientError = Effect.Error<ReturnType<typeof getCustomerDetail>>;
type ContactListClientError = Effect.Error<ReturnType<typeof getContactList>>;
type ContactLifecycleClientError =
  | Effect.Error<ReturnType<typeof archiveContact>>
  | Effect.Error<ReturnType<typeof unarchiveContact>>;
type ContactListUnavailableReason = 'backend' | 'decode' | 'internal' | 'transport';
export type ContactArchiveFilter = 'active' | 'archived' | 'all';
type ContactListErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'parent_not_found' }
  | { readonly reason: ContactListUnavailableReason; readonly state: 'unavailable' };
type ContactLifecycleErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'conflict' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'invalid' }
  | { readonly state: 'not_found' }
  | { readonly state: 'unavailable'; readonly uncertain: true }
  | { readonly state: 'unexpected' };
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
  readonly dic: string;
  readonly dissolvedOn: string;
  readonly dissolvedOnIso: null | string;
  readonly establishedOn: string;
  readonly establishedOnIso: null | string;
  readonly ico: string;
  readonly legalFormCode: string;
  readonly lifecycle: 'active' | 'archived';
  readonly name: string;
  readonly updatedAt: string;
  readonly updatedAtIso: string;
}

interface ContactListRowModel {
  readonly contactId: string;
  readonly detailHref: string;
  readonly editHref: string;
  readonly email: string;
  readonly lifecycle: 'active' | 'archived';
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
  readonly dic: string;
  readonly dissolvedOn: string;
  readonly edit: string;
  readonly establishedOn: string;
  readonly forbidden: string;
  readonly ico: string;
  readonly internal: string;
  readonly legalFormCode: string;
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
  readonly unavailableValue: string;
  readonly updatedAt: string;
}

interface ContactListCopy {
  readonly actionsColumn: string;
  readonly archive: string;
  readonly archiving: string;
  readonly authenticationExpired: string;
  readonly create: string;
  readonly decode: string;
  readonly emailColumn: string;
  readonly empty: string;
  readonly edit: string;
  readonly forbidden: string;
  readonly filterActive: string;
  readonly filterAll: string;
  readonly filterArchived: string;
  readonly filterLabel: string;
  readonly filterPlaceholder: string;
  readonly heading: string;
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
  readonly parentNotFound: string;
  readonly phoneColumn: string;
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
  readonly unavailable: string;
}

interface CustomerDetailViewProps {
  readonly backHref: string;
  readonly copy: CustomerDetailCopy;
  readonly editHref: string | undefined;
  readonly onRetry: () => Promise<void>;
  readonly retrying: boolean;
  readonly view: CustomerDetailViewState;
}

export const decodeCustomerDetailId = (value: string | undefined): string | undefined =>
  value !== undefined && value.length <= 200 && Schema.is(ProjectsUuidSchema)(value)
    ? value
    : undefined;

export const customerDetailQueryKey = (customerId: string) =>
  ['projects', 'customers', 'detail', customerId] as const;

export const CONTACT_LIST_PAGE_SIZE = 25;
const MAX_CONTACT_LIST_OFFSET = Number.MAX_SAFE_INTEGER - CONTACT_LIST_PAGE_SIZE;

export interface CustomerContactListUrlState {
  readonly offset: number;
  readonly status: ContactArchiveFilter;
}

export const parseCustomerContactListSearch = (search: string): CustomerContactListUrlState => {
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
    parsedOffset <= MAX_CONTACT_LIST_OFFSET
      ? parsedOffset
      : 0;

  return { offset, status };
};

export const buildCustomerContactListHref = (
  language: string,
  customerId: string,
  currentSearch: string,
  status: ContactArchiveFilter,
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
  const pathname = `/${language}/projects/customers/${encodeURIComponent(customerId)}`;
  return `${pathname}${search.length === 0 ? '' : `?${search}`}`;
};

export const contactListQueryKey = (
  customerId: string,
  status: ContactArchiveFilter,
  offset: number,
) =>
  [
    'projects',
    'customers',
    customerId,
    'contacts',
    { filter: status, limit: CONTACT_LIST_PAGE_SIZE, offset },
  ] as const;

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

export const classifyContactLifecycleError = (
  error: ContactLifecycleClientError,
): ContactLifecycleErrorState => {
  if (error._tag === 'HttpClientError' || error._tag === 'SchemaError') {
    return { state: 'unavailable', uncertain: true };
  }

  switch (error._tag) {
    case 'ProjectsAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'ProjectsForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
    }
    case 'ProjectsInvalidRequestProblem': {
      return { state: 'invalid' };
    }
    case 'ProjectsNotFoundProblem': {
      return { state: 'not_found' };
    }
    case 'ProjectsConflictProblem':
    case 'ProjectsPreconditionRequiredProblem': {
      return { state: 'conflict' };
    }
    case 'ProjectsUnavailableProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem': {
      return { state: 'unavailable', uncertain: true };
    }
    case 'ProjectsInternalProblem':
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
  <div aria-busy="true" className="projects:grid projects:min-w-0 projects:gap-6">
    <h1 className="projects:sr-only" id="customer-detail-heading">
      {copy.loading}
    </h1>
    <Skeleton.Text aria-hidden="true" noOfLines={1} size="xl" />
    <StatusText status="default">
      <output>{copy.loading}</output>
    </StatusText>
    <dl className="projects:grid projects:min-w-0 projects:gap-x-6 projects:gap-y-4 projects:sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
      {[
        copy.customerId,
        copy.ico,
        copy.dic,
        copy.legalFormCode,
        copy.establishedOn,
        copy.dissolvedOn,
        copy.status,
        copy.createdAt,
        copy.updatedAt,
      ].map((label) => (
        <div className="projects:contents" key={label}>
          <dt className="projects:font-medium">{label}</dt>
          <dd className="projects:min-w-0">
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
  editHref,
}: {
  readonly copy: CustomerDetailCopy;
  readonly customer: CustomerDetailReadyModel;
  readonly editHref: string | undefined;
}) => (
  <div className="projects:grid projects:min-w-0 projects:gap-6">
    <div className="projects:flex projects:min-w-0 projects:flex-wrap projects:items-center projects:justify-between projects:gap-3">
      <h1
        className="projects:min-w-0 projects:break-words projects:text-3xl projects:font-bold projects:sm:text-4xl"
        id="customer-detail-heading"
      >
        {customer.name}
      </h1>
      {editHref === undefined ? null : (
        <div className="projects:ml-auto projects:shrink-0">
          <LinkButton
            as={RouterLink}
            href={editHref}
            size="sm"
            theme="solid"
            to={editHref}
            variant="primary"
          >
            {copy.edit}
          </LinkButton>
        </div>
      )}
    </div>
    <dl className="projects:grid projects:min-w-0 projects:gap-x-6 projects:gap-y-4 projects:sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
      <dt className="projects:font-medium">{copy.customerId}</dt>
      <dd className="projects:min-w-0 projects:break-all">{customer.customerId}</dd>
      <dt className="projects:font-medium">{copy.ico}</dt>
      <dd className="projects:min-w-0 projects:break-all">
        <code>{customer.ico}</code>
      </dd>
      <dt className="projects:font-medium">{copy.dic}</dt>
      <dd className="projects:min-w-0 projects:break-all">
        <code>{customer.dic}</code>
      </dd>
      <dt className="projects:font-medium">{copy.legalFormCode}</dt>
      <dd className="projects:min-w-0 projects:break-all">
        <code>{customer.legalFormCode}</code>
      </dd>
      <dt className="projects:font-medium">{copy.establishedOn}</dt>
      <dd className="projects:min-w-0">
        {customer.establishedOnIso === null ? (
          customer.establishedOn
        ) : (
          <time dateTime={customer.establishedOnIso}>{customer.establishedOn}</time>
        )}
      </dd>
      <dt className="projects:font-medium">{copy.dissolvedOn}</dt>
      <dd className="projects:min-w-0">
        {customer.dissolvedOnIso === null ? (
          customer.dissolvedOn
        ) : (
          <time dateTime={customer.dissolvedOnIso}>{customer.dissolvedOn}</time>
        )}
      </dd>
      <dt className="projects:font-medium">{copy.status}</dt>
      <dd>{customer.lifecycle === 'active' ? copy.statusActive : copy.statusArchived}</dd>
      <dt className="projects:font-medium">{copy.createdAt}</dt>
      <dd>
        <time dateTime={customer.createdAtIso}>{customer.createdAt}</time>
      </dd>
      <dt className="projects:font-medium">{copy.updatedAt}</dt>
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
      <Table.ColumnHeader scope="col">{copy.statusColumn}</Table.ColumnHeader>
      <Table.ColumnHeader scope="col">{copy.emailColumn}</Table.ColumnHeader>
      <Table.ColumnHeader scope="col">{copy.phoneColumn}</Table.ColumnHeader>
      <Table.ColumnHeader scope="col">
        <span className="projects:flex projects:justify-end">{copy.actionsColumn}</span>
      </Table.ColumnHeader>
    </Table.Row>
  </Table.Header>
);

const LoadingContactTable = ({ copy }: { readonly copy: ContactListCopy }) => (
  <div
    className="projects:max-w-full projects:overflow-x-auto"
    data-testid="customer-contacts-table-overflow"
  >
    <Table aria-busy="true" className="projects:min-w-xl" size="sm" variant="line">
      <Table.Caption>{copy.tableCaption}</Table.Caption>
      <ContactTableHeader copy={copy} />
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

const ContactTable = ({
  copy,
  items,
  onToggleLifecycle,
  pendingContactId,
}: {
  readonly copy: ContactListCopy;
  readonly items: readonly ContactListRowModel[];
  readonly onToggleLifecycle: (contactId: string, lifecycle: 'active' | 'archived') => void;
  readonly pendingContactId: null | string;
}) => {
  const emptyDescriptionId = items.length === 0 ? 'customer-contacts-empty-description' : undefined;

  return (
    <>
      <div
        className="projects:max-w-full projects:overflow-x-auto"
        data-testid="customer-contacts-table-overflow"
      >
        <Table
          aria-describedby={emptyDescriptionId}
          className="projects:min-w-xl"
          size="sm"
          variant="line"
        >
          <Table.Caption>{copy.tableCaption}</Table.Caption>
          <ContactTableHeader copy={copy} />
          <Table.Body>
            {items.map((contact) => (
              <Table.Row key={contact.contactId}>
                <Table.Cell>
                  <Link as={RouterLink} to={contact.detailHref}>
                    {contact.name}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant={contact.lifecycle === 'active' ? 'success' : 'outline'}>
                    {contact.lifecycle === 'active' ? copy.statusActive : copy.statusArchived}
                  </Badge>
                </Table.Cell>
                <Table.Cell className="projects:whitespace-nowrap">
                  <Link href={`mailto:${contact.email}`}>{contact.email}</Link>
                </Table.Cell>
                <Table.Cell className="projects:whitespace-nowrap">{contact.phone}</Table.Cell>
                <Table.Cell>
                  <div className="projects:flex projects:flex-wrap projects:justify-end projects:gap-2">
                    <LinkButton
                      as={RouterLink}
                      href={contact.editHref}
                      size="sm"
                      to={contact.editHref}
                      variant="primary"
                    >
                      {copy.edit}
                    </LinkButton>
                    <Button
                      disabled={pendingContactId !== null}
                      isLoading={pendingContactId === contact.contactId}
                      loadingText={
                        contact.lifecycle === 'active' ? copy.archiving : copy.unarchiving
                      }
                      onClick={() => onToggleLifecycle(contact.contactId, contact.lifecycle)}
                      size="sm"
                      theme="outlined"
                      type="button"
                      variant={contact.lifecycle === 'active' ? 'danger' : 'warning'}
                    >
                      {contact.lifecycle === 'active' ? copy.archive : copy.unarchive}
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      {emptyDescriptionId === undefined ? null : (
        <p className="projects:sr-only" id={emptyDescriptionId}>
          {copy.empty}
        </p>
      )}
    </>
  );
};

interface CustomerContactsProps {
  readonly copy: ContactListCopy;
  readonly createHref: string;
  readonly lifecycleError: null | string;
  readonly nextHref: null | string;
  readonly onRetry: () => Promise<void>;
  readonly onStatusChange: (status: ContactArchiveFilter) => void;
  readonly onToggleLifecycle: (contactId: string, lifecycle: 'active' | 'archived') => void;
  readonly pendingContactId: null | string;
  readonly previousHref: null | string;
  readonly retrying: boolean;
  readonly status: ContactArchiveFilter;
  readonly view: ContactListViewState;
}

const CustomerContacts = ({
  copy,
  createHref,
  lifecycleError,
  nextHref,
  onRetry,
  onStatusChange,
  onToggleLifecycle,
  pendingContactId,
  previousHref,
  retrying,
  status,
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
  const statusItems = [
    { label: copy.filterActive, value: 'active' },
    { label: copy.filterArchived, value: 'archived' },
    { label: copy.filterAll, value: 'all' },
  ];

  return (
    <section
      aria-labelledby="customer-contacts-heading"
      className="projects:grid projects:min-w-0 projects:w-full projects:gap-4"
    >
      <header className="projects:grid projects:gap-4 projects:sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] projects:sm:items-end">
        <div className="projects:flex projects:flex-wrap projects:items-center projects:justify-between projects:gap-3">
          <h2 className="projects:text-2xl projects:font-bold" id="customer-contacts-heading">
            {copy.heading}
          </h2>
          <LinkButton as={RouterLink} href={createHref} size="sm" to={createHref} variant="primary">
            {copy.create}
          </LinkButton>
        </div>
        <Select
          items={statusItems}
          name="contact-status"
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
      </header>
      <div
        aria-live="polite"
        data-testid="customer-contacts-results"
        ref={resultsRef}
        tabIndex={-1}
      >
        {view.state === 'loading' ? (
          <div className="projects:grid projects:gap-3">
            <StatusText status="default">
              <output>{copy.loading}</output>
            </StatusText>
            <LoadingContactTable copy={copy} />
          </div>
        ) : null}
        {lifecycleError === null ? null : (
          <StatusText showIcon status="error">
            <output>{lifecycleError}</output>
          </StatusText>
        )}
        {view.state === 'empty' ? (
          <ContactTable
            copy={copy}
            items={[]}
            onToggleLifecycle={onToggleLifecycle}
            pendingContactId={pendingContactId}
          />
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
          <div className="projects:grid projects:justify-items-start projects:gap-3">
            <StatusText showIcon status="error">
              <output>{copy.authenticationExpired}</output>
            </StatusText>
            <Button
              disabled={retrying}
              isLoading={retrying}
              loadingText={copy.retrying}
              onClick={() => {
                void retry();
              }}
              size="sm"
              type="button"
              variant="primary"
            >
              {copy.retry}
            </Button>
          </div>
        ) : null}
        {view.state === 'unavailable' ? (
          <div className="projects:grid projects:justify-items-start projects:gap-3">
            <StatusText showIcon status="error">
              <output>{unavailableCopy}</output>
            </StatusText>
            <Button
              disabled={retrying}
              isLoading={retrying}
              loadingText={copy.retrying}
              onClick={() => {
                void retry();
              }}
              size="sm"
              type="button"
              variant="primary"
            >
              {copy.retry}
            </Button>
          </div>
        ) : null}
        {view.state === 'populated' ? (
          <div className="projects:grid projects:gap-4">
            <ContactTable
              copy={copy}
              items={view.items}
              onToggleLifecycle={onToggleLifecycle}
              pendingContactId={pendingContactId}
            />
            {previousHref !== null || nextHref !== null ? (
              <nav
                aria-label={copy.paginationLabel}
                className="projects:flex projects:flex-wrap projects:gap-3"
              >
                {previousHref === null ? null : (
                  <LinkButton
                    as={RouterLink}
                    href={previousHref}
                    size="sm"
                    theme="outlined"
                    to={previousHref}
                    variant="secondary"
                  >
                    {copy.previous}
                  </LinkButton>
                )}
                {nextHref === null ? null : (
                  <LinkButton
                    as={RouterLink}
                    href={nextHref}
                    size="sm"
                    theme="outlined"
                    to={nextHref}
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

export const CustomerDetailView = ({
  backHref,
  copy,
  editHref,
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
      className="projects:grid projects:min-w-0 projects:w-full projects:gap-6"
    >
      <div>
        <Link as={RouterLink} to={backHref}>
          {copy.back}
        </Link>
      </div>
      <div aria-live="polite" data-testid="customer-detail-results" ref={resultsRef} tabIndex={-1}>
        {view.state === 'loading' ? <LoadingCustomerDetail copy={copy} /> : null}
        {view.state === 'ready' ? (
          <ReadyCustomerDetail copy={copy} customer={view.customer} editHref={editHref} />
        ) : null}
        {view.state !== 'loading' && view.state !== 'ready' ? (
          <div className="projects:grid projects:justify-items-start projects:gap-4">
            <h1
              className="projects:text-3xl projects:font-bold projects:sm:text-4xl"
              id="customer-detail-heading"
            >
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
                onClick={() => {
                  void retry();
                }}
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

export const formatCustomerDateOnly = (value: string, language: string) =>
  new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    Date.parse(`${value}T00:00:00.000Z`),
  );

const createCorrelationId = () =>
  Array.from({ length: 4 }, () =>
    EffectRuntime.runSync(Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)).toString(36),
  ).join('-');

const toReadyModel = (
  customer: CustomerDetailResponse,
  language: string,
  unavailableValue: string,
): CustomerDetailReadyModel => ({
  createdAt: formatCustomerTimestamp(customer.createdAt, language),
  createdAtIso: customer.createdAt,
  customerId: customer.customerId,
  dic: customer.dic ?? unavailableValue,
  dissolvedOn:
    customer.dissolvedOn === null
      ? unavailableValue
      : formatCustomerDateOnly(customer.dissolvedOn, language),
  dissolvedOnIso: customer.dissolvedOn,
  establishedOn:
    customer.establishedOn === null
      ? unavailableValue
      : formatCustomerDateOnly(customer.establishedOn, language),
  establishedOnIso: customer.establishedOn,
  ico: customer.ico ?? unavailableValue,
  legalFormCode: customer.legalFormCode ?? unavailableValue,
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
  const queryClient = useQueryClient();
  const search = useLocation({ select: (location) => location.searchStr });
  const navigate = useNavigate();
  const urlState = parseCustomerContactListSearch(search);
  const query = useQuery<ContactListResponse, ContactListClientError>({
    queryFn: () =>
      runEffectRequest(
        getContactList(
          {
            customerId,
            filter: urlState.status,
            limit: CONTACT_LIST_PAGE_SIZE,
            offset: urlState.offset,
          },
          {
            baseUrl: ULTRAMODERN_PROJECTS_API_BASE_URL,
            correlationId: createCorrelationId(),
            locale: language,
          },
        ),
      ),
    queryKey: contactListQueryKey(customerId, urlState.status, urlState.offset),
    retry: false,
  });
  const lifecycleMutation = useMutation<
    Contact,
    ContactLifecycleClientError,
    {
      readonly contactId: string;
      readonly idempotencyKey: string;
      readonly operation: 'archive' | 'unarchive';
    }
  >({
    mutationFn: ({ contactId, idempotencyKey, operation }) =>
      runEffectRequest(
        (operation === 'archive' ? archiveContact : unarchiveContact)(
          { contactId },
          {
            baseUrl: ULTRAMODERN_PROJECTS_API_BASE_URL,
            correlationId: createCorrelationId(),
            idempotencyKey,
            locale: language,
          },
        ),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: contactListQueryKey(customerId, urlState.status, urlState.offset),
      }),
    retry: false,
  });
  const lifecycleAttemptRef = useRef<{
    readonly contactId: string;
    readonly idempotencyKey: string;
    readonly operation: 'archive' | 'unarchive';
    readonly uncertain: boolean;
  } | null>(null);
  // oxlint-disable-next-line promise/prefer-await-to-then, no-void -- Effect's compiler rejects async UI callbacks; retain the retry promise while erasing its query result.
  const refetch = (): Promise<void> => query.refetch().then((result) => void result);
  const toggleLifecycle = (contactId: string, lifecycle: 'active' | 'archived') => {
    const operation = lifecycle === 'active' ? 'archive' : 'unarchive';
    const previousAttempt = lifecycleAttemptRef.current;
    const idempotencyKey =
      previousAttempt?.uncertain === true &&
      previousAttempt.contactId === contactId &&
      previousAttempt.operation === operation
        ? previousAttempt.idempotencyKey
        : createCorrelationId();
    lifecycleAttemptRef.current = { contactId, idempotencyKey, operation, uncertain: false };

    lifecycleMutation.mutate(
      { contactId, idempotencyKey, operation },
      {
        onError: (error) => {
          const state = classifyContactLifecycleError(error);
          lifecycleAttemptRef.current =
            state.state === 'unavailable'
              ? { contactId, idempotencyKey, operation, uncertain: true }
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
      ? classifyContactLifecycleError(lifecycleMutation.error)
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
  let view: ContactListViewState;
  if (query.isPending) {
    view = { state: 'loading' };
  } else if (query.isError) {
    view = classifyContactListError(query.error);
  } else if (query.data.items.length === 0) {
    view = { state: 'empty' };
  } else {
    view = {
      items: query.data.items.map((contact) => {
        const detailHref = `/${language}/projects/customers/${encodeURIComponent(customerId)}/contacts/${encodeURIComponent(contact.contactId)}`;
        return {
          contactId: contact.contactId,
          detailHref,
          editHref: `${detailHref}/edit`,
          email: contact.email,
          lifecycle: contact.archivedAt === null ? 'active' : 'archived',
          name: contact.name,
          phone: contact.phone,
        };
      }),
      nextOffset: query.data.nextOffset,
      state: 'populated',
    };
  }

  return (
    <CustomerContacts
      copy={copy}
      createHref={`/${language}/projects/customers/${encodeURIComponent(customerId)}/contacts/new`}
      lifecycleError={lifecycleError}
      nextHref={
        view.state === 'populated' && view.nextOffset !== null
          ? buildCustomerContactListHref(
              language,
              customerId,
              search,
              urlState.status,
              view.nextOffset,
            )
          : null
      }
      onRetry={refetch}
      onStatusChange={(nextStatus) => {
        void navigate({
          to: buildCustomerContactListHref(language, customerId, search, nextStatus, 0),
        });
      }}
      onToggleLifecycle={toggleLifecycle}
      pendingContactId={
        lifecycleMutation.isPending ? (lifecycleMutation.variables?.contactId ?? null) : null
      }
      previousHref={
        urlState.offset > 0
          ? buildCustomerContactListHref(
              language,
              customerId,
              search,
              urlState.status,
              Math.max(0, urlState.offset - CONTACT_LIST_PAGE_SIZE),
            )
          : null
      }
      retrying={query.isFetching && !query.isPending}
      status={urlState.status}
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
            baseUrl: ULTRAMODERN_PROJECTS_API_BASE_URL,
            correlationId: createCorrelationId(),
            locale: language,
          },
        ),
      ),
    queryKey: customerDetailQueryKey(customerId),
    retry: false,
  });
  // oxlint-disable-next-line promise/prefer-await-to-then, no-void -- Effect's compiler rejects async UI callbacks; retain the retry promise while erasing its query result.
  const refetch = (): Promise<void> => query.refetch().then((result) => void result);
  let view: CustomerDetailViewState;
  if (query.isPending) {
    view = { state: 'loading' };
  } else if (query.isError) {
    view = classifyCustomerDetailError(query.error);
  } else {
    view = { customer: toReadyModel(query.data, language, copy.unavailableValue), state: 'ready' };
  }

  return (
    <div className="projects:grid projects:min-w-0 projects:gap-10">
      <CustomerDetailView
        backHref={backHref}
        copy={copy}
        editHref={`/${language}/projects/customers/${customerId}/edit`}
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
    authenticationExpired: t('projects.pages.customerDetail.states.authenticationExpired'),
    back: t('projects.pages.customerDetail.back'),
    createdAt: t('projects.pages.customerDetail.fields.createdAt'),
    customerId: t('projects.pages.customerDetail.fields.customerId'),
    decode: t('projects.pages.customerDetail.states.decode'),
    dic: t('projects.pages.customerDetail.fields.dic'),
    dissolvedOn: t('projects.pages.customerDetail.fields.dissolvedOn'),
    edit: t('projects.pages.customerDetail.edit'),
    establishedOn: t('projects.pages.customerDetail.fields.establishedOn'),
    forbidden: t('projects.pages.customerDetail.states.forbidden'),
    ico: t('projects.pages.customerDetail.fields.ico'),
    internal: t('projects.pages.customerDetail.states.internal'),
    legalFormCode: t('projects.pages.customerDetail.fields.legalFormCode'),
    loading: t('projects.pages.customerDetail.states.loading'),
    notFound: t('projects.pages.customerDetail.states.notFound'),
    retry: t('projects.pages.customerDetail.states.retry'),
    retrying: t('projects.pages.customerDetail.states.retrying'),
    status: t('projects.pages.customerDetail.fields.status'),
    statusActive: t('projects.pages.customerDetail.lifecycle.active'),
    statusArchived: t('projects.pages.customerDetail.lifecycle.archived'),
    title: t('projects.pages.customerDetail.title'),
    transport: t('projects.pages.customerDetail.states.transport'),
    unavailable: t('projects.pages.customerDetail.states.unavailable'),
    unavailableValue: t('projects.pages.customerDetail.fields.unavailable'),
    updatedAt: t('projects.pages.customerDetail.fields.updatedAt'),
  };
  const contactCopy: ContactListCopy = {
    actionsColumn: t('projects.pages.customerDetail.contacts.table.actions'),
    archive: t('projects.pages.customerDetail.contacts.table.archive'),
    archiving: t('projects.pages.customerDetail.contacts.table.archiving'),
    authenticationExpired: t('projects.pages.customerDetail.contacts.states.authenticationExpired'),
    create: t('projects.pages.contactCreate.title'),
    decode: t('projects.pages.customerDetail.contacts.states.decode'),
    edit: t('projects.pages.customerDetail.contacts.table.edit'),
    emailColumn: t('projects.pages.customerDetail.contacts.table.email'),
    empty: t('projects.pages.customerDetail.contacts.states.empty'),
    filterActive: t('projects.pages.customerDetail.contacts.filter.active'),
    filterAll: t('projects.pages.customerDetail.contacts.filter.all'),
    filterArchived: t('projects.pages.customerDetail.contacts.filter.archived'),
    filterLabel: t('projects.pages.customerDetail.contacts.filter.label'),
    filterPlaceholder: t('projects.pages.customerDetail.contacts.filter.placeholder'),
    forbidden: t('projects.pages.customerDetail.contacts.states.forbidden'),
    heading: t('projects.pages.customerDetail.contacts.heading'),
    internal: t('projects.pages.customerDetail.contacts.states.internal'),
    lifecycleAuthenticationExpired: t(
      'projects.pages.customerDetail.contacts.lifecycle.authenticationExpired',
    ),
    lifecycleConflict: t('projects.pages.customerDetail.contacts.lifecycle.conflict'),
    lifecycleForbidden: t('projects.pages.customerDetail.contacts.lifecycle.forbidden'),
    lifecycleInvalid: t('projects.pages.customerDetail.contacts.lifecycle.invalid'),
    lifecycleNotFound: t('projects.pages.customerDetail.contacts.lifecycle.notFound'),
    lifecycleUnavailable: t('projects.pages.customerDetail.contacts.lifecycle.unavailable'),
    lifecycleUnexpected: t('projects.pages.customerDetail.contacts.lifecycle.unexpected'),
    loading: t('projects.pages.customerDetail.contacts.states.loading'),
    nameColumn: t('projects.pages.customerDetail.contacts.table.name'),
    next: t('projects.pages.customerDetail.contacts.pagination.next'),
    paginationLabel: t('projects.pages.customerDetail.contacts.pagination.label'),
    parentNotFound: t('projects.pages.customerDetail.contacts.states.parentNotFound'),
    phoneColumn: t('projects.pages.customerDetail.contacts.table.phone'),
    previous: t('projects.pages.customerDetail.contacts.pagination.previous'),
    retry: t('projects.pages.customerDetail.contacts.states.retry'),
    retrying: t('projects.pages.customerDetail.contacts.states.retrying'),
    statusActive: t('projects.pages.customerDetail.contacts.status.active'),
    statusArchived: t('projects.pages.customerDetail.contacts.status.archived'),
    statusColumn: t('projects.pages.customerDetail.contacts.table.status'),
    tableCaption: t('projects.pages.customerDetail.contacts.table.caption'),
    transport: t('projects.pages.customerDetail.contacts.states.transport'),
    unarchive: t('projects.pages.customerDetail.contacts.table.unarchive'),
    unarchiving: t('projects.pages.customerDetail.contacts.table.unarchiving'),
    unavailable: t('projects.pages.customerDetail.contacts.states.unavailable'),
  };
  const backHref = `/${language}/projects/customers`;

  return customerId === undefined ? (
    <CustomerDetailView
      backHref={backHref}
      copy={copy}
      editHref={undefined}
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
      <div className="projects:mx-auto projects:min-w-0 projects:w-full projects:max-w-5xl projects:px-4 projects:py-8 projects:sm:px-8 projects:lg:px-12">
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
