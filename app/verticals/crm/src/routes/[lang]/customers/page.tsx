/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- mutation handlers preserve generated Effect failures until the page boundary */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData, useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Random } from 'effect';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { executeCreateCustomerAction } from '../../../api/create-customer-action-client.ts';
import { Effect, runEffectRequest } from '../../../api/crm-client.ts';
import { executeDeleteCustomerAction } from '../../../api/delete-customer-action-client.ts';
import { executeEditCustomerAction } from '../../../api/edit-customer-action-client.ts';
import type { CustomerView } from '../../../../shared/apis/customer-directory.ts';
import { CustomerWorkspace } from '../../../customers/customer-workspace.tsx';
import { customerFormToWritableFields } from '../../../customers/customer-view-model.ts';
import type {
  CustomerDeleteResult,
  CustomerDetailModel,
  CustomerFormValues,
  CustomerMutationResult,
  CustomerPageModel,
  CustomerWorkspaceCopy,
} from '../../../customers/customer-view-model.ts';
import {
  customerViewToRecord,
  deleteFailure,
  hrefWithSelectedCustomer,
  isCustomerPageModel,
  loadCustomerPageModel,
  mutationFailure,
} from './page.data.ts';
import type { CustomerClientFailure } from './page.data.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

interface CustomerPageTarget {
  readonly writable: boolean;
}

interface CustomersPageProps {
  readonly target?: CustomerPageTarget;
}

const requestOptions = () => {
  const id = `${Effect.runSync(Random.nextInt)}-${Effect.runSync(Random.nextInt)}`;
  return { correlationId: `customer-ui-${id}`, idempotencyKey: id };
};

const currentCustomerHref = () =>
  typeof window === 'undefined'
    ? '/en/customers'
    : `${window.location.pathname}${window.location.search}`;

const subscribeToHydration = () => () => false;
const getHydratedClientSnapshot = () => true;
const getHydratedServerSnapshot = () => false;

const customerCopy = (
  t: (key: string, options?: Record<string, unknown>) => string,
): CustomerWorkspaceCopy => ({
  actions: {
    cancel: t('crm.pages.customers.actions.cancel'),
    create: t('crm.pages.customers.actions.create'),
    delete: t('crm.pages.customers.actions.delete'),
    edit: t('crm.pages.customers.actions.edit'),
    nextPage: t('crm.pages.customers.actions.nextPage'),
    retry: t('crm.pages.customers.actions.retry'),
    save: t('crm.pages.customers.actions.save'),
  },
  deleteDialog: {
    description: (customerName) =>
      t('crm.pages.customers.deleteDialog.description', { customerName }),
    pending: t('crm.pages.customers.deleteDialog.pending'),
    title: t('crm.pages.customers.deleteDialog.title'),
  },
  detail: {
    heading: t('crm.pages.customers.detail.heading'),
    notProvided: t('crm.pages.customers.detail.notProvided'),
    selectPrompt: t('crm.pages.customers.detail.selectPrompt'),
  },
  fields: {
    addressLine1: t('crm.pages.customers.fields.addressLine1'),
    addressLine2: t('crm.pages.customers.fields.addressLine2'),
    city: t('crm.pages.customers.fields.city'),
    companyRegistrationNumber: t('crm.pages.customers.fields.companyRegistrationNumber'),
    countryCode: t('crm.pages.customers.fields.countryCode'),
    email: t('crm.pages.customers.fields.email'),
    name: t('crm.pages.customers.fields.name'),
    phone: t('crm.pages.customers.fields.phone'),
    postalCode: t('crm.pages.customers.fields.postalCode'),
    region: t('crm.pages.customers.fields.region'),
    taxIdentificationNumber: t('crm.pages.customers.fields.taxIdentificationNumber'),
    website: t('crm.pages.customers.fields.website'),
  },
  form: {
    createTitle: t('crm.pages.customers.form.createTitle'),
    editTitle: t('crm.pages.customers.form.editTitle'),
    pending: t('crm.pages.customers.form.pending'),
    summary: t('crm.pages.customers.form.summary'),
  },
  issues: {
    invalid_country_code: t('crm.pages.customers.issues.invalidCountryCode'),
    invalid_email: t('crm.pages.customers.issues.invalidEmail'),
    invalid_website: t('crm.pages.customers.issues.invalidWebsite'),
    required: t('crm.pages.customers.issues.required'),
    server_validation: t('crm.pages.customers.issues.serverValidation'),
    too_long: t('crm.pages.customers.issues.tooLong'),
  },
  list: {
    caption: t('crm.pages.customers.list.caption'),
    city: t('crm.pages.customers.list.city'),
    companyRegistrationNumber: t('crm.pages.customers.list.companyRegistrationNumber'),
    email: t('crm.pages.customers.list.email'),
    name: t('crm.pages.customers.list.name'),
    page: (page) => t('crm.pages.customers.list.page', { page }),
  },
  states: {
    conflict: t('crm.pages.customers.states.conflict'),
    empty: t('crm.pages.customers.states.empty'),
    forbidden: t('crm.pages.customers.states.forbidden'),
    loading: t('crm.pages.customers.states.loading'),
    notFound: t('crm.pages.customers.states.notFound'),
    readOnly: t('crm.pages.customers.states.readOnly'),
    unavailable: t('crm.pages.customers.states.unavailable'),
    validation: {
      invalid_cursor: t('crm.pages.customers.states.validation.invalidCursor'),
      invalid_page: t('crm.pages.customers.states.validation.invalidPage'),
      invalid_selection: t('crm.pages.customers.states.validation.invalidSelection'),
    },
  },
  toast: {
    created: t('crm.pages.customers.toast.created'),
    deleted: t('crm.pages.customers.toast.deleted'),
    updated: t('crm.pages.customers.toast.updated'),
  },
});

export const CustomersPage = ({ target }: CustomersPageProps) => {
  const { t } = useModernI18n();
  const navigate = useNavigate();
  const loaderValue: unknown = useLoaderData({ strict: false });
  const loaderModel = isCustomerPageModel(loaderValue) ? loaderValue : undefined;
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydratedClientSnapshot,
    getHydratedServerSnapshot,
  );
  const [modelOverride, setModelOverride] = useState<CustomerPageModel>();
  const model = modelOverride ?? (hydrated ? loaderModel : undefined) ?? { state: 'loading' };
  const hrefRef = useRef(currentCustomerHref());

  const load = (href: string) => {
    hrefRef.current = href;
    setModelOverride({ state: 'loading' });
    return loadCustomerPageModel({ url: new URL(href, window.location.origin).href })
      .then(setModelOverride)
      .catch(() => setModelOverride({ retryHref: href, state: 'unavailable' }));
  };

  useEffect(() => {
    if (loaderModel === undefined) {
      void load(hrefRef.current);
    }
  }, [loaderModel]);

  const refresh = (href = hrefRef.current) => load(href);
  const refreshSilently = () =>
    loadCustomerPageModel({ url: new URL(hrefRef.current, window.location.origin).href })
      .then((nextModel) => {
        if (nextModel.state !== 'unavailable') {
          setModelOverride((currentOverride) => {
            const currentModel = currentOverride ?? loaderModel;
            return currentModel?.state === 'resolved' &&
              currentModel.detail !== undefined &&
              (nextModel.state !== 'resolved' || nextModel.detail === undefined)
              ? currentModel
              : nextModel;
          });
        }
      })
      .catch(() => false);

  const onNavigate = (href: string) => {
    navigate({ to: href });
    void refresh(href);
  };

  const onCreate = (values: CustomerFormValues): Promise<CustomerMutationResult> =>
    runEffectRequest(
      executeCreateCustomerAction(
        customerFormToWritableFields(values),
        requestOptions(),
      ) as Effect.Effect<CustomerView, CustomerClientFailure>,
    )
      .then((customer) => {
        const href = hrefWithSelectedCustomer(hrefRef.current, customer.customerId);
        navigate({ to: href });
        void refresh(href);
        return { customer: customerViewToRecord(customer), state: 'success' } as const;
      })
      .catch((error: unknown) => mutationFailure(error));

  const onEdit = (
    customer: CustomerDetailModel,
    values: CustomerFormValues,
  ): Promise<CustomerMutationResult> =>
    runEffectRequest(
      executeEditCustomerAction(
        {
          ...customerFormToWritableFields(values),
          customerId: customer.customerId,
          expectedVersion: customer.version,
        },
        requestOptions(),
      ) as Effect.Effect<CustomerView, CustomerClientFailure>,
    )
      .then((updated) => {
        void refresh();
        return { customer: customerViewToRecord(updated), state: 'success' } as const;
      })
      .catch((error: unknown) => {
        const failure = mutationFailure(error);
        if (failure.state === 'conflict' || failure.state === 'not_found') {
          void refreshSilently();
        }
        return failure;
      });

  const onDelete = (customer: CustomerDetailModel): Promise<CustomerDeleteResult> =>
    runEffectRequest(
      executeDeleteCustomerAction(
        { customerId: customer.customerId, expectedVersion: customer.version },
        requestOptions(),
      ),
    )
      .then(() => {
        const href = hrefWithSelectedCustomer(hrefRef.current, null);
        navigate({ to: href });
        void refresh(href);
        return { state: 'success' } as const;
      })
      .catch((error: unknown) => {
        const failure = deleteFailure(error);
        if (failure.state === 'conflict' || failure.state === 'not_found') {
          void refreshSilently();
        }
        return failure;
      });

  return (
    <>
      <UltramodernRouteHead />
      <main className="crm:min-h-screen crm:bg-(--color-page-bg) crm:px-4 crm:py-8 crm:text-(--color-page-fg) crm:sm:px-8 crm:lg:px-12">
        <div className="crm:mx-auto crm:grid crm:max-w-7xl crm:gap-8">
          <header className="crm:space-y-3">
            <h1 className="crm:text-3xl crm:font-bold crm:sm:text-4xl">
              {t('crm.pages.customers.title')}
            </h1>
            <p className="crm:max-w-2xl crm:text-base crm:sm:text-lg">
              {t('crm.pages.customers.description')}
            </p>
          </header>
          <CustomerWorkspace
            copy={customerCopy(t)}
            model={model}
            onCreate={onCreate}
            onDelete={onDelete}
            onEdit={onEdit}
            onNavigate={onNavigate}
            onRetry={() => void refresh()}
            writable={target?.writable ?? true}
          />
        </div>
      </main>
    </>
  );
};

export default CustomersPage;
