import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link as RouterLink, useParams } from '@modern-js/plugin-tanstack/runtime';
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect as EffectRuntime, Random, Schema } from 'effect';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import type { ContactDetailResponse } from '../../../../../../../../shared/api.ts';
import {
  ProjectsEmailSchema,
  ProjectsPhoneSchema,
} from '../../../../../../../../shared/apis/contact-detail.ts';
import { ProjectsUuidSchema } from '../../../../../../../../shared/apis/customer-detail.ts';
import { getContact, runEffectRequest } from '../../../../../../../api/projects-client.ts';
import type { Effect } from '../../../../../../../api/projects-client.ts';
import {
  consumeContactEditSuccess,
  getProjectsQueryClient,
  hasContactEditSuccess,
} from '../../../../../../../projects-query-client.ts';
import { UltramodernRouteHead } from '../../../../../../ultramodern-route-head';

type ContactDetailPageRouteParams = Readonly<Partial<Record<'id' | 'contactId', string>>>;

interface MutableContactDetailPageRouteParams {
  contactId?: string;
  id?: string;
}

interface ContactDetailPageProps {
  readonly routeParams: ContactDetailPageRouteParams;
}

type ContactDetailClientError = Effect.Error<ReturnType<typeof getContact>>;
type ContactDetailUnavailableReason = 'backend' | 'decode' | 'internal' | 'transport';
type ContactDetailErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'not_found' }
  | { readonly reason: ContactDetailUnavailableReason; readonly state: 'unavailable' };

interface ContactDetailLinks {
  emailHref?: string;
  phoneHref?: string;
}

interface ContactDetailReadyModel {
  readonly contactId: string;
  readonly createdAt: string;
  readonly createdAtIso: string;
  readonly customerId: string;
  readonly email: string;
  readonly emailHref?: string;
  readonly lifecycle: 'active' | 'archived';
  readonly name: string;
  readonly phone: string;
  readonly phoneHref?: string;
  readonly updatedAt: string;
  readonly updatedAtIso: string;
}

type ContactDetailViewState =
  | ContactDetailErrorState
  | { readonly state: 'loading' }
  | { readonly contact: ContactDetailReadyModel; readonly state: 'ready' };

interface ContactDetailCopy {
  readonly authenticationExpired: string;
  readonly back: string;
  readonly contactId: string;
  readonly createdAt: string;
  readonly customerId: string;
  readonly decode: string;
  readonly email: string;
  readonly emailLink: string;
  readonly edit: string;
  readonly forbidden: string;
  readonly internal: string;
  readonly loading: string;
  readonly notFound: string;
  readonly phone: string;
  readonly phoneLink: string;
  readonly retry: string;
  readonly retrying: string;
  readonly saved: string;
  readonly status: string;
  readonly statusActive: string;
  readonly statusArchived: string;
  readonly title: string;
  readonly transport: string;
  readonly unavailable: string;
  readonly updatedAt: string;
}

interface ContactDetailViewProps {
  readonly backHref: string | undefined;
  readonly copy: ContactDetailCopy;
  readonly editHref: string | undefined;
  readonly onRetry: () => Promise<void>;
  readonly retrying: boolean;
  readonly saved: boolean;
  readonly view: ContactDetailViewState;
}

export const decodeContactDetailId = (value: string | undefined): string | undefined =>
  value !== undefined && value.length <= 200 && Schema.is(ProjectsUuidSchema)(value)
    ? value
    : undefined;

export const contactDetailQueryKey = (customerId: string, contactId: string) =>
  ['projects', 'customers', customerId, 'contacts', 'detail', contactId] as const;

export const classifyContactDetailError = (
  error: ContactDetailClientError,
): ContactDetailErrorState => {
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
    case 'ContactDetailAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'ContactDetailForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
    }
    case 'ContactDetailInvalidProblem':
    case 'ContactDetailNotFoundProblem': {
      return { state: 'not_found' };
    }
    case 'ContactDetailUnavailableProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem': {
      return { reason: 'backend', state: 'unavailable' };
    }
    case 'ContactDetailInternalProblem':
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

const LoadingContactDetail = ({ copy }: { readonly copy: ContactDetailCopy }) => (
  <div aria-busy="true" className="projects:grid projects:min-w-0 projects:gap-6">
    <h1 className="projects:sr-only" id="contact-detail-heading">
      {copy.loading}
    </h1>
    <Skeleton.Text aria-hidden="true" noOfLines={1} size="xl" />
    <StatusText status="default">
      <output>{copy.loading}</output>
    </StatusText>
    <dl className="projects:grid projects:min-w-0 projects:gap-x-6 projects:gap-y-4 projects:sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
      {[
        copy.contactId,
        copy.customerId,
        copy.email,
        copy.phone,
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

const withSoftWrapOpportunities = (value: string) =>
  Array.from(value, (character, index) => (
    <Fragment key={`${index}-${character}`}>
      {character}
      <wbr />
    </Fragment>
  ));

const ContactValueLink = ({
  href,
  label,
  value,
}: {
  readonly href: string | undefined;
  readonly label: string;
  readonly value: string;
}) =>
  href === undefined ? (
    withSoftWrapOpportunities(value)
  ) : (
    <Link
      aria-label={label}
      className="projects:block projects:min-w-0 projects:w-full projects:max-w-full projects:break-all projects:whitespace-normal"
      href={href}
    >
      {withSoftWrapOpportunities(value)}
    </Link>
  );

const ReadyContactDetail = ({
  contact,
  copy,
  editHref,
}: {
  readonly contact: ContactDetailReadyModel;
  readonly copy: ContactDetailCopy;
  readonly editHref: string | undefined;
}) => (
  <div className="projects:grid projects:min-w-0 projects:gap-6">
    <div className="projects:flex projects:min-w-0 projects:flex-wrap projects:items-center projects:justify-between projects:gap-3">
      <h1
        aria-label={contact.name}
        className="projects:min-w-0 projects:break-words projects:text-3xl projects:font-bold projects:sm:text-4xl"
        id="contact-detail-heading"
      >
        {withSoftWrapOpportunities(contact.name)}
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
      <dt className="projects:font-medium">{copy.contactId}</dt>
      <dd className="projects:min-w-0 projects:break-all">
        {withSoftWrapOpportunities(contact.contactId)}
      </dd>
      <dt className="projects:font-medium">{copy.customerId}</dt>
      <dd className="projects:min-w-0 projects:break-all">
        {withSoftWrapOpportunities(contact.customerId)}
      </dd>
      <dt className="projects:font-medium">{copy.email}</dt>
      <dd className="projects:min-w-0 projects:break-all">
        <ContactValueLink href={contact.emailHref} label={copy.emailLink} value={contact.email} />
      </dd>
      <dt className="projects:font-medium">{copy.phone}</dt>
      <dd className="projects:min-w-0 projects:break-all">
        <ContactValueLink href={contact.phoneHref} label={copy.phoneLink} value={contact.phone} />
      </dd>
      <dt className="projects:font-medium">{copy.status}</dt>
      <dd>{contact.lifecycle === 'active' ? copy.statusActive : copy.statusArchived}</dd>
      <dt className="projects:font-medium">{copy.createdAt}</dt>
      <dd>
        <time dateTime={contact.createdAtIso}>{contact.createdAt}</time>
      </dd>
      <dt className="projects:font-medium">{copy.updatedAt}</dt>
      <dd>
        <time dateTime={contact.updatedAtIso}>{contact.updatedAt}</time>
      </dd>
    </dl>
  </div>
);

export const ContactDetailView = ({
  backHref,
  copy,
  editHref,
  onRetry,
  retrying,
  saved,
  view,
}: ContactDetailViewProps) => {
  const resultsRef = useRef<HTMLDivElement>(null);
  const retry = () =>
    // eslint-disable-next-line promise/prefer-await-to-then -- Effect diagnostics prohibit an async Promise adapter here.
    onRetry().finally(() => {
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
      aria-labelledby="contact-detail-heading"
      className="projects:grid projects:min-w-0 projects:w-full projects:gap-6"
    >
      {backHref === undefined ? null : (
        <div>
          <Link as={RouterLink} to={backHref}>
            {copy.back}
          </Link>
        </div>
      )}
      <div aria-live="polite" data-testid="contact-detail-results" ref={resultsRef} tabIndex={-1}>
        {view.state === 'ready' && saved ? (
          <StatusText align="start" showIcon status="success">
            <output>{copy.saved}</output>
          </StatusText>
        ) : null}
        {view.state === 'loading' ? <LoadingContactDetail copy={copy} /> : null}
        {view.state === 'ready' ? (
          <ReadyContactDetail contact={view.contact} copy={copy} editHref={editHref} />
        ) : null}
        {view.state !== 'loading' && view.state !== 'ready' ? (
          <div className="projects:grid projects:justify-items-start projects:gap-4">
            <h1
              className="projects:text-3xl projects:font-bold projects:sm:text-4xl"
              id="contact-detail-heading"
            >
              {copy.title}
            </h1>
            <StatusText align="start" showIcon status="error">
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
                theme="solid"
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

const formatContactTimestamp = (value: string, language: string) =>
  new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
    Date.parse(value),
  );

const createCorrelationId = () =>
  Array.from({ length: 4 }, () =>
    EffectRuntime.runSync(Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)).toString(36),
  ).join('-');

export const toContactDetailReadyModel = (
  contact: ContactDetailResponse,
  customerId: string,
  language: string,
): ContactDetailReadyModel | undefined => {
  if (contact.customerId !== customerId) {
    return undefined;
  }
  const links: ContactDetailLinks = {};
  if (Schema.is(ProjectsEmailSchema)(contact.email)) {
    links.emailHref = `mailto:${contact.email}`;
  }
  if (Schema.is(ProjectsPhoneSchema)(contact.phone)) {
    links.phoneHref = `tel:${contact.phone}`;
  }
  return {
    contactId: contact.contactId,
    createdAt: formatContactTimestamp(contact.createdAt, language),
    createdAtIso: contact.createdAt,
    customerId: contact.customerId,
    email: contact.email,
    lifecycle: contact.archivedAt === null ? 'active' : 'archived',
    name: contact.name,
    phone: contact.phone,
    updatedAt: formatContactTimestamp(contact.updatedAt, language),
    updatedAtIso: contact.updatedAt,
    ...links,
  };
};

const ContactDetailQuery = ({
  backHref,
  contactId,
  copy,
  customerId,
  language,
}: {
  readonly backHref: string;
  readonly contactId: string;
  readonly copy: ContactDetailCopy;
  readonly customerId: string;
  readonly language: string;
}) => {
  const query = useQuery<ContactDetailResponse, ContactDetailClientError>({
    queryFn: () =>
      runEffectRequest(
        getContact(
          { contactId },
          {
            baseUrl: ULTRAMODERN_PROJECTS_API_BASE_URL,
            correlationId: createCorrelationId(),
            locale: language,
          },
        ),
      ),
    queryKey: contactDetailQueryKey(customerId, contactId),
    retry: false,
    staleTime: 30_000,
  });
  const queryClient = useQueryClient();
  const saved = useMemo(
    () => hasContactEditSuccess(queryClient, customerId, contactId),
    [contactId, customerId, queryClient],
  );
  useEffect(() => {
    if (saved) {
      consumeContactEditSuccess(queryClient, customerId, contactId);
    }
  }, [contactId, customerId, queryClient, saved]);
  // oxlint-disable-next-line promise/prefer-await-to-then, no-void -- Effect's compiler rejects async UI callbacks; retain the retry promise while erasing its query result.
  const refetch = (): Promise<void> => query.refetch().then((result) => void result);
  let view: ContactDetailViewState;
  if (query.isPending) {
    view = { state: 'loading' };
  } else if (query.isError) {
    view = classifyContactDetailError(query.error);
  } else {
    const contact = toContactDetailReadyModel(query.data, customerId, language);
    view = contact === undefined ? { state: 'not_found' } : { contact, state: 'ready' };
  }

  return (
    <ContactDetailView
      backHref={backHref}
      copy={copy}
      editHref={`/${language}/projects/customers/${customerId}/contacts/${contactId}/edit`}
      onRetry={refetch}
      retrying={query.isFetching && !query.isPending}
      saved={saved}
      view={view}
    />
  );
};

const ContactDetailFeature = ({ routeParams }: ContactDetailPageProps) => {
  const { language, t } = useModernI18n();
  const customerId = decodeContactDetailId(routeParams.id);
  const contactId = decodeContactDetailId(routeParams.contactId);
  const copy: ContactDetailCopy = {
    authenticationExpired: t('projects.pages.contactDetail.states.authenticationExpired'),
    back: t('projects.pages.contactDetail.back'),
    contactId: t('projects.pages.contactDetail.fields.contactId'),
    createdAt: t('projects.pages.contactDetail.fields.createdAt'),
    customerId: t('projects.pages.contactDetail.fields.customerId'),
    decode: t('projects.pages.contactDetail.states.decode'),
    edit: t('projects.pages.contactDetail.edit'),
    email: t('projects.pages.contactDetail.fields.email'),
    emailLink: t('projects.pages.contactDetail.links.email'),
    forbidden: t('projects.pages.contactDetail.states.forbidden'),
    internal: t('projects.pages.contactDetail.states.internal'),
    loading: t('projects.pages.contactDetail.states.loading'),
    notFound: t('projects.pages.contactDetail.states.notFound'),
    phone: t('projects.pages.contactDetail.fields.phone'),
    phoneLink: t('projects.pages.contactDetail.links.phone'),
    retry: t('projects.pages.contactDetail.states.retry'),
    retrying: t('projects.pages.contactDetail.states.retrying'),
    saved: t('projects.pages.contactEdit.mutation.success'),
    status: t('projects.pages.contactDetail.fields.status'),
    statusActive: t('projects.pages.contactDetail.lifecycle.active'),
    statusArchived: t('projects.pages.contactDetail.lifecycle.archived'),
    title: t('projects.pages.contactDetail.title'),
    transport: t('projects.pages.contactDetail.states.transport'),
    unavailable: t('projects.pages.contactDetail.states.unavailable'),
    updatedAt: t('projects.pages.contactDetail.fields.updatedAt'),
  };
  const backHref =
    customerId === undefined ? undefined : `/${language}/projects/customers/${customerId}`;

  return customerId === undefined || contactId === undefined ? (
    <ContactDetailView
      backHref={backHref}
      copy={copy}
      editHref={undefined}
      onRetry={() => Promise.resolve()}
      retrying={false}
      saved={false}
      view={{ state: 'not_found' }}
    />
  ) : (
    <ContactDetailQuery
      backHref={`/${language}/projects/customers/${customerId}`}
      contactId={contactId}
      copy={copy}
      customerId={customerId}
      language={language}
    />
  );
};

export const ContactDetailPage = ({ routeParams }: ContactDetailPageProps) => {
  const queryClient = useMemo(() => getProjectsQueryClient(), []);

  return (
    <>
      <UltramodernRouteHead />
      <div className="projects:mx-auto projects:min-w-0 projects:w-full projects:max-w-5xl projects:px-4 projects:py-8 projects:sm:px-8 projects:lg:px-12">
        <QueryClientProvider client={queryClient}>
          <ContactDetailFeature routeParams={routeParams} />
        </QueryClientProvider>
      </div>
    </>
  );
};

const StandaloneContactDetailPage = () => {
  const routeParams = useParams({ strict: false });
  const contactRouteParams: MutableContactDetailPageRouteParams = {};
  if (routeParams.contactId !== undefined) {
    contactRouteParams.contactId = routeParams.contactId;
  }
  if (routeParams.id !== undefined) {
    contactRouteParams.id = routeParams.id;
  }

  return <ContactDetailPage routeParams={contactRouteParams} />;
};

export default StandaloneContactDetailPage;
