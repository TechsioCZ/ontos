import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link as RouterLink, useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import {
  QueryClient,
  QueryClientProvider,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect as EffectRuntime, Option, Random, Schema } from 'effect';
import { useMemo, useRef, useState } from 'react';
import { CrmUuidSchema } from '../../../../../../../shared/apis/customer-detail.ts';
import {
  editCustomer,
  getCustomerDetail,
  runEffectRequest,
} from '../../../../../../api/crm-client.ts';
import type { Effect } from '../../../../../../api/crm-client.ts';
import { CustomerForm } from '../../../../../../features/customers/customer-form.tsx';
import type {
  CustomerFormFieldErrors,
  CustomerFormStatus,
  CustomerFormValues,
} from '../../../../../../features/customers/customer-form.tsx';
import { UltramodernRouteHead } from '../../../../../ultramodern-route-head';

export type CustomerEditPageRouteParams = Readonly<Partial<Record<'id', string>>>;

export interface CustomerEditPageTarget {
  readonly writable: boolean;
}

export interface CustomerEditPageProps {
  readonly routeParams: CustomerEditPageRouteParams;
  readonly target: CustomerEditPageTarget;
}

type CustomerDetailClientError = Effect.Error<ReturnType<typeof getCustomerDetail>>;
type EditCustomerClientError = Effect.Error<ReturnType<typeof editCustomer>>;
type CustomerDetail = Effect.Success<ReturnType<typeof getCustomerDetail>>;

type UnavailableReason = 'backend' | 'decode' | 'transport' | 'unexpected';

export type CustomerDetailErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'not_found' }
  | { readonly reason: UnavailableReason; readonly state: 'unavailable' };

export type EditCustomerErrorState =
  | { readonly state: 'authentication_expired' }
  | { readonly state: 'conflict' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'ico_conflict' }
  | { readonly state: 'invalid' }
  | { readonly state: 'not_found' }
  | {
      readonly reason: Exclude<UnavailableReason, 'unexpected'>;
      readonly state: 'unavailable';
      readonly uncertain: true;
    }
  | { readonly state: 'unexpected' };

const classifyHttpClientFailure = (error: {
  readonly reason: { readonly _tag: string };
}): UnavailableReason => {
  if (error.reason._tag === 'TransportError') {
    return 'transport';
  }
  if (error.reason._tag === 'DecodeError' || error.reason._tag === 'EmptyBodyError') {
    return 'decode';
  }
  return 'unexpected';
};

export const classifyCustomerDetailError = (
  error: CustomerDetailClientError,
): CustomerDetailErrorState => {
  if (error._tag === 'HttpClientError') {
    return { reason: classifyHttpClientFailure(error), state: 'unavailable' };
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
      return { reason: 'unexpected', state: 'unavailable' };
    }
    default: {
      const unexpected: never = error;
      return unexpected;
    }
  }
};

export const isRetryableCustomerDetailError = (error: CustomerDetailClientError) => {
  const classified = classifyCustomerDetailError(error);
  return classified.state === 'unavailable' && classified.reason !== 'unexpected';
};

export const classifyEditCustomerError = (
  error: EditCustomerClientError,
): EditCustomerErrorState => {
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
      return { state: 'invalid' };
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
    case 'CrmConflictProblem': {
      return error.code === 'crm_customer_ico_conflict'
        ? { state: 'ico_conflict' }
        : { state: 'conflict' };
    }
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

export const decodeCustomerEditId = (routeParams: CustomerEditPageRouteParams) => {
  const decoded = Schema.decodeUnknownOption(CrmUuidSchema)(routeParams.id);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

export const customerDetailQueryKey = (customerId: string) =>
  ['crm', 'customers', 'detail', customerId] as const;

export const customerListHref = (language: string) => `/${language}/crm/customers`;

interface CustomerEditCopy {
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
  readonly mutation: {
    readonly authenticationExpired: string;
    readonly conflict: string;
    readonly duplicateIco: string;
    readonly forbidden: string;
    readonly generic: string;
    readonly invalid: string;
    readonly notFound: string;
    readonly success: string;
  };
  readonly states: {
    readonly authenticationExpired: string;
    readonly decode: string;
    readonly forbidden: string;
    readonly generic: string;
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

interface MutationFeedback {
  readonly fieldErrors?: CustomerFormFieldErrors;
  readonly formStatus?: CustomerFormStatus;
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

interface CustomerFormDraft {
  readonly customerId: string;
  readonly values: CustomerFormValues;
}

const formValuesForCustomer = (customer: CustomerDetail): CustomerFormValues => ({
  dic: customer.dic ?? '',
  dissolvedOn: customer.dissolvedOn ?? '',
  establishedOn: customer.establishedOn ?? '',
  ico: customer.ico ?? '',
  legalFormCode: customer.legalFormCode ?? '',
  name: customer.name,
});

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

const statusForDetailError = (state: CustomerDetailErrorState, copy: CustomerEditCopy): string => {
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
    transport: copy.states.transport,
    unexpected: copy.states.generic,
  }[state.reason];
};

const feedbackForEditError = (
  state: EditCustomerErrorState,
  copy: CustomerEditCopy,
): MutationFeedback => {
  switch (state.state) {
    case 'invalid': {
      return { formStatus: { message: copy.mutation.invalid, status: 'error' } };
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
    case 'ico_conflict': {
      return { formStatus: { message: copy.mutation.duplicateIco, status: 'warning' } };
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

export const CustomerEditFeature = ({ routeParams, target }: CustomerEditPageProps) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const customerId = decodeCustomerEditId(routeParams);
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);
  const [formDraft, setFormDraft] = useState<CustomerFormDraft | null>(null);
  const logicalAttemptRef = useRef<LogicalMutationAttempt | null>(null);
  const copy: CustomerEditCopy = {
    back: t('crm.pages.customerEdit.back'),
    description: t('crm.pages.customerEdit.description'),
    form: {
      cancel: t('crm.pages.customerEdit.form.cancel'),
      dicHint: t('crm.pages.customerEdit.form.dicHint'),
      dicInvalid: t('crm.pages.customerEdit.form.dicInvalid'),
      dicLabel: t('crm.pages.customerEdit.form.dicLabel'),
      dissolvedBeforeEstablished: t('crm.pages.customerEdit.form.dissolvedBeforeEstablished'),
      dissolvedOnHint: t('crm.pages.customerEdit.form.dissolvedOnHint'),
      dissolvedOnLabel: t('crm.pages.customerEdit.form.dissolvedOnLabel'),
      establishedOnHint: t('crm.pages.customerEdit.form.establishedOnHint'),
      establishedOnLabel: t('crm.pages.customerEdit.form.establishedOnLabel'),
      icoHint: t('crm.pages.customerEdit.form.icoHint'),
      icoInvalid: t('crm.pages.customerEdit.form.icoInvalid'),
      icoLabel: t('crm.pages.customerEdit.form.icoLabel'),
      legalFormCodeHint: t('crm.pages.customerEdit.form.legalFormCodeHint'),
      legalFormCodeInvalid: t('crm.pages.customerEdit.form.legalFormCodeInvalid'),
      legalFormCodeLabel: t('crm.pages.customerEdit.form.legalFormCodeLabel'),
      nameHint: t('crm.pages.customerEdit.form.nameHint'),
      nameInvalid: t('crm.pages.customerEdit.form.nameInvalid'),
      nameLabel: t('crm.pages.customerEdit.form.nameLabel'),
      nameRequired: t('crm.pages.customerEdit.form.nameRequired'),
      save: t('crm.pages.customerEdit.form.save'),
      saving: t('crm.pages.customerEdit.form.saving'),
    },
    mutation: {
      authenticationExpired: t('crm.pages.customerEdit.mutation.authenticationExpired'),
      conflict: t('crm.pages.customerEdit.mutation.conflict'),
      duplicateIco: t('crm.pages.customerEdit.mutation.duplicateIco'),
      forbidden: t('crm.pages.customerEdit.mutation.forbidden'),
      generic: t('crm.pages.customerEdit.mutation.generic'),
      invalid: t('crm.pages.customerEdit.mutation.invalid'),
      notFound: t('crm.pages.customerEdit.mutation.notFound'),
      success: t('crm.pages.customerEdit.mutation.success'),
    },
    states: {
      authenticationExpired: t('crm.pages.customerEdit.states.authenticationExpired'),
      decode: t('crm.pages.customerEdit.states.decode'),
      forbidden: t('crm.pages.customerEdit.states.forbidden'),
      generic: t('crm.pages.customerEdit.states.generic'),
      loading: t('crm.pages.customerEdit.states.loading'),
      notFound: t('crm.pages.customerEdit.states.notFound'),
      readOnly: t('crm.pages.customerEdit.states.readOnly'),
      retry: t('crm.pages.customerEdit.states.retry'),
      retrying: t('crm.pages.customerEdit.states.retrying'),
      transport: t('crm.pages.customerEdit.states.transport'),
      unavailable: t('crm.pages.customerEdit.states.unavailable'),
    },
    title: t('crm.pages.customerEdit.title'),
  };
  const detailQuery = useQuery<CustomerDetail, CustomerDetailClientError>({
    queryFn:
      customerId === undefined
        ? skipToken
        : () =>
            runEffectRequest(
              getCustomerDetail(
                { customerId },
                {
                  baseUrl: ULTRAMODERN_CRM_API_BASE_URL,
                  correlationId: createRequestId(),
                  locale: language,
                },
              ),
            ),
    queryKey: customerDetailQueryKey(customerId ?? 'invalid'),
    retry: (failureCount, error) => failureCount < 1 && isRetryableCustomerDetailError(error),
    retryDelay: 250,
  });
  const editMutation = useMutation<
    CustomerDetail,
    EditCustomerClientError,
    {
      readonly customerId: string;
      readonly idempotencyKey: string;
      readonly payload: CustomerPayloadValues;
    }
  >({
    mutationFn: ({ customerId: mutationCustomerId, idempotencyKey, payload }) =>
      runEffectRequest(
        editCustomer(
          { customerId: mutationCustomerId, ...payload },
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

  const submit = (formValues: CustomerFormValues): Promise<void> => {
    if (customerId === undefined || !target.writable) {
      return Promise.resolve();
    }
    const values = customerPayloadValues(formValues);
    const previousAttempt = logicalAttemptRef.current;
    const idempotencyKey =
      previousAttempt?.uncertain === true && sameCustomerPayload(previousAttempt.payload, values)
        ? previousAttempt.idempotencyKey
        : createRequestId();
    logicalAttemptRef.current = { idempotencyKey, payload: values, uncertain: false };
    setFeedback(null);

    // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Promise-returning form callbacks stay non-async under strict Effect diagnostics.
    return editMutation.mutateAsync({ customerId, idempotencyKey, payload: values }).then(
      (customer) => {
        logicalAttemptRef.current = null;
        queryClient.setQueryData(customerDetailQueryKey(customerId), customer);
        setFeedback({
          formStatus: { message: copy.mutation.success, status: 'success' },
        });
        void navigate({ to: destination });
      },
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- The typed rejection branch maps TanStack Query failures without an async UI callback.
      (error: EditCustomerClientError) => {
        const state = classifyEditCustomerError(error);
        logicalAttemptRef.current =
          state.state === 'unavailable'
            ? { idempotencyKey, payload: values, uncertain: true }
            : null;
        setFeedback(feedbackForEditError(state, copy));
      },
    );
  };

  let content;
  if (customerId === undefined) {
    content = (
      <output>
        <StatusText aria-live="polite" showIcon status="error">
          {copy.states.notFound}
        </StatusText>
      </output>
    );
  } else if (detailQuery.isPending) {
    content = (
      <output>
        <StatusText aria-live="polite" status="default">
          {copy.states.loading}
        </StatusText>
      </output>
    );
  } else if (detailQuery.isError) {
    const errorState = classifyCustomerDetailError(detailQuery.error);
    const canRetry =
      errorState.state === 'authentication_expired' || errorState.state === 'unavailable';
    content = (
      <div className="crm:grid crm:justify-items-start crm:gap-3">
        <output>
          <StatusText aria-live="polite" showIcon status="error">
            {statusForDetailError(errorState, copy)}
          </StatusText>
        </output>
        {canRetry ? (
          <Button
            disabled={detailQuery.isFetching}
            isLoading={detailQuery.isFetching}
            loadingText={copy.states.retrying}
            onClick={() => void detailQuery.refetch()}
            type="button"
            variant="primary"
          >
            {copy.states.retry}
          </Button>
        ) : null}
      </div>
    );
  } else {
    const formValues =
      formDraft !== null && formDraft.customerId === detailQuery.data.customerId
        ? formDraft.values
        : formValuesForCustomer(detailQuery.data);
    content = (
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
          {...(feedback?.fieldErrors === undefined ? {} : { fieldErrors: feedback.fieldErrors })}
          {...(feedback?.formStatus === undefined ? {} : { formStatus: feedback.formStatus })}
          onCancel={goToCustomerList}
          onSubmit={submit}
          onValuesChange={(nextValues) => {
            setFormDraft({ customerId: detailQuery.data.customerId, values: nextValues });
            logicalAttemptRef.current = null;
            setFeedback(null);
            editMutation.reset();
          }}
          pending={editMutation.isPending}
          values={formValues}
        />
      </div>
    );
  }

  return (
    <section aria-labelledby="customer-edit-heading" className="crm:grid crm:min-w-0 crm:gap-6">
      <Link as={RouterLink} to={destination}>
        {copy.back}
      </Link>
      <header className="crm:grid crm:gap-2">
        <h1 className="crm:text-3xl crm:font-bold" id="customer-edit-heading">
          {copy.title}
        </h1>
        <p>{copy.description}</p>
      </header>
      <div aria-busy={detailQuery.isPending || editMutation.isPending}>{content}</div>
    </section>
  );
};

export const CustomerEditPage = ({ routeParams, target }: CustomerEditPageProps) => {
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
          <CustomerEditFeature routeParams={routeParams} target={target} />
        </QueryClientProvider>
      </div>
    </>
  );
};

const StandaloneCustomerEditPage = () => {
  const routeParams = useParams({ strict: false });

  return (
    <CustomerEditPage
      routeParams={routeParams.id === undefined ? {} : { id: routeParams.id }}
      target={{ writable: false }}
    />
  );
};

export default StandaloneCustomerEditPage;
