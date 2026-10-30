// AREA: customer inputs (CRM.md §6). Správce / vedoucí keep the R01–R08 register: state, who asked, when, evidence,
// and the version + approval date of a delivered sample. Every state change is kept in the entry history.
import { DateTime, Effect, Match, Schema } from 'effect';
import { makeEntityId, CalendarDateSchema, LongTextSchema, ShortTextSchema } from '../domain/common.ts';
import { CustomerInputIdSchema, CustomerInputStatusSchema, customerInputOf } from '../domain/customer-inputs.ts';
import type { CustomerInput } from '../domain/customer-inputs.ts';

import type { CrmState } from '../domain/state.ts';
import { invalid, requireWriteAll } from './context.ts';
import type { Reducer } from './context.ts';

const DaySchema = CalendarDateSchema;

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
    Match.tag(
      'UpdateCustomerInput',
      Effect.fn('Crm.updateCustomerInput')(function* updateCustomerInput(
        value: Extract<CustomerInputsCommand, { readonly _tag: 'UpdateCustomerInput' }>,
      ) {
        yield* requireWriteAll(context);
        const current = customerInputOf(state.customerInputs, value.id);
        const evidence = value.evidence?.trim() ?? current.evidence;
        if (evidence === '') {
          return yield* invalid('Uveďte důkaz požadavku (dokument, e-mail, zápis z jednání)');
        }
        const sampleVersion = value.sampleVersion ?? current.sampleVersion;
        if (value.status === 'approved' && sampleVersion === undefined) {
          return yield* invalid('Odsouhlasení potřebuje verzi schématu / vzorku, ke které se vztahuje');
        }
        // Leaving "approved" withdraws the earlier approval unless this command supplied its own date.
        const sampleApprovedAt =
          value.status === 'approved'
            ? (value.sampleApprovedAt ??
              current.sampleApprovedAt ??
              CalendarDateSchema.make(DateTime.formatIsoDateUtc(context.now)))
            : value.sampleApprovedAt;
        const historyEntry: CustomerInput['history'][number] = {
          at: context.now,
          by: context.viewer.principalId,
          status: value.status,
        };
        if (value.note !== undefined && value.note.trim() !== '') {
          Object.assign(historyEntry, { note: value.note.trim() });
        }
        const next: CustomerInput = {
          evidence,
          history: [...current.history, historyEntry],
          id: current.id,
          requestedAt: value.requestedAt ?? current.requestedAt,
          requestedBy: value.requestedBy ?? current.requestedBy,
          status: value.status,
          updatedAt: context.now,
          updatedBy: context.viewer.principalId,
        };
        if (value.note === undefined) {
          if (current.note !== undefined) {
            Object.assign(next, { note: current.note });
          }
        } else if (value.note.trim() !== '') {
          Object.assign(next, { note: value.note.trim() });
        }
        if (sampleApprovedAt !== undefined) {
          Object.assign(next, { sampleApprovedAt });
        }
        if (sampleVersion !== undefined) {
          Object.assign(next, { sampleVersion });
        }
        return { entityIds: [makeEntityId(current.id)], state: withInput(state, next) };
      }),
    ),
    Match.exhaustive,
  );
