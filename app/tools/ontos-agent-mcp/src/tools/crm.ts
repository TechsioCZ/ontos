import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Schema } from 'effect';
import { z } from 'zod';
import { applyCommand, defineTool, readRecordsOf, readRevision } from './shared.ts';

const text = z.string().max(200).optional();
const clientFields = {
  address: text,
  email: text,
  note: z.string().max(4000).optional(),
  phone: text,
  regNo: text,
  segment: text,
  vatNo: text,
  website: text,
};
const contactFields = {
  email: text,
  note: z.string().max(4000).optional(),
  phone: text,
  primary: z.boolean().optional(),
  role: text,
};
const operation = z.discriminatedUnion('_tag', [
  z.object({
    _tag: z.literal('CreateClient'),
    ...clientFields,
    kind: z.enum(['organization', 'person']),
    name: z.string().min(1).max(200),
    ownerSalespersonId: text,
    contacts: z
      .array(z.object({ ...contactFields, name: z.string().min(1).max(200) }))
      .max(20)
      .optional(),
  }),
  z.object({
    _tag: z.literal('UpdateClient'),
    id: z.string().min(1),
    patch: z.object({ ...clientFields, kind: z.enum(['organization', 'person']).optional(), name: text }),
  }),
  z.object({
    _tag: z.literal('AddContactPerson'),
    clientId: z.string().min(1),
    name: z.string().min(1).max(200),
    ...contactFields,
  }),
  z.object({
    _tag: z.literal('UpdateContactPerson'),
    contactId: z.string().min(1),
    patch: z.object({ ...contactFields, name: text }),
  }),
  z.object({
    _tag: z.literal('AssignClient'),
    clientId: z.string().min(1),
    toSalespersonId: text,
    reason: z.string().optional(),
  }),
  z.object({
    _tag: z.literal('PairOrder'),
    orderId: z.string().min(1),
    clientId: z.string().min(1),
    reason: z.string().min(3),
  }),
  z.object({ _tag: z.literal('UnpairOrder'), orderId: z.string().min(1), reason: z.string().min(3) }),
  z.object({
    _tag: z.literal('PlanContact'),
    clientId: z.string().min(1),
    dueDate: z.string(),
    note: z.string().optional(),
    salespersonId: text,
  }),
]);

export const registerCrmTools = (server: McpServer) => {
  defineTool(
    server,
    'list_crm',
    'Načti skutečné CRM Hanák: klienty, kontaktní osoby, obchodníky, importované objednávky a AI dávky s výsledkem schvalování. Použij existující id, nevymýšlej je. Objednávky jsou externí projekce, ne účetní doklady. CRM nemá obchodní příležitosti.',
    {},
    async () => await readRecordsOf('crm', Schema.Json),
  );
  defineTool(
    server,
    'propose_crm_changes',
    'Pouze NAVRHNI změny CRM. Žádný klient, kontakt, přidělení ani objednávka se tím nezmění. Každou položku schválí správce nebo vedoucí na /cs/crm/schvalovani-ai; tam je i Vrátit vše. Před návrhem načti list_crm. Jedna dávka může obsahovat nejvýše jednu změnu téže existující entity. Pro opakování použij stejné runId. Jiným modulům tento profil zapisovat nesmí.',
    {
      instruction: z.string().min(3).max(2000),
      runId: z.string().min(1).max(200),
      changes: z
        .array(z.object({ operation, reason: z.string().min(3).max(2000) }))
        .min(1)
        .max(20),
    },
    async ({ instruction, runId, changes }) => {
      const result = await applyCommand(
        'crm',
        Schema.Struct({ entityIds: Schema.Array(Schema.String), revision: Schema.Int }),
        { _tag: 'AiProposeChanges', agentLabel: 'AI asistent Hanák · úroveň C', instruction, runId, changes },
        async () => await readRevision('crm'),
      );
      const current = await readRecordsOf(
        'crm',
        Schema.Struct({
          state: Schema.Struct({
            aiChanges: Schema.Struct({
              changes: Schema.Array(Schema.Struct({ batchId: Schema.String, status: Schema.String })),
            }),
          }),
        }),
      );
      const statuses = current.state.aiChanges.changes
        .filter((change) => change.batchId === result.entityIds[0])
        .map((change) => change.status);
      const pending = statuses.length > 0 && statuses.every((status) => status === 'pending');
      return {
        result,
        statuses,
        status: pending ? 'pending' : 'already_recorded',
        message: pending
          ? 'Návrh uložen. Data se nezměnila; čeká na schválení člověkem.'
          : 'Tento běh už je evidován. Zkontrolujte skutečné výsledky položek v aplikaci; nový návrh nevznikl.',
        reviewUrl: 'http://localhost:3020/cs/crm/schvalovani-ai',
      };
    },
  );
};
