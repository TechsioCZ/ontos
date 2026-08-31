import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link as RouterLink, useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect as EffectRuntime, Random, Schema } from 'effect';
import { useMemo, useRef, useState } from 'react';
import { ProjectsUuidSchema } from '../../../../../../../../shared/apis/customer-detail.ts';
import { createContact, runEffectRequest } from '../../../../../../../api/projects-client.ts';
import type { Effect } from '../../../../../../../api/projects-client.ts';
import { ContactForm } from '../../../../../../../features/contacts/contact-form.tsx';
import type {
  ContactFormCopy,
  ContactFormFieldErrors,
  ContactFormStatus,
  ContactFormValues,
} from '../../../../../../../features/contacts/contact-form.tsx';
import { UltramodernRouteHead } from '../../../../../../ultramodern-route-head';

export type ContactCreatePageRouteParams = Readonly<Partial<Record<'id', string>>>;

export interface ContactCreatePageTarget {
  readonly writable: boolean;
}

export interface ContactCreatePageProps {
  readonly routeParams: ContactCreatePageRouteParams;
  readonly target: ContactCreatePageTarget;
}

type CreateContactClientError = Effect.Error<ReturnType<typeof createContact>>;

type UnavailableReason = 'backend' | 'decode' | 'transport';

export type CreateContactErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'conflict' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'invalid_form' }
  | { readonly state: 'not_found' }
  | { readonly reason: UnavailableReason; readonly state: 'unavailable'; readonly uncertain: true }
  | { readonly state: 'unexpected' };

interface ContactCreateCopy {
  readonly back: string;
  readonly description: string;
  readonly form: ContactFormCopy;
  readonly mutation: {
    readonly authenticationExpired: string;
    readonly conflict: string;
    readonly forbidden: string;
    readonly generic: string;
    readonly invalidForm: string;
    readonly notFound: string;
    readonly success: string;
  };
  readonly states: {
    readonly decode: string;
    readonly invalidTarget: string;
    readonly readOnly: string;
    readonly transport: string;
    readonly unavailable: string;
  };
  readonly title: string;
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

const emptyContactValues: ContactFormValues = { email: '', name: '', phone: '' };

const createRandomIdentifier = () =>
  Array.from({ length: 4 }, () =>
    EffectRuntime.runSync(Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)).toString(36),
  ).join('-');
const createCorrelationId = () => `correlation-${createRandomIdentifier()}`;
const createIdempotencyKey = () => `idempotency-${createRandomIdentifier()}`;

const unavailableReason = (error: {
  readonly reason: { readonly _tag: string };
}): 'decode' | 'transport' | undefined => {
  if (error.reason._tag === 'TransportError') {
    return 'transport' as const;
  }
  if (error.reason._tag === 'DecodeError' || error.reason._tag === 'EmptyBodyError') {
    return 'decode' as const;
  }
  return undefined;
};

export const classifyCreateContactError = (
  error: CreateContactClientError,
): CreateContactErrorState => {
  if (error._tag === 'HttpClientError') {
    const reason = unavailableReason(error);
    return reason === undefined
      ? { state: 'unexpected' }
      : { reason, state: 'unavailable', uncertain: true };
  }
  if (error._tag === 'SchemaError') {
    return { reason: 'decode', state: 'unavailable', uncertain: true };
  }

  switch (error._tag) {
    case 'ProjectsInvalidRequestProblem': {
      return { state: 'invalid_form' };
    }
    case 'ProjectsAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'ProjectsForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
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
      return { reason: 'backend', state: 'unavailable', uncertain: true };
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

export const decodeContactCreateId = ({ id }: ContactCreatePageRouteParams): string | undefined =>
  id !== undefined && id.length <= 200 && Schema.is(ProjectsUuidSchema)(id) ? id : undefined;

export const customerDetailHref = (language: string, customerId: string) =>
  `/${language}/projects/customers/${customerId}`;

const mutationFeedback = (
  state: CreateContactErrorState,
  copy: ContactCreateCopy,
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
        backend: copy.states.unavailable,
        decode: copy.states.decode,
        transport: copy.states.transport,
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

const contactIntent = (customerId: string, values: ContactFormValues) =>
  JSON.stringify([customerId, values.name, values.email, values.phone]);

export const ContactCreateFeature = ({ routeParams, target }: ContactCreatePageProps) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const customerId = decodeContactCreateId(routeParams);
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);
  const logicalAttemptRef = useRef<LogicalMutationAttempt | null>(null);
  const copy: ContactCreateCopy = {
    back: t('projects.pages.contactCreate.back'),
    description: t('projects.pages.contactCreate.description'),
    form: {
      cancel: t('projects.pages.contactCreate.form.cancel'),
      emailInvalid: t('projects.pages.contactCreate.form.emailInvalid'),
      emailLabel: t('projects.pages.contactCreate.form.emailLabel'),
      emailRequired: t('projects.pages.contactCreate.form.emailRequired'),
      nameInvalid: t('projects.pages.contactCreate.form.nameInvalid'),
      nameLabel: t('projects.pages.contactCreate.form.nameLabel'),
      nameRequired: t('projects.pages.contactCreate.form.nameRequired'),
      phoneCountryLabel: t('projects.pages.contactCreate.form.phoneCountryLabel'),
      phoneInvalid: t('projects.pages.contactCreate.form.phoneInvalid'),
      phoneLabel: t('projects.pages.contactCreate.form.phoneLabel'),
      phonePlaceholder: t('projects.pages.contactCreate.form.phonePlaceholder'),
      phoneRequired: t('projects.pages.contactCreate.form.phoneRequired'),
      submit: t('projects.pages.contactCreate.form.submit'),
      submitting: t('projects.pages.contactCreate.form.submitting'),
    },
    mutation: {
      authenticationExpired: t('projects.pages.contactCreate.mutation.authenticationExpired'),
      conflict: t('projects.pages.contactCreate.mutation.conflict'),
      forbidden: t('projects.pages.contactCreate.mutation.forbidden'),
      generic: t('projects.pages.contactCreate.mutation.generic'),
      invalidForm: t('projects.pages.contactCreate.mutation.invalidForm'),
      notFound: t('projects.pages.contactCreate.mutation.notFound'),
      success: t('projects.pages.contactCreate.mutation.success'),
    },
    states: {
      decode: t('projects.pages.contactCreate.states.decode'),
      invalidTarget: t('projects.pages.contactCreate.states.invalidTarget'),
      readOnly: t('projects.pages.contactCreate.states.readOnly'),
      transport: t('projects.pages.contactCreate.states.transport'),
      unavailable: t('projects.pages.contactCreate.states.unavailable'),
    },
    title: t('projects.pages.contactCreate.title'),
  };
  const createMutation = useMutation<
    Effect.Success<ReturnType<typeof createContact>>,
    CreateContactClientError,
    {
      readonly customerId: string;
      readonly idempotencyKey: string;
      readonly values: ContactFormValues;
    }
  >({
    mutationFn: ({ customerId: mutationCustomerId, idempotencyKey, values }) =>
      runEffectRequest(
        createContact(
          { customerId: mutationCustomerId, ...values },
          {
            baseUrl: ULTRAMODERN_PROJECTS_API_BASE_URL,
            correlationId: createCorrelationId(),
            idempotencyKey,
            locale: language,
          },
        ),
      ),
    retry: false,
  });

  if (customerId === undefined) {
    return (
      <section
        aria-labelledby="contact-create-heading"
        className="projects:grid projects:min-w-0 projects:gap-6"
      >
        <header className="projects:grid projects:gap-2">
          <h1 id="contact-create-heading">{copy.title}</h1>
          <p>{copy.description}</p>
        </header>
        <output>
          <StatusText aria-live="polite" showIcon status="error">
            {copy.states.invalidTarget}
          </StatusText>
        </output>
      </section>
    );
  }

  const destination = customerDetailHref(language, customerId);
  const goToCustomer = () => {
    void navigate({ to: destination });
  };
  const submit = (values: ContactFormValues): Promise<void> => {
    if (!target.writable) {
      return Promise.resolve();
    }
    const intent = contactIntent(customerId, values);
    const previousAttempt = logicalAttemptRef.current;
    const idempotencyKey =
      previousAttempt?.uncertain === true && previousAttempt.intent === intent
        ? previousAttempt.idempotencyKey
        : createIdempotencyKey();
    logicalAttemptRef.current = { idempotencyKey, intent, uncertain: false };
    setFeedback(null);

    // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Promise-returning form callbacks stay non-async under strict Effect diagnostics.
    return createMutation.mutateAsync({ customerId, idempotencyKey, values }).then(
      () => {
        logicalAttemptRef.current = null;
        setFeedback({
          formStatus: { message: copy.mutation.success, status: 'success' },
        });
        void navigate({ to: destination });
      },
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- The typed rejection branch maps TanStack Query failures without an async UI callback.
      (error: CreateContactClientError) => {
        const state = classifyCreateContactError(error);
        logicalAttemptRef.current =
          state.state === 'unavailable' ? { idempotencyKey, intent, uncertain: true } : null;
        setFeedback(mutationFeedback(state, copy));
      },
    );
  };

  return (
    <section
      aria-labelledby="contact-create-heading"
      className="projects:grid projects:min-w-0 projects:gap-6"
    >
      <div>
        <Link as={RouterLink} to={destination}>
          {copy.back}
        </Link>
      </div>
      <header className="projects:grid projects:gap-2">
        <h1 id="contact-create-heading">{copy.title}</h1>
        <p>{copy.description}</p>
      </header>
      <div
        aria-busy={createMutation.isPending}
        className="projects:grid projects:min-w-0 projects:gap-5"
      >
        {target.writable ? null : (
          <output>
            <StatusText aria-live="polite" showIcon status="warning">
              {copy.states.readOnly}
            </StatusText>
          </output>
        )}
        <ContactForm
          copy={copy.form}
          disabled={!target.writable}
          {...(feedback?.fieldErrors === undefined ? {} : { fieldErrors: feedback.fieldErrors })}
          {...(feedback?.formStatus === undefined ? {} : { formStatus: feedback.formStatus })}
          initialValues={emptyContactValues}
          onCancel={goToCustomer}
          onSubmit={submit}
          onValuesChange={() => {
            logicalAttemptRef.current = null;
            setFeedback(null);
            createMutation.reset();
          }}
          pending={createMutation.isPending}
        />
      </div>
    </section>
  );
};

export const ContactCreatePage = ({ routeParams, target }: ContactCreatePageProps) => {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
      }),
    [],
  );

  return (
    <>
      <UltramodernRouteHead />
      <div className="projects:mx-auto projects:min-w-0 projects:w-full projects:max-w-3xl projects:px-4 projects:py-8 projects:sm:px-8 projects:lg:px-12">
        <QueryClientProvider client={queryClient}>
          <ContactCreateFeature routeParams={routeParams} target={target} />
        </QueryClientProvider>
      </div>
    </>
  );
};

const StandaloneContactCreatePage = () => {
  const routeParams = useParams({ strict: false });

  return (
    <ContactCreatePage
      routeParams={routeParams.id === undefined ? {} : { id: routeParams.id }}
      target={{ writable: false }}
    />
  );
};

export default StandaloneContactCreatePage;
