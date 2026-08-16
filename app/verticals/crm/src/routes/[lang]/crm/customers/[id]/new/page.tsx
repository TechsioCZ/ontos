import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link as RouterLink, useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect as EffectRuntime, Random } from 'effect';
import { useMemo, useRef, useState } from 'react';
import { createCustomer, runEffectRequest } from '../../../../../../api/crm-client.ts';
import type { Effect } from '../../../../../../api/crm-client.ts';
import { CustomerForm } from '../../../../../../features/customers/customer-form.tsx';
import type {
  CustomerFormStatus,
  CustomerFormValues,
} from '../../../../../../features/customers/customer-form.tsx';
import { UltramodernRouteHead } from '../../../../../ultramodern-route-head';

export type CustomerCreatePageRouteParams = Readonly<Partial<Record<'id', string>>>;

export interface CustomerCreatePageTarget {
  readonly writable: boolean;
}

export interface CustomerCreatePageProps {
  readonly routeParams: CustomerCreatePageRouteParams;
  readonly target: CustomerCreatePageTarget;
}

type CreateCustomerClientError = Effect.Error<ReturnType<typeof createCustomer>>;
type CreatedCustomer = Effect.Success<ReturnType<typeof createCustomer>>;

type UnavailableReason = 'backend' | 'decode' | 'transport';

export type CreateCustomerErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'conflict' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'name_invalid' }
  | { readonly reason: UnavailableReason; readonly state: 'unavailable'; readonly uncertain: true }
  | { readonly state: 'unexpected' };

const classifyHttpClientFailure = (error: {
  readonly reason: { readonly _tag: string };
}): UnavailableReason | 'unexpected' => {
  if (error.reason._tag === 'TransportError') {
    return 'transport';
  }
  if (error.reason._tag === 'DecodeError' || error.reason._tag === 'EmptyBodyError') {
    return 'decode';
  }
  return 'unexpected';
};

export const classifyCreateCustomerError = (
  error: CreateCustomerClientError,
): CreateCustomerErrorState => {
  if (error._tag === 'HttpClientError') {
    const reason = classifyHttpClientFailure(error);
    return reason === 'unexpected'
      ? { state: 'unexpected' }
      : { reason, state: 'unavailable', uncertain: true };
  }
  if (error._tag === 'SchemaError') {
    return { reason: 'decode', state: 'unavailable', uncertain: true };
  }

  switch (error._tag) {
    case 'CrmInvalidRequestProblem': {
      return { state: 'name_invalid' };
    }
    case 'CrmAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'CrmForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
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

export const customerListHref = (language: string) => `/${language}/crm/customers`;

interface CustomerCreateCopy {
  readonly back: string;
  readonly description: string;
  readonly form: {
    readonly cancel: string;
    readonly nameInvalid: string;
    readonly nameLabel: string;
    readonly nameRequired: string;
    readonly save: string;
    readonly saving: string;
  };
  readonly mutation: {
    readonly authenticationExpired: string;
    readonly conflict: string;
    readonly forbidden: string;
    readonly generic: string;
    readonly success: string;
  };
  readonly states: {
    readonly decode: string;
    readonly readOnly: string;
    readonly transport: string;
    readonly unavailable: string;
  };
  readonly title: string;
}

interface MutationFeedback {
  readonly formStatus?: CustomerFormStatus;
  readonly nameError?: string;
}

interface LogicalMutationAttempt {
  readonly idempotencyKey: string;
  readonly name: string;
  readonly uncertain: boolean;
}

const createRequestId = () =>
  Array.from({ length: 4 }, () =>
    EffectRuntime.runSync(Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)).toString(36),
  ).join('-');

const feedbackForCreateError = (
  state: CreateCustomerErrorState,
  copy: CustomerCreateCopy,
): MutationFeedback => {
  switch (state.state) {
    case 'name_invalid': {
      return { nameError: copy.form.nameInvalid };
    }
    case 'authentication_expired': {
      return {
        formStatus: { message: copy.mutation.authenticationExpired, status: 'error' },
      };
    }
    case 'forbidden': {
      return { formStatus: { message: copy.mutation.forbidden, status: 'error' } };
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
      return { formStatus: { message, status: 'error' } };
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

export const CustomerCreateFeature = ({ routeParams, target }: CustomerCreatePageProps) => {
  void routeParams;
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);
  const logicalAttemptRef = useRef<LogicalMutationAttempt | null>(null);
  const copy: CustomerCreateCopy = {
    back: t('crm.pages.customerCreate.back'),
    description: t('crm.pages.customerCreate.description'),
    form: {
      cancel: t('crm.pages.customerCreate.form.cancel'),
      nameInvalid: t('crm.pages.customerCreate.form.nameInvalid'),
      nameLabel: t('crm.pages.customerCreate.form.nameLabel'),
      nameRequired: t('crm.pages.customerCreate.form.nameRequired'),
      save: t('crm.pages.customerCreate.form.save'),
      saving: t('crm.pages.customerCreate.form.saving'),
    },
    mutation: {
      authenticationExpired: t('crm.pages.customerCreate.mutation.authenticationExpired'),
      conflict: t('crm.pages.customerCreate.mutation.conflict'),
      forbidden: t('crm.pages.customerCreate.mutation.forbidden'),
      generic: t('crm.pages.customerCreate.mutation.generic'),
      success: t('crm.pages.customerCreate.mutation.success'),
    },
    states: {
      decode: t('crm.pages.customerCreate.states.decode'),
      readOnly: t('crm.pages.customerCreate.states.readOnly'),
      transport: t('crm.pages.customerCreate.states.transport'),
      unavailable: t('crm.pages.customerCreate.states.unavailable'),
    },
    title: t('crm.pages.customerCreate.title'),
  };
  const createMutation = useMutation<
    CreatedCustomer,
    CreateCustomerClientError,
    { readonly idempotencyKey: string; readonly name: string }
  >({
    mutationFn: ({ idempotencyKey, name }) =>
      runEffectRequest(
        createCustomer(
          { name },
          {
            baseUrl: ULTRAMODERN_CRM_API_BASE_URL,
            correlationId: createRequestId(),
            idempotencyKey,
            locale: language,
          },
        ),
      ),
    retry: false,
  });
  const destination = customerListHref(language);
  const goToCustomerList = () => {
    void navigate({ to: destination });
  };

  const submit = (values: CustomerFormValues): Promise<void> => {
    if (!target.writable) {
      return Promise.resolve();
    }
    const previousAttempt = logicalAttemptRef.current;
    const idempotencyKey =
      previousAttempt?.uncertain === true && previousAttempt.name === values.name
        ? previousAttempt.idempotencyKey
        : createRequestId();
    logicalAttemptRef.current = { idempotencyKey, name: values.name, uncertain: false };
    setFeedback(null);

    // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Promise-returning form callbacks stay non-async under strict Effect diagnostics.
    return createMutation.mutateAsync({ idempotencyKey, name: values.name }).then(
      () => {
        logicalAttemptRef.current = null;
        setFeedback({
          formStatus: { message: copy.mutation.success, status: 'success' },
        });
        void navigate({ to: destination });
      },
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- The typed rejection branch maps TanStack Query failures without an async UI callback.
      (error: CreateCustomerClientError) => {
        const state = classifyCreateCustomerError(error);
        logicalAttemptRef.current =
          state.state === 'unavailable'
            ? { idempotencyKey, name: values.name, uncertain: true }
            : null;
        setFeedback(feedbackForCreateError(state, copy));
      },
    );
  };

  return (
    <section aria-labelledby="customer-create-heading" className="crm:grid crm:min-w-0 crm:gap-6">
      <Link as={RouterLink} to={destination}>
        {copy.back}
      </Link>
      <header className="crm:grid crm:gap-2">
        <h1 className="crm:text-3xl crm:font-bold" id="customer-create-heading">
          {copy.title}
        </h1>
        <p>{copy.description}</p>
      </header>
      <div
        aria-busy={createMutation.isPending}
        className="crm:bg-(--color-surface) crm:p-6 crm:sm:p-8"
      >
        <div className="crm:grid crm:gap-5">
          {target.writable ? null : (
            <output>
              <StatusText aria-live="polite" showIcon status="warning">
                {copy.states.readOnly}
              </StatusText>
            </output>
          )}
          <CustomerForm
            copy={copy.form}
            disabled={!target.writable}
            {...(feedback?.formStatus === undefined ? {} : { formStatus: feedback.formStatus })}
            initialValues={{ name: '' }}
            {...(feedback?.nameError === undefined ? {} : { nameError: feedback.nameError })}
            onCancel={goToCustomerList}
            onSubmit={submit}
            onValuesChange={() => {
              logicalAttemptRef.current = null;
              setFeedback(null);
              createMutation.reset();
            }}
            pending={createMutation.isPending}
          />
        </div>
      </div>
    </section>
  );
};

export const CustomerCreatePage = ({ routeParams, target }: CustomerCreatePageProps) => {
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
      <div className="crm:mx-auto crm:min-w-0 crm:w-full crm:max-w-3xl crm:px-4 crm:py-8 crm:sm:px-8 crm:lg:px-12">
        <QueryClientProvider client={queryClient}>
          <CustomerCreateFeature routeParams={routeParams} target={target} />
        </QueryClientProvider>
      </div>
    </>
  );
};

const StandaloneCustomerCreatePage = () => {
  const routeParams = useParams({ strict: false });

  return (
    <CustomerCreatePage
      routeParams={routeParams.id === undefined ? {} : { id: routeParams.id }}
      target={{ writable: false }}
    />
  );
};

export default StandaloneCustomerCreatePage;
