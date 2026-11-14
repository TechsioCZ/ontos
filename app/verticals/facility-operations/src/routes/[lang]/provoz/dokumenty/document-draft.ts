// The documents form's values: a new or amended document is submitted once, an edit is sent on Uložit.
import { Option } from 'effect';
import type { Types } from 'effect';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import { documentLinks } from '../../../../../shared/domain/documents.ts';
import type {
  ContractStatus,
  ContractTerms,
  DocumentRecord,
  SubjectRef,
} from '../../../../../shared/domain/documents.ts';

export const NONE = '__none__';

type DocumentUpdateCommand = Extract<OpsCommand, { readonly _tag: 'DocumentUpdate' }>;

export interface ContractDraft {
  readonly amountTerms: string;
  readonly contractType: string;
  readonly noticeDateInput: string;
  readonly noticePeriod: string;
  readonly owner: string;
  readonly parties: string;
  readonly status: ContractStatus;
  readonly subject: string;
  readonly validFromInput: string;
  readonly validToInput: string;
}

export const emptyContract: ContractDraft = {
  amountTerms: '',
  contractType: '',
  noticeDateInput: '',
  noticePeriod: '',
  owner: '',
  parties: '',
  status: 'draft',
  subject: '',
  validFromInput: '',
  validToInput: '',
};

export const contractDraftOf = (terms: ContractTerms | undefined): ContractDraft =>
  terms === undefined
    ? emptyContract
    : {
        amountTerms: terms.amountTerms ?? '',
        contractType: terms.contractType,
        noticeDateInput: terms.noticeDate ?? '',
        noticePeriod: terms.noticePeriod ?? '',
        owner: terms.owner,
        parties: terms.parties.join('\n'),
        status: terms.status,
        subject: terms.subject ?? '',
        validFromInput: terms.validFrom ?? '',
        validToInput: terms.validTo ?? '',
      };

/** The stored terms of a draft; undefined until the type, the owner and at least one party are filled in. */
export const contractOf = (draft: ContractDraft): ContractTerms | undefined => {
  const parties = draft.parties
    .split('\n')
    .map((party) => party.trim())
    .filter((party) => party !== '');
  if (draft.contractType.trim() === '' || draft.owner.trim() === '' || parties.length === 0) {
    return undefined;
  }
  const terms: Types.Mutable<ContractTerms> = {
    contractType: draft.contractType.trim(),
    owner: draft.owner.trim(),
    parties,
    status: draft.status,
  };
  // Blank optional texts stay absent, so the stored value is replaced only by what the user typed.
  const subject = draft.subject.trim();
  if (subject !== '') {
    terms.subject = subject;
  }
  const validFrom = draft.validFromInput.trim();
  if (validFrom !== '') {
    terms.validFrom = validFrom;
  }
  const validTo = draft.validToInput.trim();
  if (validTo !== '') {
    terms.validTo = validTo;
  }
  const amountTerms = draft.amountTerms.trim();
  if (amountTerms !== '') {
    terms.amountTerms = amountTerms;
  }
  const noticePeriod = draft.noticePeriod.trim();
  if (noticePeriod !== '') {
    terms.noticePeriod = noticePeriod;
  }
  const noticeDate = draft.noticeDateInput.trim();
  if (noticeDate !== '') {
    terms.noticeDate = noticeDate;
  }
  return terms;
};

export const isContractCategory = (category: string) => category === 'contract' || category === 'amendment';

export const sameContractDraft = (left: ContractDraft, right: ContractDraft): boolean =>
  left.amountTerms.trim() === right.amountTerms.trim() &&
  left.contractType.trim() === right.contractType.trim() &&
  left.noticeDateInput.trim() === right.noticeDateInput.trim() &&
  left.noticePeriod.trim() === right.noticePeriod.trim() &&
  left.owner.trim() === right.owner.trim() &&
  left.parties.trim() === right.parties.trim() &&
  left.status === right.status &&
  left.subject.trim() === right.subject.trim() &&
  left.validFromInput.trim() === right.validFromInput.trim() &&
  left.validToInput.trim() === right.validToInput.trim();

/** One document as its edit panel holds it. */
export interface DocumentEditDraft {
  readonly category: string;
  readonly contract: ContractDraft;
  readonly description: string;
  readonly links: readonly SubjectRef[];
  readonly title: string;
}

export const documentEditDraftOf = (document: DocumentRecord): DocumentEditDraft => ({
  category: document.category,
  contract: contractDraftOf(document.contract),
  description: document.description ?? '',
  links: documentLinks(document),
  title: document.title,
});

const sameLinks = (left: readonly SubjectRef[], right: readonly SubjectRef[]): boolean =>
  left.length === right.length &&
  left.every((link, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      link.kind === other.kind &&
      link.id === other.id &&
      link.label.trim() === other.label.trim()
    );
  });

/** Drafts that store the same document: surrounding spaces do not count. */
export const sameDocumentEditDraft = (left: DocumentEditDraft, right: DocumentEditDraft): boolean =>
  left.category === right.category &&
  left.description.trim() === right.description.trim() &&
  left.title.trim() === right.title.trim() &&
  sameContractDraft(left.contract, right.contract) &&
  sameLinks(left.links, right.links);

export interface DocumentEditProblems {
  /** A contract category needs its terms; a contract without a type, owner or party cannot be stored. */
  readonly contract: boolean;
  readonly title: boolean;
}

export const documentEditProblems = (draft: DocumentEditDraft): DocumentEditProblems => ({
  contract: isContractCategory(draft.category) && contractOf(draft.contract) === undefined,
  title: draft.title.trim() === '',
});

/** The update an edit sends; None while a field is invalid, so an invalid draft is never saved. */
export const documentUpdateCommandOf = (
  documentId: DocumentRecord['id'],
  draft: DocumentEditDraft,
): Option.Option<OpsCommand> => {
  const problems = documentEditProblems(draft);
  if (problems.title || problems.contract) {
    return Option.none();
  }
  const command: Types.Mutable<DocumentUpdateCommand> = {
    _tag: 'DocumentUpdate',
    category: draft.category,
    documentId,
    links: [...draft.links],
    title: draft.title.trim(),
  };
  const description = draft.description.trim();
  if (description !== '') {
    command.description = description;
  }
  const terms = isContractCategory(draft.category) ? contractOf(draft.contract) : undefined;
  if (terms !== undefined) {
    command.contract = terms;
  }
  return Option.some(command);
};
