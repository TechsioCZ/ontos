import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withoutUndefined } from '../ontos-client.ts';
import { OPPORTUNITY_STAGE_CS, labelOf } from './labels.ts';
import {
  applyCommand,
  CALENDAR_DATE,
  czkFromMinor,
  defineTool,
  minorFromCzk,
  readRecordsOf,
  readRevision,
  VERTICAL,
} from './shared.ts';
import { OpportunitiesRecordsWire, OpportunityCommandResultWire } from './wire.ts';
import type { OpportunityWire } from './wire.ts';

type Opportunity = typeof OpportunityWire.Type;

export const OPPORTUNITY_STAGES = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const;
const VAT_RATES = [0, 10, 12, 21] as const;

const idSchema = z.string().min(1).max(300);

export const listOpportunitiesInput = {
  ownerEmployeeId: idSchema.optional().describe('Employee id of the opportunity owner (see list_employees).'),
  partyId: idSchema.optional().describe('Customer partyId (see list_customers).'),
  stage: z.enum(OPPORTUNITY_STAGES).optional().describe('Pipeline stage filter.'),
};

export const createOpportunityInput = {
  expectedCloseDate: z.string().regex(CALENDAR_DATE).describe('Expected close date, YYYY-MM-DD.'),
  lines: z
    .array(
      z.object({
        productId: z
          .string()
          .uuid()
          .optional()
          .describe('Product id from merchandise, when the line is a catalogue product.'),
        productName: z.string().min(1).max(300),
        quantity: z.number().int().min(1),
        unitPriceCzk: z.number().min(0).describe('Unit price in CZK without VAT (number, not minor units).'),
        vatRate: z.union([z.literal(0), z.literal(10), z.literal(12), z.literal(21)]).describe('VAT rate in percent.'),
      }),
    )
    .max(200)
    .optional()
    .describe('Product lines. Amount is the sum of quantity times unit price.'),
  note: z.string().max(2000).optional(),
  ownerEmployeeId: idSchema.optional().describe('Owner employee id (see list_employees).'),
  partyId: idSchema.describe('Customer partyId (see list_customers).'),
  probability: z.number().int().min(0).max(100).optional().describe('Win probability in whole percent.'),
  title: z.string().min(1).max(200),
};

export const updateOpportunityInput = {
  id: idSchema.describe('Opportunity id.'),
  note: z.string().max(2000).optional().describe('Note stored with a stage change.'),
  ownerEmployeeId: z
    .union([idSchema, z.null()])
    .optional()
    .describe('New owner employee id, or null to clear the owner. Omit to leave the owner unchanged.'),
  stage: z.enum(OPPORTUNITY_STAGES).optional().describe('New pipeline stage.'),
};

const opportunitySummary = (o: Opportunity) => ({
  amountCzk: czkFromMinor(o.amountMinor),
  expectedCloseDate: o.expectedCloseDate,
  id: o.id,
  ownerEmployeeId: o.ownerEmployeeId ?? null,
  partyId: o.partyId,
  probabilityPct: o.probability,
  stage: o.stage,
  stageCs: labelOf(OPPORTUNITY_STAGE_CS, o.stage),
  title: o.title,
});

export const listOpportunities = async (input: {
  readonly ownerEmployeeId?: string | undefined;
  readonly partyId?: string | undefined;
  readonly stage?: (typeof OPPORTUNITY_STAGES)[number] | undefined;
}) => {
  const response = await readRecordsOf(
    VERTICAL.salesPipeline,
    OpportunitiesRecordsWire,
    withoutUndefined({ ownerEmployeeId: input.ownerEmployeeId, partyId: input.partyId, stage: input.stage }),
  );
  const { indicators } = response;
  return {
    count: response.items.length,
    items: response.items.map(opportunitySummary),
    revision: response.revision,
    summary: {
      lostCount: indicators.lostCount,
      openCount: indicators.openCount,
      openValueCzk: czkFromMinor(indicators.openValueMinor),
      weightedValueCzk: czkFromMinor(indicators.weightedValueMinor),
      winRatePct: indicators.winRate === null ? null : Math.round(indicators.winRate * 1000) / 10,
      wonCount: indicators.wonCount,
      wonValueCzk: czkFromMinor(indicators.wonValueMinor),
    },
  };
};

export const createOpportunity = async (input: {
  readonly expectedCloseDate: string;
  readonly lines?: readonly {
    readonly productId?: string | undefined;
    readonly productName: string;
    readonly quantity: number;
    readonly unitPriceCzk: number;
    readonly vatRate: (typeof VAT_RATES)[number];
  }[];
  readonly note?: string | undefined;
  readonly ownerEmployeeId?: string | undefined;
  readonly partyId: string;
  readonly probability?: number | undefined;
  readonly title: string;
}) => {
  const command = withoutUndefined({
    _tag: 'CreateOpportunity',
    expectedCloseDate: input.expectedCloseDate,
    lines: (input.lines ?? []).map((line) =>
      withoutUndefined({
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        unitPriceMinor: minorFromCzk(line.unitPriceCzk),
        vatRate: line.vatRate,
      }),
    ),
    note: input.note,
    ownerEmployeeId: input.ownerEmployeeId,
    partyId: input.partyId,
    probability: input.probability,
    title: input.title,
  });
  const result = await applyCommand(
    VERTICAL.salesPipeline,
    OpportunityCommandResultWire,
    command,
    async () => await readRevision(VERTICAL.salesPipeline),
  );
  const [created] = result.opportunities;
  return { created: created === undefined ? null : opportunitySummary(created), revision: result.revision };
};

export const updateOpportunity = async (input: {
  readonly id: string;
  readonly note?: string | undefined;
  readonly ownerEmployeeId?: string | null | undefined;
  readonly stage?: (typeof OPPORTUNITY_STAGES)[number] | undefined;
}) => {
  if (input.stage === undefined && input.ownerEmployeeId === undefined) {
    throw new Error('Zadejte stage nebo ownerEmployeeId (null pro zrušení obchodníka).');
  }
  const query = { ids: [input.id] };
  const currentRevision = async () => await readRevision(VERTICAL.salesPipeline, query);
  const current = await readRecordsOf(VERTICAL.salesPipeline, OpportunitiesRecordsWire, query);
  if (current.items.length === 0) {
    throw new Error(`Příležitost ${input.id} nebyla nalezena.`);
  }

  const changed: string[] = [];
  let { revision } = current;
  let latest: Opportunity | undefined = current.items[0];
  if (input.ownerEmployeeId !== undefined) {
    const result = await applyCommand(
      VERTICAL.salesPipeline,
      OpportunityCommandResultWire,
      { _tag: 'AssignOpportunity', id: input.id, ownerEmployeeId: input.ownerEmployeeId },
      currentRevision,
      revision,
    );
    ({ revision } = result);
    latest = result.opportunities[0] ?? latest;
    changed.push('ownerEmployeeId');
  }
  if (input.stage !== undefined) {
    const result = await applyCommand(
      VERTICAL.salesPipeline,
      OpportunityCommandResultWire,
      withoutUndefined({ _tag: 'ChangeOpportunityStage', id: input.id, note: input.note, toStage: input.stage }),
      currentRevision,
      revision,
    );
    ({ revision } = result);
    latest = result.opportunities[0] ?? latest;
    changed.push('stage');
  }
  return {
    changed,
    opportunity: latest === undefined ? null : opportunitySummary(latest),
    revision,
  };
};

export const registerSalesTools = (server: McpServer): void => {
  defineTool(
    server,
    'list_opportunities',
    'List sales opportunities (příležitosti) with stage, owner, amount in CZK and a pipeline summary (open value, weighted value, win rate). Optional stage, owner and customer filters.',
    listOpportunitiesInput,
    listOpportunities,
  );
  defineTool(
    server,
    'create_opportunity',
    'Create an opportunity (příležitost) for a customer. Amounts are CZK numbers; lines are optional. Writes through the sales-pipeline apply-command with the current revision.',
    createOpportunityInput,
    createOpportunity,
  );
  defineTool(
    server,
    'update_opportunity',
    'Change an opportunity stage and/or owner. Pass ownerEmployeeId null to clear the owner. Writes through the sales-pipeline apply-command.',
    updateOpportunityInput,
    updateOpportunity,
  );
};
