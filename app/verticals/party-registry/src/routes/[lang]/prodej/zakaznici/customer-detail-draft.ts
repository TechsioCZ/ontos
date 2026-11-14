// The one draft of the customer detail: every editable fact of the panel (name, identifiers, contact points) in one
// value, sent together by the one Save button as the separate fact commands the owner expects.
import { Option } from 'effect';
import type { CustomerFactChange } from './customers-data.ts';
import {
  contactFieldsInvalid,
  customerContactFields,
  customerContactInput,
  emptyCustomerContactFields,
} from './customers-model.ts';
import type { CustomerContactRow, CustomerIdentifierRow, CustomerParty } from './customers-model.ts';

/**
 * Field texts by key, and the revision each fact had when the draft was taken from the server. A dirty draft keeps
 * its revisions, so a save over someone else's change is refused by the owner instead of overwriting it.
 */
export interface CustomerDraft {
  readonly fields: Readonly<Record<string, string>>;
  readonly revisions: Readonly<Record<string, number>>;
}

export const NAME_KEY = 'name';
const PARTY_REVISION = 'party';
export const customerAddressFields = ['addressLine1', 'addressLine2', 'city', 'postalCode', 'region', 'countryCode'];

export const identifierDraftKey = (rowId: string): string => `identifier-${rowId}`;
export const contactDraftKey = (rowId: string, field: string): string => `${rowId}-${field}`;
const contactRevisionKey = (rowId: string): string => `contact:${rowId}`;

/** The fields of a contact row the detail shows. */
export const contactFieldNames = (type: CustomerContactRow['type']): readonly string[] =>
  type === 'ADDRESS' ? customerAddressFields : ['value'];

export const emptyCustomerDraft: CustomerDraft = { fields: {}, revisions: {} };

/** Rows of the detail that can be edited, as the owner snapshot has them. */
export interface CustomerDraftSource {
  readonly contactRows: readonly CustomerContactRow[];
  /** Whether a contact row may be edited by this reader (`customerContactEditable`). */
  readonly editableContact: (row: CustomerContactRow) => boolean;
  readonly identifierRows: readonly CustomerIdentifierRow[];
  readonly party: CustomerParty | undefined;
}

const contactOriginal = (row: CustomerContactRow) =>
  row.existing === undefined ? emptyCustomerContactFields(row.type) : customerContactFields(row.existing);

/** The server version of the draft: what every editable field shows while nothing is typed. */
export const customerDraftOf = ({
  contactRows,
  editableContact,
  identifierRows,
  party,
}: CustomerDraftSource): CustomerDraft => {
  if (party === undefined) {
    return emptyCustomerDraft;
  }
  // A name withheld from this reader (no identity capability) starts empty, like the field shows it.
  const name = party.displayName === undefined ? '' : Option.getOrElse(party.displayName, () => '');
  const editable = contactRows.filter((row) => editableContact(row));
  const contactFields = editable.flatMap((row) => {
    const original = contactOriginal(row);
    return contactFieldNames(row.type).map((field) => [contactDraftKey(row.id, field), original[field] ?? ''] as const);
  });
  const contactRevisions = editable.flatMap((row) =>
    row.existing === undefined ? [] : [[contactRevisionKey(row.id), row.existing.revision] as const],
  );
  return {
    fields: Object.fromEntries([
      [NAME_KEY, name],
      ...identifierRows.map((row) => [identifierDraftKey(row.id), row.existing?.normalizedValue ?? ''] as const),
      ...contactFields,
    ]),
    revisions: Object.fromEntries([[PARTY_REVISION, party.revision], ...contactRevisions]),
  };
};

const sameText = (left: string | undefined, right: string | undefined) => (left ?? '').trim() === (right ?? '').trim();

const sameKeys = <A>(
  left: Readonly<Record<string, A>>,
  right: Readonly<Record<string, A>>,
  same: (l?: A, r?: A) => boolean,
) => [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => same(left[key], right[key]));

/** Two drafts are the same when every field reads the same (surrounding spaces aside) and the bases match. */
export const sameCustomerDraft = (left: CustomerDraft, right: CustomerDraft): boolean =>
  sameKeys(left.fields, right.fields, sameText) && sameKeys(left.revisions, right.revisions, (l, r) => l === r);

const contactValues = (value: CustomerDraft, row: CustomerContactRow) => ({
  ...contactOriginal(row),
  ...Object.fromEntries(
    contactFieldNames(row.type).map((field) => [field, value.fields[contactDraftKey(row.id, field)] ?? '']),
  ),
});

const contactChanged = (value: CustomerDraft, confirmed: CustomerDraft, row: CustomerContactRow) =>
  contactFieldNames(row.type).some(
    (field) =>
      !sameText(value.fields[contactDraftKey(row.id, field)], confirmed.fields[contactDraftKey(row.id, field)]),
  );

/** One fact command of a save and the draft keys it writes. */
export interface CustomerDraftChange {
  readonly change: CustomerFactChange;
  readonly keys: readonly string[];
}

/** The draft is complete: a changed name is not empty and every changed contact point is usable. */
export const validCustomerDraft = (source: CustomerDraftSource) => (value: CustomerDraft, confirmed: CustomerDraft) =>
  !(
    NAME_KEY in value.fields &&
    !sameText(value.fields[NAME_KEY], confirmed.fields[NAME_KEY]) &&
    (value.fields[NAME_KEY] ?? '').trim() === ''
  ) &&
  source.contactRows.every(
    (row) =>
      !source.editableContact(row) ||
      !contactChanged(value, confirmed, row) ||
      !contactFieldsInvalid(row.type, contactValues(value, row)),
  );

/**
 * The fact commands that bring the server from `confirmed` to `value`, in the order the detail shows them. Each one
 * names the revision the draft was taken at, not the one the server has now.
 */
export const customerDraftChanges = (
  value: CustomerDraft,
  confirmed: CustomerDraft,
  source: CustomerDraftSource,
): readonly CustomerDraftChange[] => {
  const { party } = source;
  if (party === undefined) {
    return [];
  }
  const changes: CustomerDraftChange[] = [];
  const name = value.fields[NAME_KEY];
  if (name !== undefined && !sameText(name, confirmed.fields[NAME_KEY])) {
    const revision = value.revisions[PARTY_REVISION] ?? party.revision;
    changes.push({ change: { kind: 'name', party: { ...party, revision }, value: name.trim() }, keys: [NAME_KEY] });
  }
  for (const row of source.identifierRows) {
    const key = identifierDraftKey(row.id);
    const next = value.fields[key];
    if (next !== undefined && !sameText(next, confirmed.fields[key])) {
      changes.push({
        change: { existing: row.existing, identifierType: row.type, kind: 'identifier', value: next.trim() },
        keys: [key],
      });
    }
  }
  for (const row of source.contactRows) {
    if (source.editableContact(row) && contactChanged(value, confirmed, row)) {
      const revision = value.revisions[contactRevisionKey(row.id)];
      const existing =
        row.existing === undefined || revision === undefined ? row.existing : { ...row.existing, revision };
      changes.push({
        change: {
          existing,
          kind: 'contact',
          value: customerContactInput(row.type, contactValues(value, row), existing),
        },
        keys: contactFieldNames(row.type).map((field) => contactDraftKey(row.id, field)),
      });
    }
  }
  return changes;
};

/** `confirmed` with the keys a successful command wrote taken from `value`. */
export const withWritten = (
  confirmed: CustomerDraft,
  value: CustomerDraft,
  keys: readonly string[],
): CustomerDraft => ({
  fields: { ...confirmed.fields, ...Object.fromEntries(keys.map((key) => [key, value.fields[key] ?? ''])) },
  revisions: confirmed.revisions,
});

/** The keys whose text differs from `confirmed`: what is typed and not saved. */
export const changedCustomerFields = (
  value: CustomerDraft,
  confirmed: CustomerDraft,
): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(value.fields).filter(([key, text]) => !sameText(text, confirmed.fields[key])));
