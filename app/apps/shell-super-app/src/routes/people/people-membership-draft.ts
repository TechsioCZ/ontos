// The company-membership fields of a person: how a draft of them is compared, and when it may be saved.
import { Option } from 'effect';
import type { SetPeopleCompanyMembershipRequest } from '../../../shared/people-api.ts';

/** `null` is only for an AI agent: it has neither an employee nor an external affiliation. */
type Affiliation = NonNullable<SetPeopleCompanyMembershipRequest['affiliation']>;
type Status = SetPeopleCompanyMembershipRequest['status'];

export interface MembershipDraft {
  readonly affiliation: Affiliation;
  readonly reason: string;
  readonly status: Status;
}

/** What the server last confirmed for this person's membership (`null` affiliation for an AI agent). */
export interface MembershipBase {
  readonly affiliation: Affiliation | null;
  readonly status: Status;
}

export interface MembershipEdit {
  readonly affiliation: Affiliation;
  readonly reason: string;
  readonly status: Status;
}

/** The membership the server confirmed for this person (`null` affiliation for an AI agent). */
export const baseOf = (person: {
  readonly selectedCompanyMembership?: { readonly affiliation: Affiliation | null; readonly status: Status } | null;
}): MembershipBase => ({
  affiliation: person.selectedCompanyMembership?.affiliation ?? null,
  status: person.selectedCompanyMembership?.status ?? 'invited',
});

export const membershipDraftOf = (base: MembershipBase): MembershipDraft => ({
  affiliation: base.affiliation ?? 'external',
  reason: '',
  status: base.status,
});

export const sameMembershipDraft = (left: MembershipDraft, right: MembershipDraft): boolean =>
  left.affiliation === right.affiliation && left.status === right.status && left.reason.trim() === right.reason.trim();

/**
 * The change a draft asks for. Every membership change is audited, so a draft with no reason, or with the
 * membership the server already has, is never sent.
 */
export const membershipEditOf = (draft: MembershipDraft, base: MembershipBase): Option.Option<MembershipEdit> => {
  const reason = draft.reason.trim();
  const changed = draft.affiliation !== (base.affiliation ?? 'external') || draft.status !== base.status;
  return reason === '' || !changed
    ? Option.none()
    : Option.some({ affiliation: draft.affiliation, reason, status: draft.status });
};
