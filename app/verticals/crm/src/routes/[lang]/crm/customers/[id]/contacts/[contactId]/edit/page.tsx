import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  Link as RouterLink,
  useNavigate,
  useParams,
  useRouter,
} from '@modern-js/plugin-tanstack/runtime';
import {
  QueryClientProvider,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect as EffectRuntime, Random, Schema } from 'effect';
import { useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { CrmUuidSchema } from '../../../../../../../../../shared/apis/customer-detail.ts';
import {
  editContact,
  getContact,
  runEffectRequest,
} from '../../../../../../../../api/crm-client.ts';
import type { Effect } from '../../../../../../../../api/crm-client.ts';
import { ContactForm } from '../../../../../../../../features/contacts/contact-form.tsx';
import type {
  ContactFormCopy,
  ContactFormFieldErrors,
  ContactFormStatus,
  ContactFormValues,
} from '../../../../../../../../features/contacts/contact-form.tsx';
import {
  getCrmQueryClient,
  markContactEditSuccess,
} from '../../../../../../../../crm-query-client.ts';
import { UltramodernRouteHead } from '../../../../../../../ultramodern-route-head';

export type ContactEditPageRouteParams = Readonly<Partial<Record<'id' | 'contactId', string>>>;

interface MutableContactEditPageRouteParams {
  contactId?: string;
  id?: string;
}

export interface ContactEditPageTarget {
  readonly writable: boolean;
}

export interface ContactEditPageProps {
  readonly routeParams: ContactEditPageRouteParams;
  readonly target: ContactEditPageTarget;
}

type Contact = Effect.Success<ReturnType<typeof getContact>>;
type ContactDetailClientError = Effect.Error<ReturnType<typeof getContact>>;
type EditContactClientError = Effect.Error<ReturnType<typeof editContact>>;
type UnavailableReason = 'backend' | 'decode' | 'internal' | 'transport';

export type ContactEditDetailErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'not_found' }
  | { readonly reason: UnavailableReason; readonly state: 'unavailable' };

export type EditContactErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'conflict' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'invalid_form' }
  | { readonly state: 'not_found' }
  | {
      readonly reason: Exclude<UnavailableReason, 'internal'>;
      readonly state: 'unavailable';
      readonly uncertain: true;
    }
  | { readonly state: 'unexpected' };

interface ContactEditCopy {
  readonly back: string;
  readonly description: string;
  readonly form: ContactFormCopy;
  readonly mutation: {
    readonly authenticationExpired: string;
    readonly conflict: string;
    readonly decode: string;
    readonly forbidden: string;
    readonly generic: string;
    readonly invalidForm: string;
    readonly notFound: string;
    readonly success: string;
    readonly transport: string;
    readonly unavailable: string;
  };
  readonly states: {
    readonly authenticationExpired: string;
    readonly decode: string;
    readonly forbidden: string;
    readonly generic: string;
    readonly invalidTarget: string;
    readonly loading: string;
    readonly notFound: string;
    readonly readOnly: string;
    readonly retry: string;
    readonly retrying: string;
    readonly transport: string;
    readonly unavailable: string;
  };
  readonly title: string;
}

interface DecodedContactEditRoute {
  readonly contactId: string;
  readonly customerId: string;
}

interface MutationFeedback {
  readonly fieldErrors?: ContactFormFieldErrors;
  readonly formStatus?: ContactFormStatus;
}

interface LogicalMutationAttempt {
  readonly idempotencyKey: string;
  readonly intent: string;
  readonly uncertain: boolean;
}

const createRandomIdentifier = () =>
  Array.from({ length: 4 }, () =>
    EffectRuntime.runSync(Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)).toString(36),
  ).join('-');
const createCorrelationId = () => `correlation-${createRandomIdentifier()}`;
const createIdempotencyKey = () => `idempotency-${createRandomIdentifier()}`;

const classifyHttpClientFailure = (error: {
  readonly reason: { readonly _tag: string };
}): UnavailableReason => {
  if (error.reason._tag === 'TransportError') {
    return 'transport';
  }
  if (error.reason._tag === 'DecodeError' || error.reason._tag === 'EmptyBodyError') {
    return 'decode';
  }
  return 'internal';
};

export const classifyContactEditDetailError = (
  error: ContactDetailClientError,
): ContactEditDetailErrorState => {
  if (error._tag === 'HttpClientError') {
    return { reason: classifyHttpClientFailure(error), state: 'unavailable' };
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

export const isRetryableContactEditDetailError = (error: ContactDetailClientError) => {
  const state = classifyContactEditDetailError(error);
  return state.state === 'unavailable' && state.reason !== 'internal';
};

export const classifyEditContactError = (error: EditContactClientError): EditContactErrorState => {
  if (error._tag === 'HttpClientError') {
    const reason = classifyHttpClientFailure(error);
    return reason === 'internal'
      ? { state: 'unexpected' }
      : { reason, state: 'unavailable', uncertain: true };
  }
  if (error._tag === 'SchemaError') {
    return { reason: 'decode', state: 'unavailable', uncertain: true };
  }

  switch (error._tag) {
    case 'CrmInvalidRequestProblem': {
      return { state: 'invalid_form' };
    }
    case 'CrmAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'CrmForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
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
      return { reason: 'backend', state: 'unavailable', uncertain: true };
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

const decodeBoundedUuid = (value: string | undefined) =>
  value !== undefined && value.length <= 200 && Schema.is(CrmUuidSchema)(value) ? value : undefined;

export const decodeContactEditRoute = (
  routeParams: ContactEditPageRouteParams,
): DecodedContactEditRoute | undefined => {
  const customerId = decodeBoundedUuid(routeParams.id);
  const contactId = decodeBoundedUuid(routeParams.contactId);
  return customerId === undefined || contactId === undefined
    ? undefined
    : { contactId, customerId };
};

export const contactEditDetailQueryKey = (customerId: string, contactId: string) =>
  ['crm', 'customers', customerId, 'contacts', 'detail', contactId] as const;

export const contactDetailHref = (language: string, customerId: string, contactId: string) =>
  `/${language}/crm/customers/${customerId}/contacts/${contactId}`;

const detailErrorCopy = (state: ContactEditDetailErrorState, copy: ContactEditCopy) => {
  if (state.state === 'authentication_expired') {
    return copy.states.authenticationExpired;
  }
  if (state.state === 'forbidden') {
    return copy.states.forbidden;
  }
  if (state.state === 'not_found') {
    return copy.states.notFound;
  }
  return {
    backend: copy.states.unavailable,
    decode: copy.states.decode,
    internal: copy.states.generic,
    transport: copy.states.transport,
  }[state.reason];
};

const mutationFeedback = (
  state: EditContactErrorState,
  copy: ContactEditCopy,
): MutationFeedback => {
  switch (state.state) {
    case 'invalid_form': {
      return { formStatus: { message: copy.mutation.invalidForm, status: 'error' } };
    }
    case 'authentication_expired': {
      return {
        formStatus: { message: copy.mutation.authenticationExpired, status: 'error' },
      };
    }
    case 'forbidden': {
      return { formStatus: { message: copy.mutation.forbidden, status: 'error' } };
    }
    case 'not_found': {
      return { formStatus: { message: copy.mutation.notFound, status: 'error' } };
    }
    case 'conflict': {
      return { formStatus: { message: copy.mutation.conflict, status: 'warning' } };
    }
    case 'unavailable': {
      const message = {
        backend: copy.mutation.unavailable,
        decode: copy.mutation.decode,
        transport: copy.mutation.transport,
      }[state.reason];
      return { formStatus: { message, status: 'warning' } };
    }
    case 'unexpected': {
      return { formStatus: { message: copy.mutation.generic, status: 'error' } };
    }
    default: {
      const unexpected: never = state;
      return unexpected;
    }
  }
};

const contactIntent = (contactId: string, values: ContactFormValues) =>
  JSON.stringify([contactId, values.name, values.email, values.phone]);

export const ContactEditFeature = ({ routeParams, target }: ContactEditPageProps) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const decodedRoute = decodeContactEditRoute(routeParams);
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);
  const logicalAttemptRef = useRef<LogicalMutationAttempt | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const copy: ContactEditCopy = {
    back: t('crm.pages.contactEdit.back'),
    description: t('crm.pages.contactEdit.description'),
    form: {
      cancel: t('crm.pages.contactEdit.form.cancel'),
      emailInvalid: t('crm.pages.contactEdit.form.emailInvalid'),
      emailLabel: t('crm.pages.contactEdit.form.emailLabel'),
      emailRequired: t('crm.pages.contactEdit.form.emailRequired'),
      nameInvalid: t('crm.pages.contactEdit.form.nameInvalid'),
      nameLabel: t('crm.pages.contactEdit.form.nameLabel'),
      nameRequired: t('crm.pages.contactEdit.form.nameRequired'),
      phoneCountryLabel: t('crm.pages.contactEdit.form.phoneCountryLabel'),
      phoneInvalid: t('crm.pages.contactEdit.form.phoneInvalid'),
      phoneLabel: t('crm.pages.contactEdit.form.phoneLabel'),
      phonePlaceholder: t('crm.pages.contactEdit.form.phonePlaceholder'),
      phoneRequired: t('crm.pages.contactEdit.form.phoneRequired'),
      submit: t('crm.pages.contactEdit.form.submit'),
      submitting: t('crm.pages.contactEdit.form.submitting'),
    },
    mutation: {
      authenticationExpired: t('crm.pages.contactEdit.mutation.authenticationExpired'),
      conflict: t('crm.pages.contactEdit.mutation.conflict'),
      decode: t('crm.pages.contactEdit.mutation.decode'),
      forbidden: t('crm.pages.contactEdit.mutation.forbidden'),
      generic: t('crm.pages.contactEdit.mutation.generic'),
      invalidForm: t('crm.pages.contactEdit.mutation.invalidForm'),
      notFound: t('crm.pages.contactEdit.mutation.notFound'),
      success: t('crm.pages.contactEdit.mutation.success'),
      transport: t('crm.pages.contactEdit.mutation.transport'),
      unavailable: t('crm.pages.contactEdit.mutation.unavailable'),
    },
    states: {
      authenticationExpired: t('crm.pages.contactEdit.states.authenticationExpired'),
      decode: t('crm.pages.contactEdit.states.decode'),
      forbidden: t('crm.pages.contactEdit.states.forbidden'),
      generic: t('crm.pages.contactEdit.states.generic'),
      invalidTarget: t('crm.pages.contactEdit.states.invalidTarget'),
      loading: t('crm.pages.contactEdit.states.loading'),
      notFound: t('crm.pages.contactEdit.states.notFound'),
      readOnly: t('crm.pages.contactEdit.states.readOnly'),
      retry: t('crm.pages.contactEdit.states.retry'),
      retrying: t('crm.pages.contactEdit.states.retrying'),
      transport: t('crm.pages.contactEdit.states.transport'),
      unavailable: t('crm.pages.contactEdit.states.unavailable'),
    },
    title: t('crm.pages.contactEdit.title'),
  };
  const customerId = decodedRoute?.customerId;
  const contactId = decodedRoute?.contactId;
  const detailQuery = useQuery<Contact, ContactDetailClientError>({
    queryFn:
      contactId === undefined
        ? skipToken
        : () =>
            runEffectRequest(
              getContact(
                { contactId },
                {
                  baseUrl: ULTRAMODERN_CRM_API_BASE_URL,
                  correlationId: createCorrelationId(),
                  locale: language,
                },
              ),
            ),
    queryKey: contactEditDetailQueryKey(customerId ?? 'invalid', contactId ?? 'invalid'),
    retry: (failureCount, error) => failureCount < 1 && isRetryableContactEditDetailError(error),
    retryDelay: 250,
  });
  const editMutation = useMutation<
    Contact,
    EditContactClientError,
    {
      readonly contactId: string;
      readonly idempotencyKey: string;
      readonly values: ContactFormValues;
    }
  >({
    mutationFn: ({ contactId: mutationContactId, idempotencyKey, values }) =>
      runEffectRequest(
        editContact(
          { contactId: mutationContactId, ...values },
          {
            baseUrl: ULTRAMODERN_CRM_API_BASE_URL,
            correlationId: createCorrelationId(),
            idempotencyKey,
            locale: language,
          },
        ),
      ),
    retry: false,
  });

  if (decodedRoute === undefined) {
    return (
      <section aria-labelledby="contact-edit-heading" className="crm:grid crm:min-w-0 crm:gap-6">
        <header className="crm:grid crm:gap-2">
          <h1 id="contact-edit-heading">{copy.title}</h1>
          <p>{copy.description}</p>
        </header>
        <output>
          <StatusText align="start" aria-live="polite" showIcon status="error">
            {copy.states.invalidTarget}
          </StatusText>
        </output>
      </section>
    );
  }

  const destination = contactDetailHref(language, decodedRoute.customerId, decodedRoute.contactId);
  const onBackClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !router.history.canGoBack()
    ) {
      return;
    }

    event.preventDefault();
    router.history.back();
  };
  const goToContact = () => {
    void navigate({ to: destination });
  };
  const submit = (values: ContactFormValues): Promise<void> => {
    if (!target.writable) {
      return Promise.resolve();
    }
    const intent = contactIntent(decodedRoute.contactId, values);
    const previousAttempt = logicalAttemptRef.current;
    const idempotencyKey =
      previousAttempt?.uncertain === true && previousAttempt.intent === intent
        ? previousAttempt.idempotencyKey
        : createIdempotencyKey();
    logicalAttemptRef.current = { idempotencyKey, intent, uncertain: false };
    setFeedback(null);

    // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Promise-returning form callbacks stay non-async under strict Effect diagnostics.
    return editMutation
      .mutateAsync({ contactId: decodedRoute.contactId, idempotencyKey, values })
      .then(
        (contact) => {
          logicalAttemptRef.current = null;
          if (
            contact.contactId !== decodedRoute.contactId ||
            contact.customerId !== decodedRoute.customerId
          ) {
            setFeedback({
              formStatus: { message: copy.mutation.generic, status: 'error' },
            });
            return;
          }
          queryClient.setQueryData(
            contactEditDetailQueryKey(decodedRoute.customerId, decodedRoute.contactId),
            contact,
          );
          markContactEditSuccess(queryClient, decodedRoute.customerId, decodedRoute.contactId);
          setFeedback({
            formStatus: { message: copy.mutation.success, status: 'success' },
          });
          void navigate({ to: destination });
        },
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- The typed rejection branch maps TanStack Query failures without an async UI callback.
        (error: EditContactClientError) => {
          const state = classifyEditContactError(error);
          logicalAttemptRef.current =
            state.state === 'unavailable' ? { idempotencyKey, intent, uncertain: true } : null;
          setFeedback(mutationFeedback(state, copy));
        },
      );
  };

  let content;
  if (detailQuery.isPending) {
    content = (
      <output>
        <StatusText aria-live="polite" status="default">
          {copy.states.loading}
        </StatusText>
      </output>
    );
  } else if (detailQuery.isError) {
    const errorState = classifyContactEditDetailError(detailQuery.error);
    const canRetry =
      errorState.state === 'authentication_expired' || errorState.state === 'unavailable';
    const retry = () =>
      // oxlint-disable-next-line promise/prefer-await-to-then -- Focus restoration follows the query-library Promise without erasing the typed query state.
      detailQuery.refetch().finally(() => {
        resultsRef.current?.focus();
      });
    content = (
      <div className="crm:grid crm:justify-items-start crm:gap-3">
        <output>
          <StatusText align="start" aria-live="polite" showIcon status="error">
            {detailErrorCopy(errorState, copy)}
          </StatusText>
        </output>
        {canRetry ? (
          <Button
            disabled={detailQuery.isFetching}
            isLoading={detailQuery.isFetching}
            loadingText={copy.states.retrying}
            onClick={() => {
              void retry();
            }}
            type="button"
            variant="primary"
          >
            {copy.states.retry}
          </Button>
        ) : null}
      </div>
    );
  } else if (detailQuery.data.customerId === decodedRoute.customerId) {
    content = (
      <div className="crm:grid crm:min-w-0 crm:gap-5">
        {target.writable ? null : (
          <output>
            <StatusText align="start" aria-live="polite" showIcon status="warning">
              {copy.states.readOnly}
            </StatusText>
          </output>
        )}
        <ContactForm
          copy={copy.form}
          disabled={!target.writable}
          {...(feedback?.fieldErrors === undefined ? {} : { fieldErrors: feedback.fieldErrors })}
          {...(feedback?.formStatus === undefined ? {} : { formStatus: feedback.formStatus })}
          initialValues={{
            email: detailQuery.data.email,
            name: detailQuery.data.name,
            phone: detailQuery.data.phone,
          }}
          onCancel={goToContact}
          onSubmit={submit}
          onValuesChange={() => {
            logicalAttemptRef.current = null;
            setFeedback(null);
            editMutation.reset();
          }}
          pending={editMutation.isPending}
        />
      </div>
    );
  } else {
    content = (
      <output>
        <StatusText align="start" aria-live="polite" showIcon status="error">
          {copy.states.notFound}
        </StatusText>
      </output>
    );
  }

  return (
    <section aria-labelledby="contact-edit-heading" className="crm:grid crm:min-w-0 crm:gap-6">
      <div>
        <Link as={RouterLink} onClick={onBackClick} to={destination}>
          {copy.back}
        </Link>
      </div>
      <header className="crm:grid crm:gap-2">
        <h1 className="crm:text-3xl crm:font-bold crm:sm:text-4xl" id="contact-edit-heading">
          {copy.title}
        </h1>
        <p>{copy.description}</p>
      </header>
      <div
        aria-busy={detailQuery.isPending || editMutation.isPending}
        aria-live="polite"
        className="crm:min-w-0"
        data-testid="contact-edit-results"
        ref={resultsRef}
        tabIndex={-1}
      >
        {content}
      </div>
    </section>
  );
};

export const ContactEditPage = ({ routeParams, target }: ContactEditPageProps) => {
  const queryClient = useMemo(() => getCrmQueryClient(), []);

  return (
    <>
      <UltramodernRouteHead />
      <div className="crm:mx-auto crm:min-w-0 crm:w-full crm:max-w-3xl crm:px-4 crm:py-8 crm:sm:px-8 crm:lg:px-12">
        <QueryClientProvider client={queryClient}>
          <ContactEditFeature routeParams={routeParams} target={target} />
        </QueryClientProvider>
      </div>
    </>
  );
};

const StandaloneContactEditPage = () => {
  const routeParams = useParams({ strict: false });
  const contactRouteParams: MutableContactEditPageRouteParams = {};
  if (routeParams.contactId !== undefined) {
    contactRouteParams.contactId = routeParams.contactId;
  }
  if (routeParams.id !== undefined) {
    contactRouteParams.id = routeParams.id;
  }

  return <ContactEditPage routeParams={contactRouteParams} target={{ writable: false }} />;
};

export default StandaloneContactEditPage;
