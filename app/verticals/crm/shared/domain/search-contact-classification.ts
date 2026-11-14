/**
 * Owner-approved CRM record lookup. Client/company email and phone are business contact fields.
 * A contact person's email and phone are personal data used only to find that contact's CRM record.
 * Neither classification grants access: the current CRM records projection and Core resource gate still apply.
 * Only the record name/ref/company may leave search. Contact values must not enter result snippets, metadata
 * or aliases. Notes and other free text are excluded, even when they contain an email or phone.
 */
export const crmSearchContactClassification = {
  client: {
    classification: 'business_contact',
    disclosure: 'search_only',
    excludedFields: ['note'],
    purpose: 'authorized_crm_record_lookup',
    searchableFields: ['email', 'phone'],
  },
  contact: {
    classification: 'contact_personal_data',
    disclosure: 'search_only',
    excludedFields: ['note'],
    purpose: 'authorized_crm_record_lookup',
    searchableFields: ['email', 'phone'],
  },
} as const;

/** Accept only a whole phone-shaped value, never remove letters or punctuation from arbitrary text. */
const phoneDigits = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!/^\+?[0-9][0-9 ().\u00A0-]*$/u.test(trimmed)) {
    return undefined;
  }
  const digits = trimmed.replaceAll(/[ ().\u00A0-]/gu, '').replace(/^\+/u, '');
  return /^[0-9]{3,15}$/u.test(digits) ? digits : undefined;
};

/**
 * Core's matching stays unchanged. CRM canonicalizes only phone-shaped queries, including prefixes.
 * International digits retain their country code; +420 is not stripped from the query.
 */
export const crmSearchQuery = (query: string): string => phoneDigits(query) ?? query;

const phoneSearchTerms = (value: string): readonly string[] => {
  const digits = phoneDigits(value);
  if (digits === undefined) {
    return [];
  }
  if (/^420[2-9][0-9]{8}$/u.test(digits)) {
    return [digits, digits.slice(3)];
  }
  // Only an unprefixed, complete Czech local number receives the Czech country code.
  if (!value.trim().startsWith('+') && /^[2-9][0-9]{8}$/u.test(digits)) {
    return [`420${digits}`, digits];
  }
  return [digits];
};

/** The classification's explicit field allowlist is the projection's only contact-value input. */
export const crmContactSearchTerms = (
  kind: keyof typeof crmSearchContactClassification,
  values: { readonly email?: string; readonly phone?: string },
): readonly string[] =>
  crmSearchContactClassification[kind].searchableFields.flatMap((field) => {
    const value = values[field]?.trim();
    if (value === undefined || value.length === 0) {
      return [];
    }
    if (field === 'phone') {
      return phoneSearchTerms(value);
    }
    return /^[^\s@]+@[^\s@]+$/u.test(value) ? [value.toLowerCase()] : [];
  });
