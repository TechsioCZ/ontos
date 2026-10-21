// AI level C for Obchodní firma (specs AGENT.md §3): the agent PROPOSES changes of opportunities (sales-pipeline) and
// orders (merchandise). Nothing changes until a person approves each item on /cs/sprava/ke-schvaleni, where the whole
// run can also be reverted. The C principal has no write grant, so a direct apply-command is refused by the module.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Schema } from 'effect';
import { z } from 'zod';
import type { JsonObject } from '../ontos-client.ts';
import { withoutUndefined } from '../ontos-client.ts';
import { OPPORTUNITY_STAGES } from './sales.ts';
import { ORDER_STATUSES } from './merchandise.ts';
import { applyCommand, CALENDAR_DATE, defineTool, minorFromCzk, readRecordsOf, readRevision } from './shared.ts';

export const SALES_AI_REVIEW_URL = 'http://localhost:3020/cs/sprava/ke-schvaleni';
const AGENT_LABEL = 'AI asistent Obchodní firmy · úroveň C';

const id = z.string().min(1).max(300);
const opportunityLine = z.object({
  productId: z.uuid().optional().describe('Product id from list_products, when the line is a catalogue product.'),
  productName: z.string().min(1).max(300),
  quantity: z.number().int().min(1),
  unitPriceCzk: z.number().min(0).describe('Unit price in CZK without VAT.'),
  vatRate: z.union([z.literal(0), z.literal(10), z.literal(12), z.literal(21)]),
});
const orderLine = z.object({
  productId: id.describe('Product id from list_products.'),
  quantity: z.number().positive(),
  unitPriceCzk: z.number().min(0).optional().describe('Override of the unit price in CZK; omit to keep the order price.'),
  variantId: id.optional(),
});

export const salesAiOperation = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ChangeOpportunityStage'),
    note: z.string().max(2000).optional(),
    opportunityId: id,
    toStage: z.enum(OPPORTUNITY_STAGES),
  }),
  z.object({
    kind: z.literal('AssignOpportunity'),
    opportunityId: id,
    ownerEmployeeId: z.union([id, z.null()]).describe('Employee id from list_employees, or null to clear the owner.'),
  }),
  z.object({
    kind: z.literal('UpdateOpportunity'),
    expectedCloseDate: z.string().regex(CALENDAR_DATE).optional(),
    lines: z.array(opportunityLine).max(200).optional().describe('Replaces all product lines.'),
    note: z.string().max(2000).optional(),
    opportunityId: id,
    probability: z.number().int().min(0).max(100).optional(),
    title: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal('CreateOpportunity'),
    expectedCloseDate: z.string().regex(CALENDAR_DATE),
    lines: z.array(opportunityLine).max(200).optional(),
    note: z.string().max(2000).optional(),
    ownerEmployeeId: id.optional(),
    partyId: id.describe('Customer partyId from list_customers.'),
    probability: z.number().int().min(0).max(100).optional(),
    stage: z.enum(OPPORTUNITY_STAGES).optional(),
    title: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('ChangeOrderStatus'),
    orderId: id.describe('Order id from list_orders.'),
    reason: z.string().max(500).optional(),
    status: z.enum(ORDER_STATUSES),
  }),
  z.object({
    kind: z.literal('EditOrder'),
    lines: z.array(orderLine).min(1).max(200).optional().describe('The complete new set of order lines.'),
    note: z.string().max(1000).optional(),
    orderId: id.describe('Order id from list_orders.'),
    reason: z.string().max(500).optional(),
    shipping: z
      .object({ method: z.enum(['ZASILKOVNA', 'PPL', 'CESKA_POSTA', 'OSOBNI_ODBER']), priceCzk: z.number().min(0) })
      .optional(),
  }),
]);
export type SalesAiOperation = z.infer<typeof salesAiOperation>;

const opportunityLineWire = (line: z.infer<typeof opportunityLine>) =>
  withoutUndefined({
    productId: line.productId,
    productName: line.productName,
    quantity: line.quantity,
    unitPriceMinor: minorFromCzk(line.unitPriceCzk),
    vatRate: line.vatRate,
  });

/** The module that owns the operation and its apply-command operation (wire form). */
export const toWireOperation = (
  operation: SalesAiOperation,
): { readonly module: 'merchandise' | 'sales-pipeline'; readonly operation: JsonObject } => {
  switch (operation.kind) {
    case 'ChangeOpportunityStage':
      return {
        module: 'sales-pipeline',
        operation: withoutUndefined({
          _tag: 'ChangeOpportunityStage',
          id: operation.opportunityId,
          note: operation.note,
          toStage: operation.toStage,
        }),
      };
    case 'AssignOpportunity':
      return {
        module: 'sales-pipeline',
        operation: { _tag: 'AssignOpportunity', id: operation.opportunityId, ownerEmployeeId: operation.ownerEmployeeId },
      };
    case 'UpdateOpportunity':
      return {
        module: 'sales-pipeline',
        operation: {
          _tag: 'UpdateOpportunity',
          id: operation.opportunityId,
          patch: withoutUndefined({
            expectedCloseDate: operation.expectedCloseDate,
            lines: operation.lines?.map(opportunityLineWire),
            note: operation.note,
            probability: operation.probability,
            title: operation.title,
          }),
        },
      };
    case 'CreateOpportunity':
      return {
        module: 'sales-pipeline',
        operation: withoutUndefined({
          _tag: 'CreateOpportunity',
          expectedCloseDate: operation.expectedCloseDate,
          lines: (operation.lines ?? []).map(opportunityLineWire),
          note: operation.note,
          ownerEmployeeId: operation.ownerEmployeeId,
          partyId: operation.partyId,
          probability: operation.probability,
          stage: operation.stage,
          title: operation.title,
        }),
      };
    case 'ChangeOrderStatus':
      return {
        module: 'merchandise',
        operation: withoutUndefined({
          _tag: 'ChangeOrderStatus',
          id: operation.orderId,
          reason: operation.reason,
          status: operation.status,
        }),
      };
    case 'EditOrder':
      return {
        module: 'merchandise',
        operation: withoutUndefined({
          _tag: 'EditOrder',
          id: operation.orderId,
          lines: operation.lines?.map((line) =>
            withoutUndefined({
              productId: line.productId,
              quantity: line.quantity,
              unitPriceMinor: line.unitPriceCzk === undefined ? undefined : minorFromCzk(line.unitPriceCzk),
              variantId: line.variantId,
            }),
          ),
          note: operation.note,
          reason: operation.reason,
          shipping:
            operation.shipping === undefined
              ? undefined
              : { method: operation.shipping.method, priceMinor: minorFromCzk(operation.shipping.priceCzk) },
        }),
      };
  }
};

const ProposalResult = Schema.Struct({ entityIds: Schema.optionalKey(Schema.Array(Schema.String)), revision: Schema.Int });
const AiSliceWire = Schema.Struct({
  aiChanges: Schema.optionalKey(
    Schema.Struct({
      batches: Schema.Array(
        Schema.Struct({
          createdAt: Schema.String,
          id: Schema.String,
          instruction: Schema.String,
          revertedAt: Schema.optionalKey(Schema.String),
          runId: Schema.optionalKey(Schema.String),
        }),
      ),
      changes: Schema.Array(
        Schema.Struct({
          batchId: Schema.String,
          decisionNote: Schema.optionalKey(Schema.String),
          diff: Schema.Array(
            Schema.Struct({
              after: Schema.optionalKey(Schema.String),
              before: Schema.optionalKey(Schema.String),
              label: Schema.String,
            }),
          ),
          failure: Schema.optionalKey(Schema.String),
          id: Schema.String,
          reason: Schema.String,
          status: Schema.String,
          summary: Schema.String,
          target: Schema.Struct({ id: Schema.optionalKey(Schema.String), label: Schema.String }),
        }),
      ),
    }),
  ),
});

const MODULE_LABEL = { merchandise: 'objednávky', 'sales-pipeline': 'příležitosti' } as const;
/** Light records reads: the AI slice rides along with every staff read. */
const sliceQuery: Readonly<Record<'merchandise' | 'sales-pipeline', JsonObject>> = {
  merchandise: { view: { limit: 1, summary: true } },
  'sales-pipeline': { ids: [] },
};

const readSlice = async (module: 'merchandise' | 'sales-pipeline') =>
  (await readRecordsOf(module, AiSliceWire, sliceQuery[module])).aiChanges ?? { batches: [], changes: [] };

export const listAiProposals = async (input: { readonly runId?: string | undefined }) => {
  const modules = ['sales-pipeline', 'merchandise'] as const;
  const slices = await Promise.all(modules.map(async (module) => ({ module, slice: await readSlice(module) })));
  const batches = slices
    .flatMap(({ module, slice }) =>
      slice.batches
        .filter((batch) => input.runId === undefined || batch.runId === input.runId)
        .map((batch) => ({
          batchId: batch.id,
          changes: slice.changes
            .filter((change) => change.batchId === batch.id)
            .map((change) => ({
              changeId: change.id,
              diff: change.diff,
              status: change.status,
              summary: change.summary,
              target: change.target,
              ...(change.failure === undefined ? {} : { failure: change.failure }),
              ...(change.decisionNote === undefined ? {} : { decisionNote: change.decisionNote }),
            })),
          createdAt: batch.createdAt,
          instruction: batch.instruction,
          module: MODULE_LABEL[module],
          reverted: batch.revertedAt !== undefined,
          runId: batch.runId ?? null,
        })),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20);
  return { batches, reviewUrl: SALES_AI_REVIEW_URL };
};

export const proposeSalesChanges = async (input: {
  readonly changes: readonly { readonly operation: SalesAiOperation; readonly reason: string }[];
  readonly instruction: string;
  readonly runId: string;
}) => {
  const grouped = new Map<'merchandise' | 'sales-pipeline', { operation: JsonObject; reason: string }[]>();
  for (const change of input.changes) {
    const wire = toWireOperation(change.operation);
    grouped.set(wire.module, [...(grouped.get(wire.module) ?? []), { operation: wire.operation, reason: change.reason }]);
  }
  const results = [];
  for (const [module, changes] of grouped) {
    const result = await applyCommand(
      module,
      ProposalResult,
      { _tag: 'AiProposeChanges', agentLabel: AGENT_LABEL, changes, instruction: input.instruction, runId: input.runId },
      async () => await readRevision(module, sliceQuery[module]),
    );
    results.push({ batchId: result.entityIds?.[0] ?? null, module });
  }
  const current = await listAiProposals({ runId: input.runId });
  const statuses = current.batches.flatMap((batch) => batch.changes.map((change) => change.status));
  const pending = statuses.length > 0 && statuses.every((status) => status === 'pending');
  return {
    batches: current.batches,
    message: pending
      ? 'Návrh uložen. Data se nezměnila; každou změnu schvaluje člověk v aplikaci.'
      : 'Tento běh už je evidován. Skutečné výsledky položek najdete v aplikaci; nový návrh nevznikl.',
    modules: results.map((entry) => entry.module),
    reviewUrl: SALES_AI_REVIEW_URL,
    status: pending ? 'pending' : 'already_recorded',
  };
};

export const registerSalesAiTools = (server: McpServer): void => {
  defineTool(
    server,
    'propose_sales_changes',
    'Pouze NAVRHNI změny příležitostí a objednávek Obchodní firmy. Data se tím nezmění: každou položku schválí nebo zamítne člověk na /cs/sprava/ke-schvaleni (Nastavení › Ke schválení), kde lze celý běh i vrátit („Vrátit vše“). Před návrhem načti list_opportunities / list_orders / list_employees / list_customers a použij existující id. Částky jsou v Kč. Jedna dávka může obsahovat nejvýše jednu změnu téhož záznamu. Pro opakování použij stejné runId. Návrh, který modul nepovolí (např. uzavřená příležitost, nepovolený přechod stavu objednávky), se odmítne hned.',
    {
      changes: z
        .array(z.object({ operation: salesAiOperation, reason: z.string().min(3).max(2000) }))
        .min(1)
        .max(20),
      instruction: z.string().min(3).max(2000).describe('The instruction you are working on, in the user’s words.'),
      runId: z.string().min(1).max(200).describe('Stable id of this run; repeating it never creates a duplicate.'),
    },
    proposeSalesChanges,
  );
  defineTool(
    server,
    'list_ai_proposals',
    'Načti poslední AI návrhy změn příležitostí a objednávek a jejich výsledek (čeká na schválení, provedeno, zamítnuto, vráceno, nelze provést). Volitelně jen pro jedno runId.',
    { runId: z.string().min(1).max(200).optional() },
    listAiProposals,
  );
};

