const EMAIL_MAX_LENGTH = 254;
const EMAIL_LOCAL_PART_MAX_LENGTH = 64;
const EMAIL_DOMAIN_MAX_LENGTH = 253;
const EMAIL_DOMAIN_LABEL_MAX_LENGTH = 63;

const localAtomPattern = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/u;
const domainLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;

export interface EmailValueInvalid {
  readonly _tag: 'Invalid';
  readonly message: string;
}

export interface EmailValueValid {
  readonly _tag: 'Valid';
  readonly normalizedValue: string;
  readonly value: string;
}

export interface EmailValueEmpty {
  readonly _tag: 'Empty';
}

export type ParsedEmailValue = EmailValueEmpty | EmailValueInvalid | EmailValueValid;

const invalidEmail = (): EmailValueInvalid => ({
  _tag: 'Invalid',
  message: 'Enter one valid email address.',
});

export const parseEmailValue = (input: string): ParsedEmailValue => {
  const value = input.trim();
  if (value.length === 0) {
    return { _tag: 'Empty' };
  }
  if (value.length > EMAIL_MAX_LENGTH || !/^[\u0021-\u007E]+$/u.test(value)) {
    return invalidEmail();
  }

  const atIndex = value.indexOf('@');
  if (atIndex <= 0 || atIndex !== value.lastIndexOf('@')) {
    return invalidEmail();
  }

  const localPart = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  const localAtoms = localPart.split('.');
  const domainLabels = domain.split('.');
  if (
    localPart.length > EMAIL_LOCAL_PART_MAX_LENGTH ||
    domain.length === 0 ||
    domain.length > EMAIL_DOMAIN_MAX_LENGTH ||
    localAtoms.some((atom) => atom.length === 0 || !localAtomPattern.test(atom)) ||
    domainLabels.length < 2 ||
    domainLabels.some(
      (label) =>
        label.length === 0 ||
        label.length > EMAIL_DOMAIN_LABEL_MAX_LENGTH ||
        !domainLabelPattern.test(label),
    )
  ) {
    return invalidEmail();
  }

  return {
    _tag: 'Valid',
    normalizedValue: value.toLowerCase(),
    value,
  };
};

export const emailMailtoHref = (value: string): string | undefined => {
  const parsed = parseEmailValue(value);
  return parsed._tag === 'Valid'
    ? `mailto:${encodeURIComponent(parsed.value).replaceAll(
        /[!'()*]/gu,
        (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase()}`,
      )}`
    : undefined;
};
