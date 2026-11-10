// The draft of the contract form: a new contract, or the period of a draft contract. Pure, so the form and its
// tests share one definition of what is sent.
import { Option, Schema } from 'effect';
import type { AgreementsCommand } from '../../../../shared/actions/apply-command.ts';
import { ContractSchema } from '../../../../shared/apis/records.ts';
import type { Contract } from '../../../../shared/apis/records.ts';

export const DEFAULT_START_DATE = '2026-10-05';
export const DEFAULT_END_DATE = '2027-10-05';

/** The new-contract form as typed. A lease takes its party and unit from the chosen occupancy. */
/** A typed calendar date; empty while the field is. */
type DateInput = Contract['startDate'];

export interface CreateDraft {
  readonly customerId: string;
  readonly endDate: DateInput;
  readonly kind: Contract['kind'];
  readonly occupancyId: string;
  readonly startDate: DateInput;
}

export const createDraftOf = (kind: Contract['kind']): CreateDraft => ({
  customerId: '',
  endDate: DEFAULT_END_DATE,
  kind,
  occupancyId: '',
  startDate: DEFAULT_START_DATE,
});

/**
 * The period form of a draft contract. `record` is the contract as read when the draft was taken: the command is
 * built from it, so a newer read never slips other people's changes (or reverts them) into this save.
 */
export interface PeriodDraft {
  readonly endDate: DateInput;
  readonly record: Contract;
  readonly startDate: DateInput;
}

const sameContract = Schema.toEquivalence(ContractSchema);

/** Owner modules a contract refers to; a command about it carries a reference credential for each. */
export const contractReferenceAudiences = (record: Contract | undefined) => {
  const audiences = ['party-registry'];
  if (record !== undefined && record.unitRef !== null) {
    audiences.push('property-portfolio', 'property-portfolio');
  }
  if (record !== undefined && record.occupancyRef !== null) {
    audiences.push('property-leasing');
  }
  return audiences;
};

type CommercialTerms = Pick<Contract, 'noticePeriod' | 'rentTerms' | 'responsiblePerson' | 'subject'>;
type MutableCommercialTerms = { -readonly [Field in keyof CommercialTerms]: CommercialTerms[Field] };

/** The optional commercial terms of a contract, carried over when a draft is edited or a contract renewed. */
export const contractTerms = (record: Contract): CommercialTerms => {
  const terms: MutableCommercialTerms = {};
  if (record.noticePeriod !== undefined) {
    terms.noticePeriod = record.noticePeriod;
  }
  if (record.rentTerms !== undefined) {
    terms.rentTerms = record.rentTerms;
  }
  if (record.responsiblePerson !== undefined) {
    terms.responsiblePerson = record.responsiblePerson;
  }
  if (record.subject !== undefined) {
    terms.subject = record.subject;
  }
  return terms;
};

export const periodDraftOf = (record: Contract): PeriodDraft => ({
  endDate: record.endDate ?? '',
  record,
  startDate: record.startDate,
});

/**
 * Drafts with the same period over the same contract. The contract's own period does not count: after this form's
 * save the server holds the saved period, and that is the same draft.
 */
export const samePeriodDraft = (left: PeriodDraft, right: PeriodDraft): boolean =>
  left.startDate === right.startDate &&
  left.endDate === right.endDate &&
  sameContract(left.record, { ...right.record, endDate: left.record.endDate, startDate: left.record.startDate });

/** A period is sent once it has a start; the owner checks the rest. */
export const validPeriod = (draft: { readonly startDate: DateInput }): boolean => draft.startDate.length > 0;

/** Only a draft contract that was never sent for signature can change its period. */
export const editableDraft = (record: Contract): boolean =>
  record.lifecycleState === 'DRAFT' && record.signatureState === 'NOT_SENT';

/** The command of a period save: the contract as read, with the typed period. */
export const updatePeriodCommand = (draft: PeriodDraft): AgreementsCommand => {
  const { record } = draft;
  return {
    _tag: 'UpdateContract',
    record: {
      ...contractTerms(record),
      contractRef: record.contractRef,
      counterpartyRef: record.counterpartyRef,
      endDate: draft.endDate || null,
      kind: record.kind,
      lifecycleState: record.lifecycleState,
      note: record.note,
      occupancyRef: record.occupancyRef,
      propertyRef: record.propertyRef,
      renewalNoticeDate: record.renewalNoticeDate,
      signatureState: record.signatureState,
      startDate: draft.startDate,
      supersedesContractRef: record.supersedesContractRef,
      unitRef: record.unitRef,
    },
  };
};

/**
 * Whether fresh agreements still hold the contract as this draft's last confirmed version: the contract it was read
 * from, with the period the draft last saved. Anything else is someone else's change and stays a conflict.
 */
export const periodUnchangedSince =
  (confirmed: PeriodDraft) =>
  (contracts: readonly Contract[]): boolean => {
    const current = contracts.find(
      (contract) => contract.contractRef.resourceId === confirmed.record.contractRef.resourceId,
    );
    return (
      current !== undefined &&
      sameContract(current, {
        ...confirmed.record,
        endDate: confirmed.endDate || null,
        startDate: confirmed.startDate,
      })
    );
  };

/** What a new contract refers to, as the page read it. */
export interface CreateReferences {
  readonly customers: readonly {
    readonly counterpartyRef: Contract['counterpartyRef'];
    readonly partyId: string;
    readonly status: string;
  }[];
  readonly occupancies: readonly {
    readonly customerCounterpartyRef: Contract['counterpartyRef'] | null;
    readonly occupancyRef: NonNullable<Contract['occupancyRef']>;
    readonly unitRef: NonNullable<Contract['unitRef']>;
  }[];
  readonly units: readonly {
    readonly propertyRef: NonNullable<Contract['propertyRef']>;
    readonly unitRef: NonNullable<Contract['unitRef']>;
  }[];
}

interface NewContractParty {
  readonly counterpartyRef: Contract['counterpartyRef'];
  readonly occupancyRef: Contract['occupancyRef'];
  readonly propertyRef: Contract['propertyRef'];
  readonly unitRef: Contract['unitRef'];
}

/**
 * Who and what a new contract binds: an active customer for other contracts, the tenant and unit of the chosen
 * occupancy for leases. None while the draft lacks them.
 */
const partyOf = (draft: CreateDraft, references: CreateReferences): Option.Option<NewContractParty> => {
  if (draft.kind === 'OTHER') {
    const customer = references.customers.find(
      (record) => record.partyId === draft.customerId && record.status === 'ACTIVE',
    );
    return customer === undefined
      ? Option.none()
      : Option.some({
          counterpartyRef: customer.counterpartyRef,
          occupancyRef: null,
          propertyRef: null,
          unitRef: null,
        });
  }
  const occupancy = references.occupancies.find((record) => record.occupancyRef.resourceId === draft.occupancyId);
  const unit = references.units.find((record) => record.unitRef.resourceId === occupancy?.unitRef.resourceId);
  return occupancy === undefined || unit === undefined || occupancy.customerCounterpartyRef === null
    ? Option.none()
    : Option.some({
        counterpartyRef: occupancy.customerCounterpartyRef,
        occupancyRef: occupancy.occupancyRef,
        propertyRef: unit.propertyRef,
        unitRef: occupancy.unitRef,
      });
};

/** Whether the draft can be sent; the Save button stays disabled until it can. */
export const createDraftComplete = (draft: CreateDraft, references: CreateReferences): boolean =>
  validPeriod(draft) && Option.isSome(partyOf(draft, references));

/** The record of a new draft contract, or None while the draft lacks its party. */
export const newContractRecord = (
  draft: CreateDraft,
  references: CreateReferences,
  resourceId: string,
): Option.Option<Contract> =>
  Option.map(partyOf(draft, references), (party) => ({
    ...party,
    contractRef: {
      moduleId: 'legal.agreements',
      resourceId,
      resourceType: 'legal.agreements.contract',
      tenantId: party.counterpartyRef.tenantId,
    },
    endDate: draft.endDate || null,
    kind: draft.kind,
    lifecycleState: 'DRAFT',
    note: null,
    renewalNoticeDate: null,
    signatureState: 'NOT_SENT',
    startDate: draft.startDate,
    supersedesContractRef: null,
  }));
