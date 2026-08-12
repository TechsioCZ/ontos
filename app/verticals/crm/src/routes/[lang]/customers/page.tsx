/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- mutation handlers preserve generated Effect failures until the page boundary */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData, useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Random } from 'effect';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { executeCreateContactAction } from '../../../api/create-contact-action-client.ts';
import { executeCreateCustomerAction } from '../../../api/create-customer-action-client.ts';
import { Effect, runEffectRequest } from '../../../api/crm-client.ts';
import { executeDeleteContactAction } from '../../../api/delete-contact-action-client.ts';
import { executeDeleteCustomerAction } from '../../../api/delete-customer-action-client.ts';
import { executeEditContactAction } from '../../../api/edit-contact-action-client.ts';
import { executeEditCustomerAction } from '../../../api/edit-customer-action-client.ts';
import { ContactPanel } from '../../../contacts/contact-panel.tsx';
import { contactFormToWritableFields } from '../../../contacts/contact-view-model.ts';
import type {
  ContactDeleteResult,
  ContactDetailModel,
  ContactFormValues,
  ContactMutationResult,
  ContactPanelCopy,
} from '../../../contacts/contact-view-model.ts';
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
  contactDeleteFailure,
  contactMutationFailure,
  contactViewToRecord,
  deleteFailure,
  hrefWithSelectedContact,
  hrefWithSelectedCustomer,
  isCustomerPageModel,
  loadCustomerPageModel,
  mutationFailure,
} from './page.data.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import { crmNavigationHref } from '../../crm-navigation';

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
      policy: t('crm.pages.customers.states.validation.policy'),
    },
  },
  toast: {
    created: t('crm.pages.customers.toast.created'),
    deleted: t('crm.pages.customers.toast.deleted'),
    updated: t('crm.pages.customers.toast.updated'),
  },
});

const contactCopy = (
  t: (key: string, options?: Record<string, unknown>) => string,
): ContactPanelCopy => ({
  actions: {
    cancel: t('crm.pages.customers.contacts.actions.cancel'),
    create: t('crm.pages.customers.contacts.actions.create'),
    delete: t('crm.pages.customers.contacts.actions.delete'),
    edit: t('crm.pages.customers.contacts.actions.edit'),
    nextPage: t('crm.pages.customers.contacts.actions.nextPage'),
    retry: t('crm.pages.customers.contacts.actions.retry'),
    save: t('crm.pages.customers.contacts.actions.save'),
  },
  deleteDialog: {
    description: (contactName) =>
      t('crm.pages.customers.contacts.deleteDialog.description', { contactName }),
    pending: t('crm.pages.customers.contacts.deleteDialog.pending'),
    title: t('crm.pages.customers.contacts.deleteDialog.title'),
  },
  detail: {
    heading: t('crm.pages.customers.contacts.detail.heading'),
    notProvided: t('crm.pages.customers.contacts.detail.notProvided'),
    selectPrompt: t('crm.pages.customers.contacts.detail.selectPrompt'),
  },
  fields: {
    email: t('crm.pages.customers.contacts.fields.email'),
    firstName: t('crm.pages.customers.contacts.fields.firstName'),
    jobTitle: t('crm.pages.customers.contacts.fields.jobTitle'),
    lastName: t('crm.pages.customers.contacts.fields.lastName'),
    phone: t('crm.pages.customers.contacts.fields.phone'),
  },
  form: {
    createTitle: t('crm.pages.customers.contacts.form.createTitle'),
    editTitle: t('crm.pages.customers.contacts.form.editTitle'),
    pending: t('crm.pages.customers.contacts.form.pending'),
    summary: t('crm.pages.customers.contacts.form.summary'),
  },
  heading: (customerName) => t('crm.pages.customers.contacts.heading', { customerName }),
  issues: {
    invalid_email: t('crm.pages.customers.contacts.issues.invalidEmail'),
    name_required: t('crm.pages.customers.contacts.issues.nameRequired'),
    server_validation: t('crm.pages.customers.contacts.issues.serverValidation'),
    too_long: t('crm.pages.customers.contacts.issues.tooLong'),
  },
  list: {
    caption: t('crm.pages.customers.contacts.list.caption'),
    email: t('crm.pages.customers.contacts.list.email'),
    jobTitle: t('crm.pages.customers.contacts.list.jobTitle'),
    name: t('crm.pages.customers.contacts.list.name'),
    page: (page) => t('crm.pages.customers.contacts.list.page', { page }),
    phone: t('crm.pages.customers.contacts.list.phone'),
  },
  nameFallback: t('crm.pages.customers.contacts.nameFallback'),
  states: {
    conflict: t('crm.pages.customers.contacts.states.conflict'),
    empty: t('crm.pages.customers.contacts.states.empty'),
    forbidden: t('crm.pages.customers.contacts.states.forbidden'),
    loading: t('crm.pages.customers.contacts.states.loading'),
    notFound: t('crm.pages.customers.contacts.states.notFound'),
    readOnly: t('crm.pages.customers.contacts.states.readOnly'),
    unavailable: t('crm.pages.customers.contacts.states.unavailable'),
    validation: {
      foreign_selection: t('crm.pages.customers.contacts.states.validation.foreignSelection'),
      invalid_cursor: t('crm.pages.customers.contacts.states.validation.invalidCursor'),
      invalid_page: t('crm.pages.customers.contacts.states.validation.invalidPage'),
      invalid_selection: t('crm.pages.customers.contacts.states.validation.invalidSelection'),
      policy: t('crm.pages.customers.contacts.states.validation.policy'),
    },
  },
  toast: {
    created: t('crm.pages.customers.contacts.toast.created'),
    deleted: t('crm.pages.customers.contacts.toast.deleted'),
    updated: t('crm.pages.customers.contacts.toast.updated'),
  },
});

export const CustomersPage = ({ target }: CustomersPageProps) => {
  const { language, t } = useModernI18n();
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

  const load = (href: string, scope: 'contacts' | 'page' = 'page') => {
    hrefRef.current = href;
    setModelOverride((currentOverride) => {
      const currentModel = currentOverride ?? loaderModel;
      if (
        scope === 'contacts' &&
        currentModel?.state === 'resolved' &&
        currentModel.contacts !== undefined
      ) {
        return {
          ...currentModel,
          contacts: {
            customerId: currentModel.contacts.customerId,
            customerName: currentModel.contacts.customerName,
            state: 'loading',
          },
        };
      }
      return { state: 'loading' };
    });
    return loadCustomerPageModel({ url: new URL(href, window.location.origin).href })
      .then(setModelOverride)
      .catch(() => setModelOverride({ retryHref: href, state: 'unavailable' }));
  };

  useEffect(() => {
    if (loaderModel === undefined) {
      const href = hrefRef.current;
      void loadCustomerPageModel({ url: new URL(href, window.location.origin).href })
        .then(setModelOverride)
        .catch(() => setModelOverride({ retryHref: href, state: 'unavailable' }));
    }
  }, [loaderModel]);

  const refresh = (href = hrefRef.current) => load(href);
  const refreshContacts = (href = hrefRef.current) => load(href, 'contacts');
  const refreshContactsSilently = () =>
    loadCustomerPageModel({ url: new URL(hrefRef.current, window.location.origin).href })
      .then(setModelOverride)
      .catch(() => false);
  const refreshSilently = () =>
    loadCustomerPageModel({ url: new URL(hrefRef.current, window.location.origin).href })
      .then((nextModel) => {
        if (nextModel.state !== 'unavailable') {
          setModelOverride((currentOverride) => {
            const currentModel = currentOverride ?? loaderModel;
            if (
              currentModel?.state === 'resolved' &&
              currentModel.detail !== undefined &&
              (nextModel.state !== 'resolved' || nextModel.detail === undefined)
            ) {
              return currentModel;
            }
            if (
              currentModel?.state === 'resolved' &&
              nextModel.state === 'resolved' &&
              currentModel.contacts?.state === 'resolved' &&
              currentModel.contacts.detail !== undefined &&
              (nextModel.contacts?.state !== 'resolved' || nextModel.contacts.detail === undefined)
            ) {
              return { ...nextModel, contacts: currentModel.contacts };
            }
            return nextModel;
          });
        }
      })
      .catch(() => false);

  const onNavigate = (href: string) => {
    navigate({ to: href });
    void refresh(href);
  };

  const onContactNavigate = (href: string) => {
    navigate({ to: href });
    void refreshContacts(href);
  };

  const onCreate = (values: CustomerFormValues): Promise<CustomerMutationResult> =>
    runEffectRequest(
      executeCreateCustomerAction(customerFormToWritableFields(values), requestOptions()).pipe(
        Effect.map(
          (updatedCustomer): CustomerMutationResult => ({
            customer: customerViewToRecord(updatedCustomer),
            state: 'success',
          }),
        ),
        Effect.catch((error) => Effect.succeed(mutationFailure(error))),
      ),
    ).then((result) => {
      if (result.state !== 'success') {
        return result;
      }
      const href = hrefWithSelectedCustomer(hrefRef.current, result.customer.customerId);
      navigate({ to: href });
      void refresh(href);
      return result;
    });

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
      ).pipe(
        Effect.map(
          (updatedCustomer): CustomerMutationResult => ({
            customer: customerViewToRecord(updatedCustomer),
            state: 'success',
          }),
        ),
        Effect.catch((error) => Effect.succeed(mutationFailure(error))),
      ),
    ).then((result) => {
      if (result.state === 'success') {
        void refresh();
      } else if (result.state === 'conflict' || result.state === 'not_found') {
        void refreshSilently();
      }
      return result;
    });

  const onDelete = (customer: CustomerDetailModel): Promise<CustomerDeleteResult> =>
    runEffectRequest(
      executeDeleteCustomerAction(
        { customerId: customer.customerId, expectedVersion: customer.version },
        requestOptions(),
      ).pipe(
        Effect.as({ state: 'success' } as const),
        Effect.catch((error) => Effect.succeed(deleteFailure(error))),
      ),
    ).then((result) => {
      if (result.state === 'success') {
        const href = hrefWithSelectedCustomer(hrefRef.current, null);
        navigate({ to: href });
        void refresh(href);
      } else if (result.state === 'conflict' || result.state === 'not_found') {
        void refreshSilently();
      }
      return result;
    });

  const onCreateContact = (values: ContactFormValues): Promise<ContactMutationResult> => {
    const customerId = model.state === 'resolved' ? model.contacts?.customerId : undefined;
    if (customerId === undefined) {
      return Promise.resolve({ state: 'unavailable' });
    }
    return runEffectRequest(
      executeCreateContactAction(
        { ...contactFormToWritableFields(values), customerId },
        requestOptions(),
      ).pipe(
        Effect.map(
          (contact): ContactMutationResult => ({
            contact: contactViewToRecord(contact),
            state: 'success',
          }),
        ),
        Effect.catch((error) => Effect.succeed(contactMutationFailure(error))),
      ),
    ).then((result) => {
      if (result.state !== 'success') {
        return result;
      }
      const href = hrefWithSelectedContact(hrefRef.current, result.contact.contactId);
      hrefRef.current = href;
      navigate({ to: href });
      return result;
    });
  };

  const onEditContact = (
    contact: ContactDetailModel,
    values: ContactFormValues,
  ): Promise<ContactMutationResult> =>
    runEffectRequest(
      executeEditContactAction(
        {
          ...contactFormToWritableFields(values),
          contactId: contact.contactId,
          expectedVersion: contact.version,
        },
        requestOptions(),
      ).pipe(
        Effect.map(
          (updated): ContactMutationResult => ({
            contact: contactViewToRecord(updated),
            state: 'success',
          }),
        ),
        Effect.catch((error) => Effect.succeed(contactMutationFailure(error))),
      ),
    ).then((result) => {
      if (result.state === 'conflict' || result.state === 'not_found') {
        void refreshSilently();
      }
      return result;
    });

  const onDeleteContact = (contact: ContactDetailModel): Promise<ContactDeleteResult> =>
    runEffectRequest(
      executeDeleteContactAction(
        { contactId: contact.contactId, expectedVersion: contact.version },
        requestOptions(),
      ).pipe(
        Effect.as({ state: 'success' } as const),
        Effect.catch((error) => Effect.succeed(contactDeleteFailure(error))),
      ),
    ).then((result) => {
      if (result.state === 'success') {
        const href = hrefWithSelectedContact(hrefRef.current, null);
        hrefRef.current = href;
        navigate({ to: href });
      } else if (result.state === 'conflict' || result.state === 'not_found') {
        void refreshSilently();
      }
      return result;
    });

  return (
    <>
      <UltramodernRouteHead />
      <main className="crm:min-h-screen crm:bg-(--color-page-bg) crm:px-4 crm:py-8 crm:text-(--color-page-fg) crm:sm:px-8 crm:lg:px-12">
        <div className="crm:mx-auto crm:grid crm:max-w-7xl crm:gap-8">
          <header className="crm:space-y-3">
            <nav aria-label={t('crm.navigation.label')} className="crm:flex crm:gap-4">
              <Link
                aria-current="page"
                href={crmNavigationHref('customers', {
                  embedded: target !== undefined,
                  language,
                })}
              >
                {t('crm.navigation.customers')}
              </Link>
              <Link
                href={crmNavigationHref('deals', {
                  embedded: target !== undefined,
                  language,
                })}
              >
                {t('crm.navigation.deals')}
              </Link>
            </nav>
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
          {model.state === 'resolved' && model.contacts !== undefined && (
            <ContactPanel
              copy={contactCopy(t)}
              model={model.contacts}
              onCreate={onCreateContact}
              onDelete={onDeleteContact}
              onEdit={onEditContact}
              onMutationSuccess={() => void refreshContactsSilently()}
              onNavigate={onContactNavigate}
              onRetry={() => void refreshContacts()}
              writable={target?.writable ?? true}
            />
          )}
        </div>
      </main>
    </>
  );
};

export default CustomersPage;
