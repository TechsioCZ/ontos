export const contactFieldNames = ['firstName', 'lastName', 'email', 'phone', 'jobTitle'] as const;

export type ContactFieldName = (typeof contactFieldNames)[number];

export interface ContactFormValues {
  readonly email: string;
  readonly firstName: string;
  readonly jobTitle: string;
  readonly lastName: string;
  readonly phone: string;
}

export type ContactFormIssueCode =
  | 'invalid_email'
  | 'name_required'
  | 'server_validation'
  | 'too_long';

export interface ContactFormIssue {
  readonly code: ContactFormIssueCode;
  readonly field?: ContactFieldName;
}

export interface ContactDetailModel {
  readonly contactId: string;
  readonly customerId: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly jobTitle: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly version: number;
}

export interface ContactListRowModel {
  readonly contactId: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly href: string;
  readonly jobTitle: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly selected: boolean;
}

export interface ContactPaginationModel {
  readonly nextHref?: string;
  readonly page: number;
}

export type ContactRouteValidationReason =
  | 'foreign_selection'
  | 'invalid_cursor'
  | 'invalid_page'
  | 'invalid_selection'
  | 'policy';

interface ContactPanelContext {
  readonly customerId: string;
  readonly customerName: string;
}

export type ContactPanelModel =
  | (ContactPanelContext & { readonly state: 'loading' })
  | (ContactPanelContext & {
      readonly pagination: ContactPaginationModel;
      readonly state: 'empty';
    })
  | (ContactPanelContext & {
      readonly reason: ContactRouteValidationReason;
      readonly resetHref: string;
      readonly state: 'validation';
    })
  | (ContactPanelContext & { readonly state: 'forbidden' })
  | (ContactPanelContext & { readonly state: 'not_found' })
  | (ContactPanelContext & { readonly retryHref: string; readonly state: 'conflict' })
  | (ContactPanelContext & { readonly retryHref: string; readonly state: 'unavailable' })
  | (ContactPanelContext & {
      readonly detail?: ContactDetailModel;
      readonly pagination: ContactPaginationModel;
      readonly rows: readonly ContactListRowModel[];
      readonly state: 'resolved';
    });

export type ContactMutationResult =
  | { readonly contact: ContactDetailModel; readonly state: 'success' }
  | { readonly issues: readonly ContactFormIssue[]; readonly state: 'validation' }
  | { readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable' };

export type ContactDeleteResult =
  | { readonly state: 'success' }
  | { readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable' };

export interface ContactPanelCopy {
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
    readonly description: (contactName: string) => string;
    readonly pending: string;
    readonly title: string;
  };
  readonly detail: {
    readonly heading: string;
    readonly notProvided: string;
    readonly selectPrompt: string;
  };
  readonly fields: Readonly<Record<ContactFieldName, string>>;
  readonly form: {
    readonly createTitle: string;
    readonly editTitle: string;
    readonly pending: string;
    readonly summary: string;
  };
  readonly heading: (customerName: string) => string;
  readonly issues: Readonly<Record<ContactFormIssueCode, string>>;
  readonly list: {
    readonly caption: string;
    readonly email: string;
    readonly jobTitle: string;
    readonly name: string;
    readonly page: (page: number) => string;
    readonly phone: string;
  };
  readonly nameFallback: string;
  readonly states: {
    readonly conflict: string;
    readonly empty: string;
    readonly forbidden: string;
    readonly loading: string;
    readonly notFound: string;
    readonly readOnly: string;
    readonly unavailable: string;
    readonly validation: Readonly<Record<ContactRouteValidationReason, string>>;
  };
  readonly toast: {
    readonly created: string;
    readonly deleted: string;
    readonly updated: string;
  };
}

export interface ContactPanelProps {
  readonly copy: ContactPanelCopy;
  readonly model: ContactPanelModel;
  readonly onCreate: (values: ContactFormValues) => Promise<ContactMutationResult>;
  readonly onDelete: (contact: ContactDetailModel) => Promise<ContactDeleteResult>;
  readonly onEdit: (
    contact: ContactDetailModel,
    values: ContactFormValues,
  ) => Promise<ContactMutationResult>;
  readonly onMutationSuccess: () => void;
  readonly onNavigate: (href: string) => void;
  readonly onRetry: () => void;
  readonly writable: boolean;
}

export const emptyContactFormValues: ContactFormValues = {
  email: '',
  firstName: '',
  jobTitle: '',
  lastName: '',
  phone: '',
};

const maximumLengths: Readonly<Record<ContactFieldName, number>> = {
  email: 320,
  firstName: 200,
  jobTitle: 200,
  lastName: 200,
  phone: 64,
};

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

export const validateContactForm = (values: ContactFormValues): readonly ContactFormIssue[] => {
  const issues: ContactFormIssue[] = [];
  if (values.firstName.trim().length === 0 && values.lastName.trim().length === 0) {
    issues.push({ code: 'name_required', field: 'firstName' });
  }
  for (const field of contactFieldNames) {
    if (values[field].trim().length > maximumLengths[field]) {
      issues.push({ code: 'too_long', field });
    }
  }
  if (values.email.trim().length > 0 && !isEmail(values.email.trim())) {
    issues.push({ code: 'invalid_email', field: 'email' });
  }
  return issues;
};

export const formatContactDisplayName = (
  contact: Pick<ContactDetailModel, 'firstName' | 'lastName'>,
  fallback: string,
): string => {
  const name = [contact.firstName?.trim(), contact.lastName?.trim()]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' ');
  return name.length === 0 ? fallback : name;
};

export const contactFormValuesFromDetail = (contact: ContactDetailModel): ContactFormValues => ({
  email: contact.email ?? '',
  firstName: contact.firstName ?? '',
  jobTitle: contact.jobTitle ?? '',
  lastName: contact.lastName ?? '',
  phone: contact.phone ?? '',
});

const optionalValue = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

export const contactFormToWritableFields = (values: ContactFormValues) => {
  const email = optionalValue(values.email);
  const firstName = optionalValue(values.firstName);
  const jobTitle = optionalValue(values.jobTitle);
  const lastName = optionalValue(values.lastName);
  const phone = optionalValue(values.phone);
  return {
    ...(email === undefined ? {} : { email }),
    ...(firstName === undefined ? {} : { firstName }),
    ...(jobTitle === undefined ? {} : { jobTitle }),
    ...(lastName === undefined ? {} : { lastName }),
    ...(phone === undefined ? {} : { phone }),
  };
};
