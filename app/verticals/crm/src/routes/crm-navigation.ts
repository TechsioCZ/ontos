type CrmPage = 'customers' | 'deals';

const entrypointKeyByPage = {
  customers: 'crm.core.page.customers',
  deals: 'crm.core.page.deals',
} as const satisfies Readonly<Record<CrmPage, string>>;

export const crmNavigationHref = (
  page: CrmPage,
  options: { readonly embedded: boolean; readonly language: string },
): string =>
  options.embedded ? `?page=${entrypointKeyByPage[page]}` : `/${options.language || 'en'}/${page}`;
