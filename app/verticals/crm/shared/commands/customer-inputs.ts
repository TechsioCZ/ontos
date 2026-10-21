// AREA: customer inputs (CRM.md §6). Správce / vedoucí keep the R01–R08 register: state, who asked, when, evidence,
// and the version + approval date of a delivered sample. Every state change is kept in the entry history.
import { Effect, Match, Schema } from 'effect';
import { IsoTimeSchema, LongTextSchema, ShortTextSchema } from '../domain/common.ts';
import type { CustomerInput } from '../domain/customer-inputs.ts';
import { CustomerInputIdSchema, CustomerInputStatusSchema, customerInputOf } from '../domain/customer-inputs.ts';
import type { CrmState } from '../domain/state.ts';
import type { Reducer } from './context.ts';
import { invalid, requireWriteAll } from './context.ts';

const DaySchema = IsoTimeSchema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}/u));

export const customerInputsCommandSchemas = [
  Schema.TaggedStruct('UpdateCustomerInput', {
    evidence: Schema.optionalKey(LongTextSchema),
    id: CustomerInputIdSchema,
    /** Short reason of the change, kept in the history. */
    note: Schema.optionalKey(LongTextSchema),
    requestedAt: Schema.optionalKey(DaySchema),
    requestedBy: Schema.optionalKey(ShortTextSchema),
    sampleApprovedAt: Schema.optionalKey(DaySchema),
    sampleVersion: Schema.optionalKey(ShortTextSchema),
    status: CustomerInputStatusSchema,
  }),
] as const;
export const CustomerInputsCommandSchema = Schema.Union(customerInputsCommandSchemas);
export type CustomerInputsCommand = typeof CustomerInputsCommandSchema.Type;

const withInput = (state: CrmState, next: CustomerInput): CrmState => ({
  ...state,
  customerInputs: [...(state.customerInputs ?? []).filter((entry) => entry.id !== next.id), next].toSorted(
    (left, right) => left.id.localeCompare(right.id),
  ),
});

export const applyCustomerInputsCommand: Reducer<CustomerInputsCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag('UpdateCustomerInput', (value) =>
      Effect.gen(function* updateCustomerInput() {
        yield* requireWriteAll(context);
        const current = customerInputOf(state.customerInputs, value.id);
        const evidence = value.evidence?.trim() ?? current.evidence;
        if (evidence === '') {
          return yield* invalid('Uveďte důkaz požadavku (dokument, e-mail, zápis z jednání)');
        }
        const sampleVersion = value.sampleVersion ?? current.sampleVersion;
        let sampleApprovedAt = value.sampleApprovedAt ?? current.sampleApprovedAt;
        if (value.status === 'approved') {
          if (sampleVersion === undefined) {
            return yield* invalid('Odsouhlasení potřebuje verzi schématu / vzorku, ke které se vztahuje');
          }
          sampleApprovedAt ??= context.now.slice(0, 10);
        } else if (value.sampleApprovedAt === undefined) {
          // Leaving "approved" withdraws the approval; the history keeps the earlier one.
          sampleApprovedAt = undefined;
        }
        const next: CustomerInput = {
          evidence,
          history: [
            ...current.history,
            {
              at: context.now,
              by: context.viewer.principalId,
              ...(value.note === undefined || value.note.trim() === '' ? {} : { note: value.note.trim() }),
              status: value.status,
            },
          ],
          id: current.id,
          ...(value.note === undefined
            ? current.note === undefined
              ? {}
              : { note: current.note }
            : value.note.trim() === ''
              ? {}
              : { note: value.note.trim() }),
          requestedAt: value.requestedAt ?? current.requestedAt,
          requestedBy: value.requestedBy ?? current.requestedBy,
          ...(sampleApprovedAt === undefined ? {} : { sampleApprovedAt }),
          ...(sampleVersion === undefined ? {} : { sampleVersion }),
          status: value.status,
          updatedAt: context.now,
          updatedBy: context.viewer.principalId,
        };
        return { entityIds: [current.id], state: withInput(state, next) };
      }),
    ),
    Match.exhaustive,
  );
