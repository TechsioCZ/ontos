// The editable fields of a CRM client and how a draft of them is compared, validated and turned into a patch.
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';

type Kind = Client['kind'];

export interface Draft {
  readonly address: string;
  readonly email: string;
  readonly kind: Kind;
  readonly name: string;
  readonly note: string;
  readonly owner: string;
  readonly phone: string;
  readonly regNo: string;
  readonly segment: string;
  readonly vatNo: string;
  readonly website: string;
}

export const NONE = 'none';
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const draftOf = (client: Client | undefined, defaultOwner: string): Draft => {
  if (client === undefined) {
    return {
      address: '',
      email: '',
      kind: 'organization',
      name: '',
      note: '',
      owner: defaultOwner,
      phone: '',
      regNo: '',
      segment: NONE,
      vatNo: '',
      website: '',
    };
  }
  return {
    address: client.address ?? '',
    email: client.email ?? '',
    kind: client.kind,
    name: client.name,
    note: client.note ?? '',
    owner: client.ownerSalespersonId ?? defaultOwner,
    phone: client.phone ?? '',
    regNo: client.regNo ?? '',
    segment: client.segment ?? NONE,
    vatNo: client.vatNo ?? '',
    website: client.website ?? '',
  };
};

/** Two drafts that would be saved the same (the server trims every text). */
const draftFields = [
  'address',
  'email',
  'kind',
  'name',
  'note',
  'owner',
  'phone',
  'regNo',
  'segment',
  'vatNo',
  'website',
] as const satisfies readonly (keyof Draft)[];
export const sameClientDraft = (left: Draft, right: Draft): boolean =>
  draftFields.every((key) => left[key].trim() === right[key].trim());

/** Whether an edited client can be saved: name filled, e-mail and IČO well-formed. */
export const validClientDraft = (draft: Draft): boolean =>
  draft.name.trim() !== '' &&
  (draft.email.trim() === '' || EMAIL.test(draft.email.trim())) &&
  (draft.kind !== 'organization' || draft.regNo.trim() === '' || /^\d{8}$/u.test(draft.regNo.trim()));

/** Only the fields that differ; `''` clears a field on the server. */
export const patchOf = (draft: Draft, client: Client) => {
  type Patch = Extract<CrmCommandInput, { readonly _tag: 'UpdateClient' }>['patch'];
  const patch: Patch = {};
  const compare = (key: Exclude<keyof Patch, 'kind'>, value: string) => {
    if (value.trim() !== (client[key] ?? '')) {
      Object.assign(patch, { [key]: value.trim() });
    }
  };
  compare('name', draft.name);
  compare('address', draft.address);
  compare('email', draft.email);
  compare('phone', draft.phone);
  compare('website', draft.website);
  compare('note', draft.note);
  compare('regNo', draft.kind === 'organization' ? draft.regNo : '');
  compare('vatNo', draft.kind === 'organization' ? draft.vatNo : '');
  compare('segment', draft.segment === NONE ? '' : draft.segment);
  if (draft.kind !== client.kind) {
    Object.assign(patch, { kind: draft.kind });
  }
  return patch;
};
