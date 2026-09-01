import type { ComponentType } from 'react';
import type { ResolvedModuleTarget } from '../../shared/api.ts';

export type ApprovedVerticalPageComponent = ComponentType<{
  readonly routeParams: Readonly<Record<string, string>>;
  readonly target: ResolvedModuleTarget;
}>;

export interface ApprovedVerticalPageClient {
  readonly appId: string;
  readonly componentKey: string;
  readonly load: () => Promise<{ readonly default: ApprovedVerticalPageComponent }>;
}

/** Codesmith-owned allowlist. Executable imports remain lazy and owner-deployment-specific. */
export const ultramodernVerticalClients: readonly ApprovedVerticalPageClient[] = [
  // @ontos-codegen-start shell-page-clients
  {
    appId: 'contacts',
    componentKey: 'contacts.core.page-contact-create',
    load: () => import('contacts/PageContactCreate'),
  },
  {
    appId: 'contacts',
    componentKey: 'contacts.core.page-contact-detail',
    load: () => import('contacts/PageContactDetail'),
  },
  {
    appId: 'contacts',
    componentKey: 'contacts.core.page-contact-edit',
    load: () => import('contacts/PageContactEdit'),
  },
  {
    appId: 'contacts',
    componentKey: 'contacts.core.page-contacts',
    load: () => import('contacts/PageContacts'),
  },
  {
    appId: 'contacts',
    componentKey: 'contacts.core.page-customer-create',
    load: () => import('contacts/PageCustomerCreate'),
  },
  {
    appId: 'contacts',
    componentKey: 'contacts.core.page-customer-detail',
    load: () => import('contacts/PageCustomerDetail'),
  },
  {
    appId: 'contacts',
    componentKey: 'contacts.core.page-customer-edit',
    load: () => import('contacts/PageCustomerEdit'),
  },
  {
    appId: 'contacts',
    componentKey: 'contacts.core.page-customers-list',
    load: () => import('contacts/PageCustomersList'),
  },
  // @ontos-codegen-end shell-page-clients
];

export const findApprovedVerticalPageClient = (
  target: Pick<ResolvedModuleTarget, 'appId' | 'componentKey'>,
): ApprovedVerticalPageClient | undefined =>
  ultramodernVerticalClients.find(
    (client) => client.appId === target.appId && client.componentKey === target.componentKey,
  );
