// A received invoice as its form holds it until Uložit, with its attached document.
import type { Invoice } from '../../../../shared/apis/records.ts';
import { addCalendarDaysTo } from '../../../../shared/domain/finance-planning.ts';
import { draftTotals, lineIssue, newDraftLine, toInvoiceLine } from '../../../../shared/domain/invoice-draft.ts';
import type { DraftLine } from '../../../../shared/domain/invoice-draft.ts';
import type { FinanceCommandDraft, FinanceViewModel, PreparedUpload } from './finance-ui.tsx';
import { emptyObjectSelection, objectAnchors } from './object-fields.tsx';
import type { ObjectSelection } from './object-fields.tsx';

export const BUDGET_CATEGORIES = [
  'Energie',
  'Údržba a opravy',
  'Úklid a odpady',
  'Služby a správa',
  'Pojištění',
  'Marketing',
  'Nájemné',
  'Ubytování',
  'Ostatní',
] as const;

export interface IncomingFile {
  readonly size: number;
  readonly upload: PreparedUpload;
}

export interface IncomingDraft {
  readonly category: string;
  readonly documentNumber: string;
  readonly dueDate: Invoice['dueDate'];
  /** The picked PDF or scan; it is stored together with the invoice on Uložit. */
  readonly file: IncomingFile | null;
  readonly issueDate: Invoice['issueDate'];
  readonly lines: readonly DraftLine[];
  readonly note: string;
  readonly object: ObjectSelection;
  readonly supplierCompanyId: string;
  readonly supplierName: string;
}

export const emptyIncomingDraft = (today: string): IncomingDraft => ({
  category: 'Energie',
  documentNumber: '',
  dueDate: addCalendarDaysTo(today, 14),
  file: null,
  issueDate: today,
  lines: [newDraftLine('incoming-line-1', 'free')],
  note: '',
  object: emptyObjectSelection,
  supplierCompanyId: '',
  supplierName: '',
});

/** Why the draft cannot be saved yet, or undefined when it can. */
export const incomingProblem = (draft: IncomingDraft): string | undefined => {
  const totals = draftTotals(draft.lines);
  if (draft.supplierName.trim() === '' || draft.documentNumber.trim() === '') {
    return 'Vyplňte dodavatele a číslo dokladu.';
  }
  if (draft.lines.some((line) => lineIssue(line) !== undefined)) {
    return 'Doplňte u každé položky popis, množství, cenu bez DPH a sazbu DPH.';
  }
  if (totals === undefined || totals.totalMinor === 0) {
    return 'Součet položek musí být kladná částka.';
  }
  return draft.dueDate < draft.issueDate ? 'Splatnost nesmí být dřív než datum vystavení.' : undefined;
};

/** RecordIncomingInvoice for a valid draft; undefined while `incomingProblem` reports something. */
export const incomingCommandOf = (
  draft: IncomingDraft,
  vm: Pick<FinanceViewModel, 'actorLabel' | 'objects'>,
): FinanceCommandDraft<'RecordIncomingInvoice'> | undefined => {
  const totals = draftTotals(draft.lines);
  if (incomingProblem(draft) !== undefined || totals === undefined) {
    return undefined;
  }
  const command: FinanceCommandDraft<'RecordIncomingInvoice'> = {
    _tag: 'RecordIncomingInvoice',
    budgetCategory: draft.category,
    ...objectAnchors(vm.objects, { ...draft.object, contractId: '' }),
    documentNumber: draft.documentNumber.trim(),
    dueDate: draft.dueDate,
    issueDate: draft.issueDate,
    lines: draft.lines.map(toInvoiceLine),
    supplierName: draft.supplierName.trim(),
    totalMinor: totals.totalMinor,
  };
  if (vm.actorLabel !== undefined) {
    command.actorLabel = vm.actorLabel;
  }
  if (draft.file !== null) {
    command.document = draft.file.upload;
  }
  if (draft.note.trim() !== '') {
    command.note = draft.note.trim();
  }
  if (draft.supplierCompanyId.trim() !== '') {
    command.supplierCompanyId = draft.supplierCompanyId.trim();
  }
  return command;
};
