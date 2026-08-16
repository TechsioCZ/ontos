import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link as RouterLink } from '@modern-js/plugin-tanstack/runtime';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect as EffectRuntime, Random, Schema } from 'effect';
import { useMemo, useRef } from 'react';
import type { CustomerDetailResponse } from '../../../../../../shared/api.ts';
import { CrmUuidSchema } from '../../../../../../shared/apis/customer-detail.ts';
import { getCustomerDetail, runEffectRequest } from '../../../../../api/crm-client.ts';
import type { Effect } from '../../../../../api/crm-client.ts';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

type CustomerDetailPageRouteParams = Readonly<Partial<Record<'id', string>>>;

interface CustomerDetailPageProps {
  readonly routeParams: CustomerDetailPageRouteParams;
}

type CustomerDetailClientError = Effect.Error<ReturnType<typeof getCustomerDetail>>;
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

interface CustomerDetailViewProps {
  readonly backHref: string;
  readonly copy: CustomerDetailCopy;
  readonly onRetry: () => Promise<void>;
  readonly retrying: boolean;
  readonly view: CustomerDetailViewState;
}

export const decodeCustomerDetailId = (value: string | undefined): string | undefined =>
  value !== undefined && value.length <= 200 && Schema.is(CrmUuidSchema)(value) ? value : undefined;

export const customerDetailQueryKey = (customerId: string) =>
  ['crm', 'customers', 'detail', customerId] as const;

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
    case 'CustomerDetailNotFoundProblem': {
      return { state: 'not_found' };
    }
    case 'CustomerDetailUnavailableProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem': {
      return { reason: 'backend', state: 'unavailable' };
    }
    case 'CustomerDetailInternalProblem':
    case 'CustomerDetailInvalidProblem':
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

export const CustomerDetailView = ({
  backHref,
  copy,
  onRetry,
  retrying,
  view,
}: CustomerDetailViewProps) => {
  const resultsRef = useRef<HTMLDivElement>(null);
  const retry = () =>
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

const CustomerDetailQuery = ({
  backHref,
  copy,
  customerId,
  language,
}: {
  readonly backHref: string;
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
  const refetch = () => query.refetch().then(() => undefined);
  let view: CustomerDetailViewState;
  if (query.isPending) {
    view = { state: 'loading' };
  } else if (query.isError) {
    view = classifyCustomerDetailError(query.error);
  } else {
    view = { customer: toReadyModel(query.data, language), state: 'ready' };
  }

  return (
    <CustomerDetailView
      backHref={backHref}
      copy={copy}
      onRetry={refetch}
      retrying={query.isFetching && !query.isPending}
      view={view}
    />
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

export default CustomerDetailPage;
