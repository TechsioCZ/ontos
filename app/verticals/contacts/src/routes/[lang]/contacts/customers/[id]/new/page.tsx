import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link as RouterLink, useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect as EffectRuntime, Random } from 'effect';
import { useMemo, useRef, useState } from 'react';
import {
  createCustomer,
  lookupCustomerAres,
  runEffectRequest,
} from '../../../../../../api/contacts-client.ts';
import type { Effect } from '../../../../../../api/contacts-client.ts';
import type { ErrorClassificationInput } from '../../../../../../error-classification.ts';
import { CustomerAresLoader } from '../../../../../../features/customers/customer-ares-loader.tsx';
import type { CustomerAresLoaderStatus } from '../../../../../../features/customers/customer-ares-loader.tsx';
import { CustomerForm } from '../../../../../../features/customers/customer-form.tsx';
import type {
  CustomerFormFieldErrors,
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
type CustomerAresLookupClientError = Effect.Error<ReturnType<typeof lookupCustomerAres>>;
type CustomerAresLookupResult = Effect.Success<ReturnType<typeof lookupCustomerAres>>;

type UnavailableReason = 'backend' | 'decode' | 'transport';

export type CreateCustomerErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'conflict' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'name_invalid' }
  | { readonly reason: UnavailableReason; readonly state: 'unavailable'; readonly uncertain: true }
  | { readonly state: 'unexpected' };

export type CustomerAresLookupErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'invalid' }
  | { readonly state: 'not_found' }
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
  error: ErrorClassificationInput<CreateCustomerClientError>,
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
    case 'ContactsInvalidRequestProblem': {
      return { state: 'name_invalid' };
    }
    case 'ContactsAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'ContactsForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
    }
    case 'ContactsConflictProblem':
    case 'ContactsPreconditionRequiredProblem': {
      return { state: 'conflict' };
    }
    case 'ContactsUnavailableProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem': {
      return { reason: 'backend', state: 'unavailable', uncertain: true };
    }
    case 'ContactsInternalProblem':
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

export const classifyCustomerAresLookupError = (
  error: ErrorClassificationInput<CustomerAresLookupClientError>,
): CustomerAresLookupErrorState => {
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
    case 'CustomerAresLookupInvalidProblem': {
      return { state: 'invalid' };
    }
    case 'CustomerAresLookupAuthenticationProblem':
    case 'GatewayAuthenticationRequiredProblem': {
      return { state: 'authentication_expired' };
    }
    case 'CustomerAresLookupForbiddenProblem':
    case 'GatewayForbiddenProblem': {
      return { state: 'forbidden' };
    }
    case 'CustomerAresLookupNotFoundProblem': {
      return { state: 'not_found' };
    }
    case 'CustomerAresLookupUnavailableProblem':
    case 'GatewayRateLimitedProblem':
    case 'GatewayUnavailableProblem': {
      return { reason: 'backend', state: 'unavailable', uncertain: true };
    }
    case 'CustomerAresLookupInternalProblem':
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

export const customerListHref = (language: string) => `/${language}/contacts/customers`;

interface CustomerCreateCopy {
  readonly back: string;
  readonly description: string;
  readonly form: {
    readonly cancel: string;
    readonly dicHint: string;
    readonly dicInvalid: string;
    readonly dicLabel: string;
    readonly dissolvedBeforeEstablished: string;
    readonly dissolvedOnHint: string;
    readonly dissolvedOnLabel: string;
    readonly establishedOnHint: string;
    readonly establishedOnLabel: string;
    readonly icoHint: string;
    readonly icoInvalid: string;
    readonly icoLabel: string;
    readonly legalFormCodeHint: string;
    readonly legalFormCodeInvalid: string;
    readonly legalFormCodeLabel: string;
    readonly nameHint: string;
    readonly nameInvalid: string;
    readonly nameLabel: string;
    readonly nameRequired: string;
    readonly save: string;
    readonly saving: string;
  };
  readonly lookup: {
    readonly authenticationExpired: string;
    readonly decode: string;
    readonly forbidden: string;
    readonly formLabel: string;
    readonly icoInvalid: string;
    readonly icoLabel: string;
    readonly internal: string;
    readonly lookingUp: string;
    readonly lookup: string;
    readonly notFound: string;
    readonly retry: string;
    readonly retrying: string;
    readonly success: string;
    readonly transport: string;
    readonly unavailable: string;
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
  readonly fieldErrors?: CustomerFormFieldErrors;
  readonly formStatus?: CustomerFormStatus;
}

interface LookupFeedback {
  readonly retryable: boolean;
  readonly status: CustomerAresLoaderStatus;
}

interface LogicalMutationAttempt {
  readonly idempotencyKey: string;
  readonly payload: CustomerPayloadValues;
  readonly uncertain: boolean;
}

interface CustomerPayloadValues {
  readonly dic: string | null;
  readonly dissolvedOn: string | null;
  readonly establishedOn: string | null;
  readonly ico: string | null;
  readonly legalFormCode: string | null;
  readonly name: string;
}

const emptyCustomerFormValues: CustomerFormValues = {
  dic: '',
  dissolvedOn: '',
  establishedOn: '',
  ico: '',
  legalFormCode: '',
  name: '',
};

const customerPayloadValues = (values: CustomerFormValues): CustomerPayloadValues => ({
  dic: values.dic.length === 0 ? null : values.dic,
  dissolvedOn: values.dissolvedOn.length === 0 ? null : values.dissolvedOn,
  establishedOn: values.establishedOn.length === 0 ? null : values.establishedOn,
  ico: values.ico.length === 0 ? null : values.ico,
  legalFormCode: values.legalFormCode.length === 0 ? null : values.legalFormCode,
  name: values.name,
});

const sameCustomerPayload = (left: CustomerPayloadValues, right: CustomerPayloadValues) =>
  left.dic === right.dic &&
  left.dissolvedOn === right.dissolvedOn &&
  left.establishedOn === right.establishedOn &&
  left.ico === right.ico &&
  left.legalFormCode === right.legalFormCode &&
  left.name === right.name;

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
      return { fieldErrors: { name: copy.form.nameInvalid } };
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

const feedbackForLookupError = (
  state: CustomerAresLookupErrorState,
  copy: CustomerCreateCopy['lookup'],
): LookupFeedback => {
  switch (state.state) {
    case 'invalid': {
      return { retryable: false, status: { message: copy.icoInvalid, status: 'error' } };
    }
    case 'authentication_expired': {
      return {
        retryable: false,
        status: { message: copy.authenticationExpired, status: 'error' },
      };
    }
    case 'forbidden': {
      return { retryable: false, status: { message: copy.forbidden, status: 'error' } };
    }
    case 'not_found': {
      return { retryable: false, status: { message: copy.notFound, status: 'warning' } };
    }
    case 'unavailable': {
      const message = {
        backend: copy.unavailable,
        decode: copy.decode,
        transport: copy.transport,
      }[state.reason];
      return { retryable: true, status: { message, status: 'error' } };
    }
    case 'unexpected': {
      return { retryable: false, status: { message: copy.internal, status: 'error' } };
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
  const toaster = useToast();
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);
  const [formValues, setFormValues] = useState<CustomerFormValues>(emptyCustomerFormValues);
  const [lookupFeedback, setLookupFeedback] = useState<LookupFeedback | null>(null);
  const logicalAttemptRef = useRef<LogicalMutationAttempt | null>(null);
  const copy: CustomerCreateCopy = {
    back: t('contacts.pages.customerCreate.back'),
    description: t('contacts.pages.customerCreate.description'),
    form: {
      cancel: t('contacts.pages.customerCreate.form.cancel'),
      dicHint: t('contacts.pages.customerCreate.form.dicHint'),
      dicInvalid: t('contacts.pages.customerCreate.form.dicInvalid'),
      dicLabel: t('contacts.pages.customerCreate.form.dicLabel'),
      dissolvedBeforeEstablished: t(
        'contacts.pages.customerCreate.form.dissolvedBeforeEstablished',
      ),
      dissolvedOnHint: t('contacts.pages.customerCreate.form.dissolvedOnHint'),
      dissolvedOnLabel: t('contacts.pages.customerCreate.form.dissolvedOnLabel'),
      establishedOnHint: t('contacts.pages.customerCreate.form.establishedOnHint'),
      establishedOnLabel: t('contacts.pages.customerCreate.form.establishedOnLabel'),
      icoHint: t('contacts.pages.customerCreate.form.icoHint'),
      icoInvalid: t('contacts.pages.customerCreate.form.icoInvalid'),
      icoLabel: t('contacts.pages.customerCreate.form.icoLabel'),
      legalFormCodeHint: t('contacts.pages.customerCreate.form.legalFormCodeHint'),
      legalFormCodeInvalid: t('contacts.pages.customerCreate.form.legalFormCodeInvalid'),
      legalFormCodeLabel: t('contacts.pages.customerCreate.form.legalFormCodeLabel'),
      nameHint: t('contacts.pages.customerCreate.form.nameHint'),
      nameInvalid: t('contacts.pages.customerCreate.form.nameInvalid'),
      nameLabel: t('contacts.pages.customerCreate.form.nameLabel'),
      nameRequired: t('contacts.pages.customerCreate.form.nameRequired'),
      save: t('contacts.pages.customerCreate.form.save'),
      saving: t('contacts.pages.customerCreate.form.saving'),
    },
    lookup: {
      authenticationExpired: t('contacts.pages.customerCreate.lookup.authenticationExpired'),
      decode: t('contacts.pages.customerCreate.lookup.decode'),
      forbidden: t('contacts.pages.customerCreate.lookup.forbidden'),
      formLabel: t('contacts.pages.customerCreate.lookup.formLabel'),
      icoInvalid: t('contacts.pages.customerCreate.lookup.icoInvalid'),
      icoLabel: t('contacts.pages.customerCreate.lookup.icoLabel'),
      internal: t('contacts.pages.customerCreate.lookup.internal'),
      lookingUp: t('contacts.pages.customerCreate.lookup.lookingUp'),
      lookup: t('contacts.pages.customerCreate.lookup.lookup'),
      notFound: t('contacts.pages.customerCreate.lookup.notFound'),
      retry: t('contacts.pages.customerCreate.lookup.retry'),
      retrying: t('contacts.pages.customerCreate.lookup.retrying'),
      success: t('contacts.pages.customerCreate.lookup.success'),
      transport: t('contacts.pages.customerCreate.lookup.transport'),
      unavailable: t('contacts.pages.customerCreate.lookup.unavailable'),
    },
    mutation: {
      authenticationExpired: t('contacts.pages.customerCreate.mutation.authenticationExpired'),
      conflict: t('contacts.pages.customerCreate.mutation.conflict'),
      forbidden: t('contacts.pages.customerCreate.mutation.forbidden'),
      generic: t('contacts.pages.customerCreate.mutation.generic'),
      success: t('contacts.pages.customerCreate.mutation.success'),
    },
    states: {
      decode: t('contacts.pages.customerCreate.states.decode'),
      readOnly: t('contacts.pages.customerCreate.states.readOnly'),
      transport: t('contacts.pages.customerCreate.states.transport'),
      unavailable: t('contacts.pages.customerCreate.states.unavailable'),
    },
    title: t('contacts.pages.customerCreate.title'),
  };
  const createMutation = useMutation<
    CreatedCustomer,
    CreateCustomerClientError,
    { readonly idempotencyKey: string; readonly payload: CustomerPayloadValues }
  >({
    mutationFn: ({ idempotencyKey, payload }) =>
      runEffectRequest(
        createCustomer(payload, {
          baseUrl: ULTRAMODERN_CONTACTS_API_BASE_URL,
          correlationId: createRequestId(),
          idempotencyKey,
          locale: language,
        }),
      ),
    retry: false,
  });
  const lookupMutation = useMutation<
    CustomerAresLookupResult,
    CustomerAresLookupClientError,
    { readonly ico: string }
  >({
    mutationFn: ({ ico }) =>
      runEffectRequest(
        lookupCustomerAres(
          { ico },
          {
            baseUrl: ULTRAMODERN_CONTACTS_API_BASE_URL,
            correlationId: createRequestId(),
          },
        ),
      ),
    retry: (failureCount, error) =>
      failureCount < 1 && classifyCustomerAresLookupError(error).state === 'unavailable',
    retryDelay: 100,
  });
  const destination = customerListHref(language);
  const goToCustomerList = () => {
    void navigate({ to: destination });
  };

  const lookup = (ico: string): Promise<void> => {
    setLookupFeedback(null);

    return lookupMutation.mutateAsync({ ico }).then(
      (result) => {
        setFormValues((current) => ({
          dic: result.dic ?? current.dic,
          dissolvedOn: result.dissolvedOn ?? current.dissolvedOn,
          establishedOn: result.establishedOn ?? current.establishedOn,
          ico: result.ico,
          legalFormCode: result.legalFormCode ?? current.legalFormCode,
          name: result.name,
        }));
        logicalAttemptRef.current = null;
        setFeedback(null);
        createMutation.reset();
        setLookupFeedback({
          retryable: false,
          status: { message: copy.lookup.success, status: 'success' },
        });
      },
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- The typed rejection branch maps TanStack Query failures without an async UI callback.
      (error: CustomerAresLookupClientError) => {
        setLookupFeedback(
          feedbackForLookupError(classifyCustomerAresLookupError(error), copy.lookup),
        );
      },
    );
  };

  const submit = (submittedValues: CustomerFormValues): Promise<void> => {
    if (!target.writable || lookupMutation.isPending) {
      return Promise.resolve();
    }
    const values = customerPayloadValues(submittedValues);
    const previousAttempt = logicalAttemptRef.current;
    const idempotencyKey =
      previousAttempt?.uncertain === true && sameCustomerPayload(previousAttempt.payload, values)
        ? previousAttempt.idempotencyKey
        : createRequestId();
    logicalAttemptRef.current = { idempotencyKey, payload: values, uncertain: false };
    setFeedback(null);

    return createMutation.mutateAsync({ idempotencyKey, payload: values }).then(
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
        if (state.state === 'forbidden') {
          toaster.create({ title: copy.mutation.forbidden, type: 'error' });
        }
        logicalAttemptRef.current =
          state.state === 'unavailable'
            ? { idempotencyKey, payload: values, uncertain: true }
            : null;
        setFeedback(feedbackForCreateError(state, copy));
      },
    );
  };

  return (
    <section
      aria-labelledby="customer-create-heading"
      className="contacts:grid contacts:min-w-0 contacts:gap-6"
    >
      <Link as={RouterLink} to={destination}>
        {copy.back}
      </Link>
      <header className="contacts:grid contacts:gap-2">
        <h1 className="contacts:text-3xl contacts:font-bold" id="customer-create-heading">
          {copy.title}
        </h1>
        <p>{copy.description}</p>
      </header>
      <div
        aria-busy={createMutation.isPending || lookupMutation.isPending}
        className="contacts:bg-(--color-surface) contacts:p-6 contacts:sm:p-8"
      >
        <div className="contacts:grid contacts:gap-5">
          {target.writable ? null : (
            <output>
              <StatusText aria-live="polite" showIcon status="warning">
                {copy.states.readOnly}
              </StatusText>
            </output>
          )}
          <CustomerAresLoader
            copy={{
              formLabel: copy.lookup.formLabel,
              icoInvalid: copy.lookup.icoInvalid,
              icoLabel: copy.lookup.icoLabel,
              lookingUp:
                lookupFeedback?.retryable === true ? copy.lookup.retrying : copy.lookup.lookingUp,
              lookup: lookupFeedback?.retryable === true ? copy.lookup.retry : copy.lookup.lookup,
            }}
            disabled={createMutation.isPending}
            onLookup={lookup}
            pending={lookupMutation.isPending}
            {...(lookupFeedback === null ? {} : { status: lookupFeedback.status })}
          />
          <CustomerForm
            copy={copy.form}
            disabled={!target.writable || lookupMutation.isPending}
            {...(feedback?.fieldErrors === undefined ? {} : { fieldErrors: feedback.fieldErrors })}
            {...(feedback?.formStatus === undefined ? {} : { formStatus: feedback.formStatus })}
            onCancel={goToCustomerList}
            onSubmit={submit}
            onValuesChange={(nextValues) => {
              setFormValues(nextValues);
              logicalAttemptRef.current = null;
              setFeedback(null);
              createMutation.reset();
            }}
            pending={createMutation.isPending}
            values={formValues}
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
      <div className="contacts:mx-auto contacts:min-w-0 contacts:w-full contacts:max-w-3xl contacts:px-4 contacts:py-8 contacts:sm:px-8 contacts:lg:px-12">
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
