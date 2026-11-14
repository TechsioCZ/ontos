// The commercial terms form of one contract: what the terms panel saves with its Save button.
import type { RevisionedSaveResult } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { Effect, Option, Predicate, Schema } from 'effect';
import type { AgreementsCommand } from '../../../../shared/actions/apply-command.ts';
import type { Contract } from '../../../../shared/apis/records.ts';

export type ContractTermsCommand = Extract<AgreementsCommand, { readonly _tag: 'SetContractTerms' }>;
type MutableContractTermsCommand = { -readonly [Field in keyof ContractTermsCommand]: ContractTermsCommand[Field] };

/** The fields as typed. Amounts are in crowns; an empty monthly rent means a contract without an agreed amount. */
export interface TermsDraft {
  readonly monthly: string;
  readonly noticePeriod: string;
  readonly paymentDay: string;
  readonly responsiblePerson: string;
  readonly service: string;
  readonly subject: string;
}

const crowns = (minor: number) => (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2));

/** Whole crowns or crowns with up to two decimals, with spaces and a decimal comma allowed. */
export const parseCrowns = (value: string) => {
  const normalized = value.replaceAll(/\s/gu, '').replace(',', '.');
  return /^\d+(?:\.\d{1,2})?$/u.test(normalized) ? Math.round(Number(normalized) * 100) : undefined;
};

const optionalText = (value: string) => (value.trim().length === 0 ? undefined : value.trim());

export const termsDraftOf = (contract: Contract): TermsDraft => ({
  monthly: contract.rentTerms === undefined ? '' : crowns(contract.rentTerms.monthlyRentMinor),
  noticePeriod: contract.noticePeriod ?? '',
  paymentDay: String(contract.rentTerms?.paymentDay ?? 15),
  responsiblePerson: contract.responsiblePerson ?? '',
  service: contract.rentTerms === undefined ? '' : crowns(contract.rentTerms.serviceChargesMinor),
  subject: contract.subject ?? '',
});

/** Drafts that store the same terms: surrounding spaces do not count. */
export const sameTermsDraft = (left: TermsDraft, right: TermsDraft): boolean =>
  left.monthly.trim() === right.monthly.trim() &&
  left.noticePeriod.trim() === right.noticePeriod.trim() &&
  left.paymentDay.trim() === right.paymentDay.trim() &&
  left.responsiblePerson.trim() === right.responsiblePerson.trim() &&
  left.service.trim() === right.service.trim() &&
  left.subject.trim() === right.subject.trim();

export interface TermsProblems {
  readonly monthly: boolean;
  readonly paymentDay: boolean;
  readonly service: boolean;
}

/** The rent fields count only once a monthly rent is filled in. */
export const termsProblems = (draft: TermsDraft): TermsProblems => {
  if (draft.monthly.trim().length === 0) {
    return { monthly: false, paymentDay: false, service: false };
  }
  const paymentDay = Number(draft.paymentDay);
  return {
    monthly: parseCrowns(draft.monthly) === undefined,
    paymentDay: !Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31,
    service: draft.service.trim().length > 0 && parseCrowns(draft.service) === undefined,
  };
};

/** The command a draft sends; None while a rent field is invalid, so an invalid draft is never saved. */
export const termsCommandOf = (
  contractRef: Contract['contractRef'],
  draft: TermsDraft,
): Option.Option<ContractTermsCommand> => {
  const problems = termsProblems(draft);
  if (problems.monthly || problems.paymentDay || problems.service) {
    return Option.none();
  }
  // Omitted fields clear the stored ones.
  const command: MutableContractTermsCommand = { _tag: 'SetContractTerms', contractRef };
  const subject = optionalText(draft.subject);
  const responsiblePerson = optionalText(draft.responsiblePerson);
  const noticePeriod = optionalText(draft.noticePeriod);
  if (subject !== undefined) {
    command.subject = subject;
  }
  if (responsiblePerson !== undefined) {
    command.responsiblePerson = responsiblePerson;
  }
  if (noticePeriod !== undefined) {
    command.noticePeriod = noticePeriod;
  }
  const monthlyRentMinor = parseCrowns(draft.monthly);
  const serviceChargesMinor = draft.service.trim().length === 0 ? 0 : parseCrowns(draft.service);
  if (monthlyRentMinor !== undefined && serviceChargesMinor !== undefined) {
    command.rentTerms = {
      currency: 'CZK',
      monthlyRentMinor,
      paymentDay: Number(draft.paymentDay),
      serviceChargesMinor,
    };
  }
  return Option.some(command);
};

/**
 * Whether the records still hold the contract's terms as the draft's base version. The revision covers every
 * agreement, so a conflict caused by another contract is resent; a change of these terms is a conflict.
 */
export const termsUnchangedSince =
  (resourceId: string, base: TermsDraft) =>
  (contracts: readonly Contract[]): boolean => {
    const current = contracts.find((contract) => contract.contractRef.resourceId === resourceId);
    return current !== undefined && sameTermsDraft(termsDraftOf(current), base);
  };

/**
 * One save of the terms panel: the new revision once saved, `conflict` for a revision conflict, `proposed` for a change
 * parked for approval (nothing is saved yet, `onProposal` hears of it), else `failed`.
 */
export const termsSaveResult = <E>(
  write: Effect.Effect<{ readonly revision: number } | ActionProposalAccepted, E>,
  onProposal?: (proposal: ActionProposalAccepted) => void,
): Effect.Effect<RevisionedSaveResult> =>
  write.pipe(
    Effect.match({
      onFailure: (error): RevisionedSaveResult =>
        Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') &&
        Predicate.hasProperty(error, 'code') &&
        error.code === 'agreements_conflict'
          ? 'conflict'
          : 'failed',
      onSuccess: (result): RevisionedSaveResult => {
        if (Schema.is(ActionProposalAcceptedSchema)(result)) {
          onProposal?.(result);
          return 'proposed';
        }
        return result.revision;
      },
    }),
  );
