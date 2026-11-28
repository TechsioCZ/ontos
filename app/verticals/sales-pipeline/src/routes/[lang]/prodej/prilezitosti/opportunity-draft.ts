// The opportunity form's values: what the create panel sends once and the edit panel saves on its Uložit button.
import type { RevisionedSaveResult } from '@app/admin-ui';
import { CalendarDateSchema } from '@app/shared-contracts';
import { Effect, Option, Predicate, Schema } from 'effect';
import { OpportunityNoteSchema, OpportunityTitleSchema } from '../../../../../shared/model/opportunity.ts';
import type { Opportunity, OpportunityLine } from '../../../../../shared/model/opportunity.ts';
import {
  EmployeeIdSchema,
  PartyIdSchema,
} from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import { isSafeOpportunityAmount, isValidQuantity } from './pipeline-model.ts';

export type UpdateCommand = Extract<PipelineCommand, { _tag: 'UpdateOpportunity' }>;
export type CreateCommand = Extract<PipelineCommand, { _tag: 'CreateOpportunity' }>;

/** One product line of the draft, with the quantity typed into its row when that quantity cannot be used. */
export interface LineEntry {
  readonly invalidAmount?: boolean;
  /**
   * The number typed into the quantity field when it is not a whole number of at least 1. The field keeps showing
   * it and the line reports it; `line` keeps the last valid quantity.
   */
  readonly invalidQuantity?: number;
  readonly key: string;
  readonly line: OpportunityLine;
}

/** The quantity a line's row shows: what was typed when it could not be used, else the line's own. */
export const shownQuantity = (entry: LineEntry): number => entry.invalidQuantity ?? entry.line.quantity;

/**
 * The lines after a quantity was typed into the row `key`. A valid quantity updates the line; any other number stays
 * as typed and is reported, never replaced. A field that is empty or mid-edit remains invalid until a valid quantity
 * is entered.
 */
export const withQuantity = (lines: readonly LineEntry[], key: string, value: number): readonly LineEntry[] =>
  lines.map((entry): LineEntry => {
    if (entry.key !== key) {
      return entry;
    }
    if (!isValidQuantity(value)) {
      return { invalidQuantity: value, key: entry.key, line: entry.line };
    }
    const nextLine = { ...entry.line, quantity: value };
    const nextLines = lines.map((item) => (item.key === key ? nextLine : item.line));
    return isSafeOpportunityAmount(nextLines)
      ? { key: entry.key, line: nextLine }
      : { invalidAmount: true, invalidQuantity: value, key: entry.key, line: entry.line };
  });

/** Every line has a usable quantity and the total stays within range. */
const linesValid = (lines: readonly LineEntry[]): boolean =>
  lines.every((entry) => entry.invalidAmount !== true && entry.invalidQuantity === undefined) &&
  isSafeOpportunityAmount(lines.map((entry) => entry.line));

export interface FormDraft {
  /** Calendar date as typed; decoded to a CalendarDate only when sent. */
  readonly closeText: string;
  readonly customerId: string | null;
  readonly lines: readonly LineEntry[];
  readonly note: string;
  readonly ownerId: string | null;
  readonly title: string;
}

export const emptyDraft: FormDraft = {
  closeText: '',
  customerId: null,
  lines: [],
  note: '',
  ownerId: null,
  title: '',
};

export const draftFrom = (opportunity: Opportunity): FormDraft => ({
  closeText: opportunity.expectedCloseDate,
  customerId: opportunity.partyId,
  lines: opportunity.lines.map((line, index) => ({ key: `init-${index}`, line })),
  note: opportunity.note ?? '',
  ownerId: opportunity.ownerEmployeeId ?? null,
  title: opportunity.title,
});

const sameLine = (left: OpportunityLine, right: OpportunityLine) =>
  left.productId === right.productId &&
  left.productName === right.productName &&
  left.quantity === right.quantity &&
  left.unitPriceMinor === right.unitPriceMinor &&
  left.vatRate === right.vatRate;

const sameEntry = (left: LineEntry, right: LineEntry) =>
  sameLine(left.line, right.line) &&
  left.invalidAmount === right.invalidAmount &&
  left.invalidQuantity === right.invalidQuantity;

/** Drafts that store the same opportunity: surrounding spaces and the editor's row keys do not count. */
export const sameOpportunityDraft = (left: FormDraft, right: FormDraft): boolean =>
  left.closeText === right.closeText &&
  left.customerId === right.customerId &&
  left.ownerId === right.ownerId &&
  left.title.trim() === right.title.trim() &&
  left.note.trim() === right.note.trim() &&
  left.lines.length === right.lines.length &&
  left.lines.every((entry, index) => {
    const other = right.lines[index];
    return other !== undefined && sameEntry(entry, other);
  });

const isValidTitle = Schema.is(OpportunityTitleSchema);
const isValidNote = Schema.is(OpportunityNoteSchema);

/** The patch an edit sends; None while a field is invalid, so an invalid draft is never saved. */
export const updateCommandOf = (id: Opportunity['id'], draft: FormDraft): Option.Option<UpdateCommand> => {
  const title = draft.title.trim();
  const note = draft.note.trim();
  const lines = draft.lines.map((entry) => entry.line);
  if (!isValidTitle(title) || !isValidNote(note) || !linesValid(draft.lines) || draft.customerId === null) {
    return Option.none();
  }
  return Option.all({
    expectedCloseDate: Schema.decodeOption(CalendarDateSchema)(draft.closeText),
    partyId: Schema.decodeOption(PartyIdSchema)(draft.customerId),
  }).pipe(
    Option.map(({ expectedCloseDate, partyId }): UpdateCommand => ({
      _tag: 'UpdateOpportunity',
      id,
      patch: { expectedCloseDate, lines, note, partyId, title },
    })),
  );
};

/** The CreateOpportunity of a complete, valid draft; none while a field is missing or invalid. */
export const createCommandOf = (draft: FormDraft): Option.Option<CreateCommand> => {
  const title = draft.title.trim();
  const note = draft.note.trim();
  if (!isValidTitle(title) || !isValidNote(note) || !linesValid(draft.lines) || draft.customerId === null) {
    return Option.none();
  }
  const owner = draft.ownerId === null ? Option.none() : Schema.decodeOption(EmployeeIdSchema)(draft.ownerId);
  return Option.all({
    expectedCloseDate: Schema.decodeOption(CalendarDateSchema)(draft.closeText),
    partyId: Schema.decodeOption(PartyIdSchema)(draft.customerId),
  }).pipe(
    Option.map(({ expectedCloseDate, partyId }): CreateCommand => {
      const base: CreateCommand = {
        _tag: 'CreateOpportunity',
        expectedCloseDate,
        lines: draft.lines.map((entry) => entry.line),
        note,
        partyId,
        title,
      };
      return Option.isSome(owner) ? { ...base, ownerEmployeeId: owner.value } : base;
    }),
  );
};

/**
 * Whether the records still hold the opportunity as the draft's base version. The revision covers the whole
 * pipeline, so a revision conflict caused by another opportunity is resent; a change of this one is a conflict.
 */
export const opportunityUnchangedSince =
  (id: Opportunity['id'], base: FormDraft) =>
  (items: readonly Opportunity[]): boolean => {
    const current = items.find((item) => item.id === id);
    return current !== undefined && sameOpportunityDraft(draftFrom(current), base);
  };

/**
 * A save of the edit panel: the new revision once saved, `proposed` when the change awaits approval, `conflict` for a
 * revision conflict, else `failed`.
 */
export const opportunitySaveResult = <E>(
  write: Effect.Effect<{ readonly revision: number }, E>,
): Effect.Effect<RevisionedSaveResult> =>
  write.pipe(
    Effect.match({
      onFailure: (error): RevisionedSaveResult => {
        if (Predicate.isTagged(error, 'ActionProposalAccepted')) {
          return 'proposed';
        }
        return Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') &&
          Predicate.hasProperty(error, 'code') &&
          error.code === 'sales_pipeline_revision_conflict'
          ? 'conflict'
          : 'failed';
      },
      onSuccess: ({ revision }): RevisionedSaveResult => revision,
    }),
  );
