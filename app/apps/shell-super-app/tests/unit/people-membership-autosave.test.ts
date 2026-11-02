import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  baseOf,
  membershipDraftOf,
  membershipEditOf,
  sameMembershipDraft,
} from '../../src/routes/people/people-membership-draft.ts';

const base = { affiliation: 'employee', status: 'active' } as const;

describe('people membership autosave draft', () => {
  it('starts from the membership the server has, and from the defaults when there is none', () => {
    expect(membershipDraftOf(base)).toEqual({ affiliation: 'employee', reason: '', status: 'active' });
    expect(baseOf({})).toEqual({ affiliation: null, status: 'invited' });
    expect(baseOf({ selectedCompanyMembership: { affiliation: null, status: 'disabled' } })).toEqual({
      affiliation: null,
      status: 'disabled',
    });
  });

  it('never sends a change without a reason, and never sends the membership it already has', () => {
    const draft = membershipDraftOf(base);
    expect(Option.isNone(membershipEditOf(draft, base))).toBe(true);
    expect(Option.isNone(membershipEditOf({ ...draft, reason: '   ' }, base))).toBe(true);
    expect(Option.isNone(membershipEditOf({ ...draft, reason: 'Nástup' }, base))).toBe(true);
    expect(Option.getOrThrow(membershipEditOf({ ...draft, reason: ' Odchod ', status: 'departed' }, base))).toEqual({
      affiliation: 'employee',
      reason: 'Odchod',
      status: 'departed',
    });
  });

  it('counts only the status for an agent, and ignores surrounding spaces in the reason', () => {
    const agent = { affiliation: null, status: 'invited' } as const;
    const agentDraft = membershipDraftOf(agent);
    expect(Option.isNone(membershipEditOf({ ...agentDraft, reason: 'Nástup' }, agent))).toBe(true);
    expect(Option.isSome(membershipEditOf({ ...agentDraft, reason: 'Nástup', status: 'active' }, agent))).toBe(true);
    expect(sameMembershipDraft({ ...agentDraft, reason: 'Nástup' }, { ...agentDraft, reason: ' Nástup ' })).toBe(true);
    expect(sameMembershipDraft(agentDraft, { ...agentDraft, status: 'active' })).toBe(false);
  });
});
