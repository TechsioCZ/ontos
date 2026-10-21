// AI level C for opportunities (specs AGENT.md §3): the agent proposes, a person approves in /prodej/schvalovani-ai,
// and an applied batch can be reverted at once. The module-neutral engine lives in @app/shared-contracts/ai-approvals;
// this file plugs the sales-pipeline state and reducer into it.
import {
  decideAiChanges,
  proposeAiChanges,
  revertAiBatch,
} from '@app/shared-contracts/ai-approvals';
import type {
  AiApprovalAdapter,
  AiContext,
  AiDescribed,
  AiDiffLine,
  AiFailure,
  AiRisk,
  AiSlice,
} from '@app/shared-contracts/ai-approvals';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import type { SalesPipelineAiOperation, SalesPipelineCommand } from '../../shared/actions/apply-command.ts';
import type { SalesPipelineState } from '../../shared/apis/records.ts';
import { OpportunitySchema, opportunityAmountMinor } from '../../shared/model/opportunity.ts';
import type { Opportunity, OpportunityLine, OpportunityStage } from '../../shared/model/opportunity.ts';

type AiCommand = Extract<SalesPipelineCommand, { readonly _tag: 'AiDecideChanges' | 'AiProposeChanges' | 'AiRevertBatch' }>;

export const isSalesPipelineAiCommand = (command: SalesPipelineCommand): command is AiCommand =>
  command._tag === 'AiProposeChanges' || command._tag === 'AiDecideChanges' || command._tag === 'AiRevertBatch';

type Evolve = (
  state: SalesPipelineState,
  command: SalesPipelineCommand,
  input: { readonly invocationId: string; readonly now: DateTime.Utc },
) => Effect.Effect<{ readonly affected: readonly Opportunity[]; readonly state: SalesPipelineState }, { readonly reason: string }>;

export const stageLabel: Readonly<Record<OpportunityStage, string>> = {
  LEAD: 'Nová',
  LOST: 'Prohraná',
  NEGOTIATION: 'Vyjednávání',
  PROPOSAL: 'Nabídka',
  QUALIFIED: 'Kvalifikovaná',
  WON: 'Vyhraná',
};

/** Reducer reasons are English contract texts; the approver and the agent read Czech. */
const czechReason = (reason: string): string =>
  ({
    'A closed Opportunity cannot change': 'Uzavřenou (vyhranou nebo prohranou) příležitost nelze měnit.',
    'Opportunity does not exist in the authorized scope': 'Příležitost neexistuje.',
    'Opportunity identity is already in use': 'Identita příležitosti už existuje.',
    'The requested Opportunity transition is not allowed': 'Tento přechod mezi fázemi není povolen.',
  })[reason] ?? reason;

const czk = (minor: number) =>
  `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 }).format(minor / 100)} Kč`;

const linesText = (lines: readonly OpportunityLine[]) =>
  lines.length === 0
    ? 'bez položek'
    : lines.map((line) => `${line.quantity}× ${line.productName} à ${czk(line.unitPriceMinor)}`).join('; ');

const fieldLabels: Readonly<Record<string, string>> = {
  amount: 'Částka bez DPH',
  expectedCloseDate: 'Očekávané uzavření',
  lines: 'Položky',
  note: 'Poznámka',
  ownerEmployeeId: 'Obchodník',
  partyId: 'Zákazník',
  probability: 'Pravděpodobnost',
  stage: 'Fáze',
  title: 'Název',
};

const line = (field: string, before: string | undefined, after: string | undefined): readonly AiDiffLine[] =>
  before === after
    ? []
    : [
        {
          ...(before === undefined || before === '' ? {} : { before }),
          ...(after === undefined || after === '' ? {} : { after }),
          field,
          label: fieldLabels[field] ?? field,
        },
      ];

const describe = (state: SalesPipelineState, operation: SalesPipelineAiOperation): AiDescribed => {
  const existing = (id: string) => state.opportunities.find((entry) => entry.id === id);
  const target = (id: string) => ({
    id,
    kind: 'opportunity',
    label: existing(id)?.title ?? 'Neznámá příležitost',
  });
  return Match.value(operation).pipe(
    Match.tagsExhaustive({
      AssignOpportunity: (value): AiDescribed => ({
        diff: line('ownerEmployeeId', existing(value.id)?.ownerEmployeeId, Option.getOrUndefined(value.ownerEmployeeId)),
        summary: Option.isNone(value.ownerEmployeeId) ? 'Odebrání obchodníka z příležitosti' : 'Předání příležitosti obchodníkovi',
        target: target(value.id),
      }),
      ChangeOpportunityStage: (value): AiDescribed => {
        const current = existing(value.id);
        return {
          diff: [
            ...line('stage', current === undefined ? undefined : stageLabel[current.stage], stageLabel[value.toStage]),
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
                  ...line('lines', current === undefined ? undefined : linesText(current.lines), linesText(patch.lines)),
                ]),
            ...(patch.note === undefined ? [] : line('note', current?.note, patch.note)),
          ],
          summary: 'Úprava údajů příležitosti',
          target: target(value.id),
        };
      },
    }),
  );
};

const risk = (operation: SalesPipelineAiOperation): AiRisk =>
  Match.value(operation).pipe(
    Match.tagsExhaustive({
      AssignOpportunity: (): AiRisk => 'medium',
      ChangeOpportunityStage: (value): AiRisk => (value.toStage === 'WON' || value.toStage === 'LOST' ? 'high' : 'medium'),
      CreateOpportunity: (): AiRisk => 'medium',
      UpdateOpportunity: (value): AiRisk =>
        value.patch.lines !== undefined || value.patch.partyId !== undefined ? 'high' : 'low',
    }),
  );

const encodeOpportunity = Schema.encodeSync(OpportunitySchema);
const decodeOpportunity = Schema.decodeUnknownSync(OpportunitySchema);

const adapterFor = (evolve: Evolve, now: DateTime.Utc): AiApprovalAdapter<SalesPipelineState, SalesPipelineAiOperation> => ({
  creates: (operation) => operation._tag === 'CreateOpportunity',
  describe,
  encode: (_kind, entity) => encodeOpportunity(entity as Opportunity),
  entities: (state) => state.opportunities,
  getSlice: (state) => state.aiChanges as AiSlice<SalesPipelineAiOperation> | undefined,
  kinds: ['opportunity'],
  restore: (state, snapshot) =>
    Effect.try({
      catch: () => 'Uložený stav příležitosti nelze obnovit.',
      try: () => {
        const current = state.opportunities.find((entry) => entry.id === snapshot.id);
        if (snapshot.before === undefined) {
          // Created by the change: archived, never deleted (stage history and audit stay).
          if (current === undefined) return state;
          const archived: Opportunity = { ...current, archivedAt: now, updatedAt: now };
          return {
            ...state,
            opportunities: state.opportunities.map((entry) => (entry.id === snapshot.id ? archived : entry)),
          };
        }
        const before = decodeOpportunity(snapshot.before);
        // Back to the exact previous values; the stage history keeps the reverted step plus the return.
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
      },
    }),
  run: (state, operation, invocationId) =>
    evolve(state, operation, { invocationId, now }).pipe(
      Effect.map((change) => ({ entityIds: change.affected.map((entry) => entry.id), state: change.state })),
      Effect.mapError((failure) => czechReason(failure.reason)),
    ),
  risk,
  setSlice: (state, slice) => ({ ...state, aiChanges: slice as SalesPipelineState['aiChanges'] & object }),
});

/** Runs one AI approval command against the state. Permission checks happen in persistence before this. */
export const applySalesPipelineAiCommand = (
  state: SalesPipelineState,
  command: AiCommand,
  context: { readonly invocationId: string; readonly now: DateTime.Utc; readonly principalId: string },
  evolve: Evolve,
): Effect.Effect<{ readonly entityIds: readonly string[]; readonly state: SalesPipelineState }, AiFailure> => {
  const adapter = adapterFor(evolve, context.now);
  const aiContext: AiContext = {
    invocationId: context.invocationId,
    now: DateTime.formatIso(context.now),
    principalId: context.principalId,
  };
  return Match.value(command).pipe(
    Match.tagsExhaustive({
      AiDecideChanges: (value) =>
        decideAiChanges(adapter, state, { changeIds: value.changeIds, decision: value.decision, note: value.note }, aiContext),
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
};
