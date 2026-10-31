// AI level C for opportunities (specs AGENT.md §3): the agent proposes, a person approves in /prodej/schvalovani-ai,
// and an applied batch can be reverted at once. The module-neutral engine lives in @app/shared-contracts/ai-approvals;
// this file plugs the sales-pipeline state and reducer into it.
import {
  AiAdapterFailure,
  AiContextSchema,
  AiFailure,
  decideAiChanges,
  proposeAiChanges,
  revertAiBatch,
} from '@app/shared-contracts/ai-approvals';
import type {
  AiApprovalAdapter,
  AiContext,
  AiDescribed,
  AiDiffLine,
  AiRisk,
  AiSnapshot,
} from '@app/shared-contracts/ai-approvals';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import type { DateTime } from 'effect';
import { AiResultEntityIdsSchema, salesPipelineAiCommandSchemas } from '../../shared/actions/apply-command.ts';
import type {
  ApplyCommandResult,
  SalesPipelineAiOperation,
  SalesPipelineCommand,
} from '../../shared/actions/apply-command.ts';
import type { SalesPipelineState } from '../../shared/apis/records.ts';
import { OpportunitySchema, opportunityAmountMinor } from '../../shared/model/opportunity.ts';
import type { Opportunity, OpportunityLine, OpportunityStage } from '../../shared/model/opportunity.ts';

type AiCommand = Extract<
  SalesPipelineCommand,
  { readonly _tag: 'AiDecideChanges' | 'AiProposeChanges' | 'AiRevertBatch' }
>;

export const isSalesPipelineAiCommand = Schema.is(Schema.Union(salesPipelineAiCommandSchemas));

type Evolve = (
  state: SalesPipelineState,
  command: SalesPipelineCommand,
  input: { readonly invocationId: string; readonly now: DateTime.Utc },
) => Effect.Effect<
  { readonly affected: readonly Opportunity[]; readonly state: SalesPipelineState },
  { readonly reason: string }
>;

export const stageLabel = {
  LEAD: 'Nová',
  LOST: 'Prohraná',
  NEGOTIATION: 'Vyjednávání',
  PROPOSAL: 'Nabídka',
  QUALIFIED: 'Kvalifikovaná',
  WON: 'Vyhraná',
} satisfies Readonly<Record<OpportunityStage, string>>;

/** Reducer reasons are English contract texts; the approver and the agent read Czech. */
const czechReason = (reason: string): string =>
  ({
    'A closed Opportunity cannot change': 'Uzavřenou (vyhranou nebo prohranou) příležitost nelze měnit.',
    'Opportunity does not exist in the authorized scope': 'Příležitost neexistuje.',
    'Opportunity identity is already in use': 'Identita příležitosti už existuje.',
    'The requested Opportunity transition is not allowed': 'Tento přechod mezi fázemi není povolen.',
  })[reason] ?? reason;

const numberFormat = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });
const czk = (minor: number) => `${numberFormat.format(minor / 100)} Kč`;

const linesText = (lines: readonly OpportunityLine[]) =>
  lines.length === 0
    ? 'bez položek'
    : lines.map((line) => `${line.quantity}× ${line.productName} à ${czk(line.unitPriceMinor)}`).join('; ');

const fieldLabels = {
  amount: 'Částka bez DPH',
  expectedCloseDate: 'Očekávané uzavření',
  lines: 'Položky',
  note: 'Poznámka',
  ownerEmployeeId: 'Obchodník',
  partyId: 'Zákazník',
  probability: 'Pravděpodobnost',
  stage: 'Fáze',
  title: 'Název',
} satisfies Readonly<Record<string, string>>;

const fieldLabelByName = new Map(Object.entries(fieldLabels));

const line = (field: string, before: string | undefined, after: string | undefined): readonly AiDiffLine[] => {
  if (before === after) {
    return [];
  }
  const change: { -readonly [Key in keyof AiDiffLine]: AiDiffLine[Key] } = {
    field,
    label: fieldLabelByName.get(field) ?? field,
  };
  if (before !== undefined && before !== '') {
    change.before = before;
  }
  if (after !== undefined && after !== '') {
    change.after = after;
  }
  return [change];
};

const describe = Effect.fn('SalesPipeline.describeAiOperation')(
  (state: SalesPipelineState, operation: SalesPipelineAiOperation): Effect.Effect<AiDescribed> =>
    Effect.sync(() => {
      const existing = (id: string) => state.opportunities.find((entry) => entry.id === id);
      const target = (id: string) => ({
        id,
        kind: 'opportunity',
        label: existing(id)?.title ?? 'Neznámá příležitost',
      });
      return Match.value(operation).pipe(
        Match.tagsExhaustive({
          AssignOpportunity: (value): AiDescribed => ({
            diff: line(
              'ownerEmployeeId',
              existing(value.id)?.ownerEmployeeId,
              Option.getOrUndefined(value.ownerEmployeeId),
            ),
            summary: Option.isNone(value.ownerEmployeeId)
              ? 'Odebrání obchodníka z příležitosti'
              : 'Předání příležitosti obchodníkovi',
            target: target(value.id),
          }),
          ChangeOpportunityStage: (value): AiDescribed => {
            const current = existing(value.id);
            return {
              diff: [
                ...line(
                  'stage',
                  current === undefined ? undefined : stageLabel[current.stage],
                  stageLabel[value.toStage],
                ),
                ...(value.note === undefined ? [] : line('note', current?.note, value.note)),
              ],
              summary: 'Změna fáze příležitosti',
              target: target(value.id),
            };
          },
          CreateOpportunity: (value): AiDescribed => ({
            diff: [
              ...line('title', undefined, value.title),
              ...line('partyId', undefined, value.partyId),
              ...line('stage', undefined, stageLabel[value.stage ?? 'LEAD']),
              ...line('expectedCloseDate', undefined, value.expectedCloseDate),
              ...line('amount', undefined, czk(opportunityAmountMinor(value.lines))),
              ...(value.lines.length === 0 ? [] : line('lines', undefined, linesText(value.lines))),
              ...(value.probability === undefined ? [] : line('probability', undefined, `${value.probability} %`)),
              ...line('ownerEmployeeId', undefined, value.ownerEmployeeId),
              ...line('note', undefined, value.note),
            ],
            summary: 'Založení nové příležitosti',
            target: { kind: 'opportunity', label: value.title },
          }),
          UpdateOpportunity: (value): AiDescribed => {
            const current = existing(value.id);
            const { patch } = value;
            return {
              diff: [
                ...(patch.title === undefined ? [] : line('title', current?.title, patch.title)),
                ...(patch.partyId === undefined ? [] : line('partyId', current?.partyId, patch.partyId)),
                ...(patch.expectedCloseDate === undefined
                  ? []
                  : line('expectedCloseDate', current?.expectedCloseDate, patch.expectedCloseDate)),
                ...(patch.probability === undefined
                  ? []
                  : line(
                      'probability',
                      current === undefined ? undefined : `${current.probability} %`,
                      `${patch.probability} %`,
                    )),
                ...(patch.lines === undefined
                  ? []
                  : [
                      ...line(
                        'amount',
                        current === undefined ? undefined : czk(current.amountMinor),
                        czk(opportunityAmountMinor(patch.lines)),
                      ),
                      ...line(
                        'lines',
                        current === undefined ? undefined : linesText(current.lines),
                        linesText(patch.lines),
                      ),
                    ]),
                ...(patch.note === undefined ? [] : line('note', current?.note, patch.note)),
              ],
              summary: 'Úprava údajů příležitosti',
              target: target(value.id),
            };
          },
        }),
      );
    }),
);

const risk = (operation: SalesPipelineAiOperation): AiRisk =>
  Match.value(operation).pipe(
    Match.tagsExhaustive({
      AssignOpportunity: (): AiRisk => 'medium',
      ChangeOpportunityStage: (value): AiRisk =>
        value.toStage === 'WON' || value.toStage === 'LOST' ? 'high' : 'medium',
      CreateOpportunity: (): AiRisk => 'medium',
      UpdateOpportunity: (value): AiRisk =>
        value.patch.lines !== undefined || value.patch.partyId !== undefined ? 'high' : 'low',
    }),
  );

const encodeOpportunity = Schema.encodeUnknownEffect(OpportunitySchema);
const decodeOpportunity = Schema.decodeUnknownEffect(OpportunitySchema);

const adapterFor = (
  evolve: Evolve,
  now: DateTime.Utc,
): AiApprovalAdapter<SalesPipelineState, SalesPipelineAiOperation> => ({
  creates: (operation) => Predicate.isTagged(operation, 'CreateOpportunity'),
  describe,
  encode: (_kind, entity) =>
    encodeOpportunity(entity).pipe(
      Effect.mapError((cause) => new AiAdapterFailure({ cause, message: 'Uložený stav příležitosti nelze zapsat.' })),
    ),
  entities: (state) => state.opportunities,
  getSlice: (state) => state.aiChanges,
  kinds: ['opportunity'],
  restore: Effect.fn('SalesPipeline.restoreAiSnapshot')(function* restore(
    state: SalesPipelineState,
    snapshot: AiSnapshot,
  ) {
    const current = state.opportunities.find((entry) => entry.id === snapshot.id);
    if (snapshot.before === undefined) {
      // A reverted creation remains in the audit and stage history as an archived opportunity.
      if (current === undefined) {
        return state;
      }
      const archived: Opportunity = { ...current, archivedAt: now, updatedAt: now };
      return {
        ...state,
        opportunities: state.opportunities.map((entry) => (entry.id === snapshot.id ? archived : entry)),
      };
    }
    const before = yield* decodeOpportunity(snapshot.before).pipe(
      Effect.mapError((cause) => new AiAdapterFailure({ cause, message: 'Uložený stav příležitosti nelze obnovit.' })),
    );
    const restored: Opportunity = {
      ...before,
      stageHistory:
        current !== undefined && current.stage !== before.stage
          ? [...current.stageHistory, { at: now, stage: before.stage }]
          : before.stageHistory,
      updatedAt: now,
    };
    return {
      ...state,
      opportunities: state.opportunities.map((entry) => (entry.id === snapshot.id ? restored : entry)),
    };
  }),
  risk,
  run: (state, operation, invocationId) =>
    evolve(state, operation, { invocationId, now }).pipe(
      Effect.map((change) => ({ entityIds: change.affected.map((entry) => entry.id), state: change.state })),
      Effect.mapError((cause) => new AiAdapterFailure({ cause, message: czechReason(cause.reason) })),
    ),
  setSlice: (state, slice) => ({ ...state, aiChanges: slice }),
});

/** Runs one AI approval command against the state. Permission checks happen in persistence before this. */
export const applySalesPipelineAiCommand = Effect.fn('SalesPipeline.applyAiCommand')(function* applyAiCommand(
  state: SalesPipelineState,
  command: AiCommand,
  context: { readonly invocationId: string; readonly now: DateTime.Utc; readonly principalId: string },
  evolve: Evolve,
): Effect.fn.Return<
  { readonly entityIds: NonNullable<ApplyCommandResult['entityIds']>; readonly state: SalesPipelineState },
  AiFailure
> {
  const adapter = adapterFor(evolve, context.now);
  const aiContext: AiContext = yield* Schema.decodeEffect(AiContextSchema)({
    invocationId: context.invocationId,
    now: context.now,
    principalId: context.principalId,
  }).pipe(
    Effect.mapError((cause) => {
      const message = 'Kontext schvalování AI nelze přečíst.';
      return new AiFailure({ cause: new AiAdapterFailure({ cause, message }), kind: 'invalid', message });
    }),
  );
  const outcome = yield* Match.value(command).pipe(
    Match.tagsExhaustive({
      AiDecideChanges: (value) =>
        decideAiChanges(
          adapter,
          state,
          { changeIds: value.changeIds, decision: value.decision, note: value.note },
          aiContext,
        ),
      AiProposeChanges: (value) =>
        proposeAiChanges(
          adapter,
          state,
          {
            agentLabel: value.agentLabel ?? 'AI agent',
            changes: value.changes,
            instruction: value.instruction,
            runId: value.runId,
          },
          aiContext,
        ),
      AiRevertBatch: (value) => revertAiBatch(adapter, state, { batchId: value.batchId, note: value.note }, aiContext),
    }),
  );
  const entityIds = yield* Schema.decodeEffect(AiResultEntityIdsSchema)(outcome.entityIds).pipe(
    Effect.mapError((cause) => {
      const message = 'Výsledek schvalování AI nelze přečíst.';
      return new AiFailure({ cause: new AiAdapterFailure({ cause, message }), kind: 'invalid', message });
    }),
  );
  return { entityIds, state: outcome.state };
});
