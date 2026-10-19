// AREA: visits (C02, C06) — owned by the crm-visits lane. Command schemas + reducer.
// To add a command: add a TaggedStruct to visitsCommandSchemas and a Match.tag branch in applyVisitsCommand.
import { Effect, Match, Schema } from 'effect';
import { IsoTimeSchema, LongTextSchema, ShortTextSchema, EntityIdSchema } from '../domain/common.ts';
import type { Visit } from '../domain/visits.ts';
import { VisitKindSchema } from '../domain/visits.ts';
import type { Reducer } from './context.ts';
import { definedOnly, newId, requireWritableClient } from './context.ts';

export const visitsCommandSchemas = [
  Schema.TaggedStruct('RecordVisit', {
    clientId: EntityIdSchema,
    kind: VisitKindSchema,
    nextStep: Schema.optionalKey(LongTextSchema),
    nextStepDate: Schema.optionalKey(IsoTimeSchema),
    note: Schema.optionalKey(LongTextSchema),
    occurredAt: IsoTimeSchema,
    result: ShortTextSchema,
  }),
] as const;
export const VisitsCommandSchema = Schema.Union(visitsCommandSchemas);
export type VisitsCommand = typeof VisitsCommandSchema.Type;

export const applyVisitsCommand: Reducer<VisitsCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag('RecordVisit', (value) =>
      Effect.gen(function* recordVisit() {
        const client = yield* requireWritableClient(state, context, value.clientId);
        const id = newId(context, 'visit');
        const visit: Visit = {
          ...definedOnly({
            nextStep: value.nextStep,
            nextStepDate: value.nextStepDate,
            note: value.note,
            salespersonId: context.viewer.salespersonId ?? client.ownerSalespersonId,
          }),
          authorPrincipalId: context.viewer.principalId,
          clientId: client.id,
          corrections: [],
          createdAt: context.now,
          id,
          kind: value.kind,
          occurredAt: value.occurredAt,
          result: value.result,
          updatedAt: context.now,
        };
        return {
          entityIds: [id],
          state: { ...state, visits: { ...state.visits, items: [...state.visits.items, visit] } },
        };
      }),
    ),
    Match.exhaustive,
  );
