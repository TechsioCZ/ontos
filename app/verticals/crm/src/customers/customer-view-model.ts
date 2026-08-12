import type { ContactPanelModel } from '../contacts/contact-view-model.ts';

export const customerFieldNames = [
  'name',
  'companyRegistrationNumber',
  'taxIdentificationNumber',
  'email',
  'phone',
  'website',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'countryCode',
] as const;

export type CustomerFieldName = (typeof customerFieldNames)[number];

export interface CustomerFormValues {
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly city: string;
  readonly companyRegistrationNumber: string;
  readonly countryCode: string;
  readonly email: string;
  readonly name: string;
  readonly phone: string;
  readonly postalCode: string;
  readonly region: string;
  readonly taxIdentificationNumber: string;
  readonly website: string;
}

export type CustomerFormIssueCode =
  | 'invalid_country_code'
  | 'invalid_email'
  | 'invalid_website'
  | 'required'
  | 'server_validation'
  | 'too_long';

export interface CustomerFormIssue {
  readonly code: CustomerFormIssueCode;
  readonly field?: CustomerFieldName;
}

export interface CustomerRecordModel {
  readonly address: {
    readonly addressLine1: string | null;
    readonly addressLine2: string | null;
    readonly city: string | null;
    readonly countryCode: string | null;
    readonly postalCode: string | null;
    readonly region: string | null;
  } | null;
  readonly companyRegistrationNumber: string | null;
  readonly customerId: string;
  readonly email: string | null;
  readonly name: string;
  readonly phone: string | null;
  readonly taxIdentificationNumber: string | null;
  readonly version: number;
  readonly website: string | null;
}

export interface CustomerListRowModel {
  readonly city: string | null;
  readonly companyRegistrationNumber: string | null;
  readonly customerId: string;
  readonly email: string | null;
  readonly href: string;
  readonly name: string;
  readonly selected: boolean;
}

export interface CustomerDetailFieldModel {
  readonly key: Exclude<CustomerFieldName, 'name'>;
  readonly value: string | null;
}

export interface CustomerDetailModel {
  readonly customerId: string;
  readonly fields: readonly CustomerDetailFieldModel[];
  readonly name: string;
  readonly version: number;
}

export interface CustomerPaginationModel {
  readonly nextHref?: string;
  readonly page: number;
}

export type CustomerRouteValidationReason =
  | 'invalid_cursor'
  | 'invalid_page'
  | 'invalid_selection'
  | 'policy';

export type CustomerPageModel =
  | { readonly state: 'loading' }
  | {
      readonly pagination: CustomerPaginationModel;
      readonly state: 'empty';
    }
  | {
      readonly reason: CustomerRouteValidationReason;
      readonly resetHref: string;
      readonly state: 'validation';
    }
  | { readonly state: 'forbidden' }
  | { readonly state: 'not_found' }
  | { readonly retryHref: string; readonly state: 'unavailable' }
  | {
      readonly contacts?: ContactPanelModel;
      readonly detail?: CustomerDetailModel;
      readonly pagination: CustomerPaginationModel;
      readonly rows: readonly CustomerListRowModel[];
      readonly state: 'resolved';
    };

export type CustomerMutationResult =
  | { readonly customer: CustomerRecordModel; readonly state: 'success' }
  | {
      readonly issues: readonly CustomerFormIssue[];
      readonly state: 'validation';
    }
  | { readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable' };

export type CustomerDeleteResult =
  | { readonly state: 'success' }
  | { readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable' };

export interface CustomerWorkspaceCopy {
  readonly actions: {
    readonly cancel: string;
    readonly create: string;
    readonly delete: string;
    readonly edit: string;
    readonly nextPage: string;
    readonly retry: string;
    readonly save: string;
  };
  readonly deleteDialog: {
    readonly description: (customerName: string) => string;
    readonly pending: string;
    readonly title: string;
  };
  readonly detail: {
    readonly heading: string;
    readonly notProvided: string;
    readonly selectPrompt: string;
  };
  readonly fields: Readonly<Record<CustomerFieldName, string>>;
  readonly form: {
    readonly createTitle: string;
    readonly editTitle: string;
    readonly pending: string;
    readonly summary: string;
  };
  readonly issues: Readonly<Record<CustomerFormIssueCode, string>>;
  readonly list: {
    readonly caption: string;
    readonly city: string;
    readonly companyRegistrationNumber: string;
    readonly email: string;
    readonly name: string;
    readonly page: (page: number) => string;
  };
  readonly states: {
    readonly conflict: string;
    readonly empty: string;
    readonly forbidden: string;
    readonly loading: string;
    readonly notFound: string;
    readonly readOnly: string;
    readonly unavailable: string;
    readonly validation: Readonly<Record<CustomerRouteValidationReason, string>>;
  };
  readonly toast: {
    readonly created: string;
    readonly deleted: string;
    readonly updated: string;
  };
}

export interface CustomerWorkspaceProps {
  readonly copy: CustomerWorkspaceCopy;
  readonly model: CustomerPageModel;
  readonly onCreate: (values: CustomerFormValues) => Promise<CustomerMutationResult>;
  readonly onDelete: (customer: CustomerDetailModel) => Promise<CustomerDeleteResult>;
  readonly onEdit: (
    customer: CustomerDetailModel,
    values: CustomerFormValues,
  ) => Promise<CustomerMutationResult>;
  readonly onNavigate: (href: string) => void;
  readonly onRetry: () => void;
  readonly writable: boolean;
}

export const emptyCustomerFormValues: CustomerFormValues = {
  addressLine1: '',
  addressLine2: '',
  city: '',
  companyRegistrationNumber: '',
  countryCode: '',
  email: '',
  name: '',
  phone: '',
  postalCode: '',
  region: '',
  taxIdentificationNumber: '',
  website: '',
};

const maximumLengths: Readonly<Partial<Record<CustomerFieldName, number>>> = {
  addressLine1: 300,
  addressLine2: 300,
  city: 200,
  companyRegistrationNumber: 64,
  countryCode: 2,
  email: 320,
  name: 300,
  phone: 64,
  postalCode: 32,
  region: 200,
  taxIdentificationNumber: 64,
  website: 2048,
};

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

const isWebsite = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const validateCustomerForm = (values: CustomerFormValues): readonly CustomerFormIssue[] => {
  const issues: CustomerFormIssue[] = [];
  if (values.name.trim().length === 0) {
    issues.push({ code: 'required', field: 'name' });
  }
  for (const field of customerFieldNames) {
    const maximum = maximumLengths[field];
    if (maximum !== undefined && values[field].trim().length > maximum) {
      issues.push({ code: 'too_long', field });
    }
  }
  if (values.email.trim().length > 0 && !isEmail(values.email.trim())) {
    issues.push({ code: 'invalid_email', field: 'email' });
  }
  if (values.website.trim().length > 0 && !isWebsite(values.website.trim())) {
    issues.push({ code: 'invalid_website', field: 'website' });
  }
  if (values.countryCode.trim().length > 0 && !/^[A-Za-z]{2}$/u.test(values.countryCode.trim())) {
    issues.push({ code: 'invalid_country_code', field: 'countryCode' });
  }
  const hasAddressWithoutCountry = [
    values.addressLine1,
    values.addressLine2,
    values.city,
    values.region,
    values.postalCode,
  ].some((value) => value.trim().length > 0);
  if (hasAddressWithoutCountry && values.countryCode.trim().length === 0) {
    issues.push({ code: 'required', field: 'countryCode' });
  }
  return issues;
};

export const customerFormValuesFromDetail = (detail: CustomerDetailModel): CustomerFormValues => {
  const values = { ...emptyCustomerFormValues, name: detail.name };
  for (const field of detail.fields) {
    values[field.key] = field.value ?? '';
  }
  return values;
};

export const customerRecordToDetail = (customer: CustomerRecordModel): CustomerDetailModel => ({
  customerId: customer.customerId,
  fields: [
    {
      key: 'companyRegistrationNumber',
      value: customer.companyRegistrationNumber,
    },
    { key: 'taxIdentificationNumber', value: customer.taxIdentificationNumber },
    { key: 'email', value: customer.email },
    { key: 'phone', value: customer.phone },
    { key: 'website', value: customer.website },
    { key: 'addressLine1', value: customer.address?.addressLine1 ?? null },
    { key: 'addressLine2', value: customer.address?.addressLine2 ?? null },
    { key: 'city', value: customer.address?.city ?? null },
    { key: 'region', value: customer.address?.region ?? null },
    { key: 'postalCode', value: customer.address?.postalCode ?? null },
    { key: 'countryCode', value: customer.address?.countryCode ?? null },
  ],
  name: customer.name,
  version: customer.version,
});

const optionalValue = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

export const customerFormToWritableFields = (values: CustomerFormValues) => {
  const addressLine1 = optionalValue(values.addressLine1);
  const addressLine2 = optionalValue(values.addressLine2);
  const city = optionalValue(values.city);
  const countryCode = optionalValue(values.countryCode)?.toUpperCase();
  const postalCode = optionalValue(values.postalCode);
  const region = optionalValue(values.region);
  const companyRegistrationNumber = optionalValue(values.companyRegistrationNumber);
  const email = optionalValue(values.email);
  const phone = optionalValue(values.phone);
  const taxIdentificationNumber = optionalValue(values.taxIdentificationNumber);
  const website = optionalValue(values.website);
  const address = {
    ...(addressLine1 === undefined ? {} : { addressLine1 }),
    ...(addressLine2 === undefined ? {} : { addressLine2 }),
    ...(city === undefined ? {} : { city }),
    ...(countryCode === undefined ? {} : { countryCode }),
    ...(postalCode === undefined ? {} : { postalCode }),
    ...(region === undefined ? {} : { region }),
  };
  const hasAddress = Object.values(address).some((value) => value !== undefined);
  return {
    ...(hasAddress ? { address } : {}),
    ...(companyRegistrationNumber === undefined ? {} : { companyRegistrationNumber }),
    ...(email === undefined ? {} : { email }),
    name: values.name.trim(),
    ...(phone === undefined ? {} : { phone }),
    ...(taxIdentificationNumber === undefined ? {} : { taxIdentificationNumber }),
    ...(website === undefined ? {} : { website }),
  };
};
