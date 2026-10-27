import {
  CalendarDateSchema,
  EntityIdSchema,
  IsoTimeSchema,
  LongTextSchema,
  ShortTextSchema,
} from '../domain/common.ts';
import type { EntityId } from '../domain/common.ts';
// AREA: visits (C02, C06) — owned by the crm-visits lane. Command schemas + reducer.
// To add a command: add a TaggedStruct to visitsCommandSchemas and a Match.tag branch in applyVisitsCommand.
//
// C02: RecordVisit writes a contact that really happened; CorrectVisit never overwrites silently — every changed
// field lands in visit.corrections with author, time, previous and next value (C02-03).
// C06: PlanContact / UpdatePlanItem / CompletePlanItem keep the manual "K oslovení" plan. Nothing here creates a
// plan item on its own: an item exists only because a person asked for it (C06-02, C07 is parked).
import { DateTime, Effect, Match, Schema } from 'effect';

import type { CrmState } from '../domain/state.ts';
import { VisitKindSchema } from '../domain/visits.ts';
import type { PlanItem, Visit, VisitCorrection } from '../domain/visits.ts';

import { conflict, denied, definedOnly, invalid, newId, notFound, requireWritableClient } from './context.ts';
import type { CommandContext, Reducer } from './context.ts';

/** Calendar day YYYY-MM-DD (plan due dates are days, not instants). */
const DayDateSchema = CalendarDateSchema;

const VisitInputFields = {
  kind: VisitKindSchema,
  nextStep: Schema.optionalKey(LongTextSchema),
  nextStepDate: Schema.optionalKey(DayDateSchema),
  note: Schema.optionalKey(LongTextSchema),
  occurredAt: IsoTimeSchema,
  result: ShortTextSchema,
};

export const visitsCommandSchemas = [
  Schema.TaggedStruct('RecordVisit', {
    ...VisitInputFields,
    /** Also put the next step into the manual plan (needs nextStepDate). */
    addToPlan: Schema.optionalKey(Schema.Boolean),
    clientId: EntityIdSchema,
    /** Only the lead may record on behalf of another salesperson; a rep always records as self. */
    salespersonId: Schema.optionalKey(EntityIdSchema),
  }),
  Schema.TaggedStruct('CorrectVisit', {
    kind: Schema.optionalKey(VisitKindSchema),
    nextStep: Schema.optionalKey(LongTextSchema),
    nextStepDate: Schema.optionalKey(Schema.Union([DayDateSchema, Schema.Literal('')])),
    note: Schema.optionalKey(LongTextSchema),
    occurredAt: Schema.optionalKey(IsoTimeSchema),
    reason: Schema.optionalKey(LongTextSchema),
    result: Schema.optionalKey(ShortTextSchema),
    visitId: EntityIdSchema,
  }),
  Schema.TaggedStruct('PlanContact', {
    clientId: EntityIdSchema,
    dueDate: DayDateSchema,
    note: Schema.optionalKey(LongTextSchema),
    salespersonId: Schema.optionalKey(EntityIdSchema),
    sourceVisitId: Schema.optionalKey(EntityIdSchema),
  }),
  Schema.TaggedStruct('UpdatePlanItem', {
    dueDate: Schema.optionalKey(DayDateSchema),
    note: Schema.optionalKey(LongTextSchema),
    planItemId: EntityIdSchema,
  }),
  Schema.TaggedStruct('CompletePlanItem', {
    doneNote: Schema.optionalKey(LongTextSchema),
    planItemId: EntityIdSchema,
    /** Optionally record the contact that fulfilled the plan item in the same step. */
    visit: Schema.optionalKey(Schema.Struct(VisitInputFields)),
  }),
] as const;
export const VisitsCommandSchema = Schema.Union(visitsCommandSchemas);
export type VisitsCommand = typeof VisitsCommandSchema.Type;

type VisitInput = Schema.Struct.Type<typeof VisitInputFields>;

const visitFieldLabels = {
  kind: 'Typ',
  nextStep: 'Další krok',
  nextStepDate: 'Termín dalšího kroku',
  note: 'Poznámka',
  occurredAt: 'Datum a čas',
  result: 'Výsledek',
} as const;
type CorrectableField = keyof typeof visitFieldLabels;
const correctableFields = [
  'kind',
  'nextStep',
  'nextStepDate',
  'note',
  'occurredAt',
  'result',
] as const satisfies readonly CorrectableField[];

/** Calendar dates are validated in the reducer too: callers can bypass native date inputs via the API. */
const requireDay = (day: string) =>
  Schema.is(CalendarDateSchema)(day) ? Effect.void : invalid('Neplatné kalendářní datum');

/** Only contacts that really happened belong in history. Future contacts belong to the manual plan. */
const requirePast = (context: CommandContext, occurredAt: DateTime.Utc) =>
  DateTime.isGreaterThan(occurredAt, context.now)
    ? invalid('Budoucí kontakt patří do plánu K oslovení, ne do historie návštěv')
    : Effect.succeed(occurredAt);

/** Salesperson credited with a visit / plan item. A rep is always self; the lead may pick anyone active. */
const resolveSalesperson = Effect.fn('Crm.resolve')(function* resolve(
  state: CrmState,
  context: CommandContext,
  requested: EntityId | undefined,
  fallback: EntityId | undefined,
) {
  const own = context.viewer.salespersonId;
  if (!context.viewer.writeAll) {
    if (requested !== undefined && requested !== own) {
      return yield* denied('Obchodník zapisuje jen sám za sebe');
    }
    return own ?? fallback;
  }
  const chosen = requested ?? own ?? fallback;
  if (chosen !== undefined && !state.salespeople.some((person) => person.id === chosen && person.active)) {
    return yield* invalid('Zvolený obchodník neexistuje nebo není aktivní');
  }
  return chosen;
});

interface VisitRecordInput {
  readonly clientId: EntityId;
  readonly id: EntityId;
  readonly input: VisitInput;
  readonly planItemId?: EntityId;
  readonly salespersonId: EntityId | undefined;
}

const buildVisit = (
  context: CommandContext,
  { clientId, id, input, planItemId, salespersonId }: VisitRecordInput,
): Visit => ({
  ...definedOnly({
    nextStep: input.nextStep,
    nextStepDate: input.nextStepDate,
    note: input.note,
    planItemId,
    salespersonId,
  }),
  authorPrincipalId: context.viewer.principalId,
  clientId,
  corrections: [],
  createdAt: context.now,
  id,
  kind: input.kind,
  occurredAt: input.occurredAt,
  result: input.result,
  updatedAt: context.now,
});

const findPlanItem = Effect.fn('Crm.find')(function* find(
  state: CrmState,
  context: CommandContext,
  planItemId: string,
) {
  const item = state.visits.plan.find((entry) => entry.id === planItemId);
  if (item === undefined) {
    return yield* notFound('Naplánovaný kontakt neexistuje nebo k němu nemáte přístup');
  }
  yield* requireWritableClient(state, context, item.clientId);
  return item;
});

const replacePlanItem = (state: CrmState, next: PlanItem): CrmState => ({
  ...state,
  visits: { ...state.visits, plan: state.visits.plan.map((entry) => (entry.id === next.id ? next : entry)) },
});

const stringOf = (value: string | undefined) => (value === undefined || value === '' ? undefined : value);

export const applyVisitsCommand: Reducer<VisitsCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag(
      'RecordVisit',
      Effect.fn('Crm.recordVisit')(function* recordVisit(
        value: Extract<VisitsCommand, { readonly _tag: 'RecordVisit' }>,
      ) {
        const client = yield* requireWritableClient(state, context, value.clientId);
        yield* requirePast(context, value.occurredAt);
        if (value.nextStepDate !== undefined) {
          yield* requireDay(value.nextStepDate);
        }
        const salespersonId = yield* resolveSalesperson(state, context, value.salespersonId, client.ownerSalespersonId);
        const id = newId(context, 'visit');
        const visit = buildVisit(context, { clientId: client.id, id, input: value, salespersonId });
        const wantsPlan = value.addToPlan === true;
        if (wantsPlan && value.nextStepDate === undefined) {
          return yield* invalid('Pro zařazení do plánu vyplňte termín dalšího kroku');
        }
        const planItem: PlanItem | undefined =
          wantsPlan && value.nextStepDate !== undefined
            ? {
                ...definedOnly({ note: value.nextStep, salespersonId }),
                clientId: client.id,
                createdAt: context.now,
                createdBy: context.viewer.principalId,
                dueDate: value.nextStepDate,
                id: newId(context, 'plan'),
                sourceVisitId: id,
                status: 'open',
                updatedAt: context.now,
              }
            : undefined;
        return {
          entityIds: planItem === undefined ? [id] : [id, planItem.id],
          state: {
            ...state,
            visits: {
              items: [...state.visits.items, visit],
              plan: planItem === undefined ? state.visits.plan : [...state.visits.plan, planItem],
            },
          },
        };
      }),
    ),
    Match.tag(
      'CorrectVisit',
      Effect.fn('Crm.correctVisit')(function* correctVisit(
        value: Extract<VisitsCommand, { readonly _tag: 'CorrectVisit' }>,
      ) {
        const visit = state.visits.items.find((entry) => entry.id === value.visitId);
        if (visit === undefined) {
          return yield* notFound('Záznam návštěvy neexistuje nebo k němu nemáte přístup');
        }
        yield* requireWritableClient(state, context, visit.clientId);
        if (value.occurredAt !== undefined) {
          yield* requirePast(context, value.occurredAt);
        }
        if (value.nextStepDate !== undefined && value.nextStepDate !== '') {
          yield* requireDay(value.nextStepDate);
        }
        const reason = stringOf(value.reason);
        const corrections: VisitCorrection[] = [];
        const patch: Partial<Pick<Visit, CorrectableField>> = {};
        for (const field of correctableFields) {
          const requested = value[field];
          if (requested === undefined) {
            continue;
          }
          const previousValue = visit[field];
          const previous = DateTime.isDateTime(previousValue)
            ? DateTime.formatIso(previousValue)
            : stringOf(previousValue);
          const next = DateTime.isDateTime(requested) ? DateTime.formatIso(requested) : stringOf(requested);
          if (previous !== next) {
            Reflect.set(patch, field, requested === '' ? undefined : requested);
            corrections.push({
              ...definedOnly({ next, previous, reason }),
              at: context.now,
              by: context.viewer.principalId,
              field: visitFieldLabels[field],
            });
          }
        }
        if (corrections.length === 0) {
          return yield* invalid('Záznam se nezměnil');
        }
        const { kind, nextStep, nextStepDate, note, occurredAt, result } = { ...visit, ...patch };
        const corrected: Visit = {
          ...definedOnly({
            nextStep,
            nextStepDate,
            note,
            planItemId: visit.planItemId,
            salespersonId: visit.salespersonId,
          }),
          authorPrincipalId: visit.authorPrincipalId,
          clientId: visit.clientId,
          corrections: [...visit.corrections, ...corrections],
          createdAt: visit.createdAt,
          id: visit.id,
          kind: kind ?? visit.kind,
          occurredAt: occurredAt ?? visit.occurredAt,
          result: result ?? visit.result,
          updatedAt: context.now,
        };
        return {
          entityIds: [visit.id],
          state: {
            ...state,
            visits: {
              ...state.visits,
              items: state.visits.items.map((entry) => (entry.id === visit.id ? corrected : entry)),
            },
          },
        };
      }),
    ),
    Match.tag(
      'PlanContact',
      Effect.fn('Crm.planContact')(function* planContact(
        value: Extract<VisitsCommand, { readonly _tag: 'PlanContact' }>,
      ) {
        yield* requireDay(value.dueDate);
        const client = yield* requireWritableClient(state, context, value.clientId);
        const salespersonId = yield* resolveSalesperson(state, context, value.salespersonId, client.ownerSalespersonId);
        if (
          value.sourceVisitId !== undefined &&
          !state.visits.items.some((visit) => visit.id === value.sourceVisitId && visit.clientId === client.id)
        ) {
          return yield* invalid('Navazující návštěva nepatří k tomuto klientovi');
        }
        const id = newId(context, 'plan');
        const item: PlanItem = {
          ...definedOnly({ note: value.note, salespersonId, sourceVisitId: value.sourceVisitId }),
          clientId: client.id,
          createdAt: context.now,
          createdBy: context.viewer.principalId,
          dueDate: value.dueDate,
          id,
          status: 'open',
          updatedAt: context.now,
        };
        return {
          entityIds: [id],
          state: { ...state, visits: { ...state.visits, plan: [...state.visits.plan, item] } },
        };
      }),
    ),
    Match.tag(
      'UpdatePlanItem',
      Effect.fn('Crm.updatePlanItem')(function* updatePlanItem(
        value: Extract<VisitsCommand, { readonly _tag: 'UpdatePlanItem' }>,
      ) {
        const item = yield* findPlanItem(state, context, value.planItemId);
        if (item.status !== 'open') {
          return yield* conflict('Vyřízený kontakt už nelze měnit');
        }
        if (value.dueDate === undefined && value.note === undefined) {
          return yield* invalid('Záznam se nezměnil');
        }
        if (value.dueDate !== undefined) {
          yield* requireDay(value.dueDate);
        }
        const note = value.note === undefined ? item.note : stringOf(value.note);
        const { note: _previousNote, ...rest } = item;
        const next: PlanItem = {
          ...rest,
          ...definedOnly({ note }),
          dueDate: value.dueDate ?? item.dueDate,
          updatedAt: context.now,
        };
        return { entityIds: [item.id], state: replacePlanItem(state, next) };
      }),
    ),
    Match.tag(
      'CompletePlanItem',
      Effect.fn('Crm.completePlanItem')(function* completePlanItem(
        value: Extract<VisitsCommand, { readonly _tag: 'CompletePlanItem' }>,
      ) {
        const item = yield* findPlanItem(state, context, value.planItemId);
        if (item.status !== 'open') {
          return yield* conflict('Kontakt už je vyřízený');
        }
        const visitInput = value.visit;
        const visitId = visitInput === undefined ? undefined : newId(context, 'visit');
        const visits: Visit[] = [];
        if (visitInput !== undefined && visitId !== undefined) {
          yield* requirePast(context, visitInput.occurredAt);
          if (visitInput.nextStepDate !== undefined) {
            yield* requireDay(visitInput.nextStepDate);
          }
          const salespersonId = yield* resolveSalesperson(state, context, undefined, item.salespersonId);
          visits.push(
            buildVisit(context, {
              clientId: item.clientId,
              id: visitId,
              input: visitInput,
              planItemId: item.id,
              salespersonId,
            }),
          );
        }
        const done: PlanItem = {
          ...item,
          ...definedOnly({ doneNote: value.doneNote, doneVisitId: visitId }),
          doneAt: context.now,
          doneBy: context.viewer.principalId,
          status: 'done',
          updatedAt: context.now,
        };
        const completed = replacePlanItem(state, done);
        return {
          entityIds: visitId === undefined ? [item.id] : [item.id, visitId],
          state: { ...completed, visits: { ...completed.visits, items: [...completed.visits.items, ...visits] } },
        };
      }),
    ),
    Match.exhaustive,
  );
