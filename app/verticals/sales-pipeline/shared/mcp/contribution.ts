/** Sales opportunity tools offered to agents, without approval plumbing. */
import { defineOntosMcpContribution } from '@app/core-runtime';

export const salesPipelineMcpContribution = defineOntosMcpContribution({
  approvals: true,
  approvalsPage: { label: { cs: 'Otevřít v Prodeji', en: 'Open in Sales' }, path: '/prodej/schvalovani-ai' },
  commandFieldLabels: {
    expectedCloseDate: 'Předpokládané uzavření',
    lines: 'Položky',
    note: 'Poznámka',
    partyId: 'Zákazník',
    probability: 'Pravděpodobnost',
    stage: 'Fáze',
    title: 'Název',
    toStage: 'Nová fáze',
  },
  commands: {
    AiDecideChanges: 'hidden',
    AiProposeChanges: 'hidden',
    AiRevertBatch: 'hidden',
    ArchiveOpportunity: { title: { cs: 'Archivovat příležitost', en: 'Archive an opportunity' } },
    AssignOpportunity: {
      title: { cs: 'Přiřadit příležitost obchodníkovi', en: 'Assign an opportunity to a salesperson' },
    },
    BulkUpdateOpportunities: { title: { cs: 'Hromadně upravit příležitosti', en: 'Update opportunities in bulk' } },
    ChangeOpportunityStage: { title: { cs: 'Změnit fázi příležitosti', en: 'Change an opportunity stage' } },
    CreateOpportunity: { title: { cs: 'Vytvořit příležitost', en: 'Create an opportunity' } },
    UpdateOpportunity: { title: { cs: 'Upravit příležitost', en: 'Update an opportunity' } },
  },
  description: {
    cs: 'Příležitosti, jejich fáze, hodnoty a odpovědní obchodníci.',
    en: 'Sales opportunities, their stages, values and responsible salespeople.',
  },
  keywords: 'obchod obchodní případ příležitost fáze nabídka prodej deal opportunity pipeline sales stage',
  label: { cs: 'Obchodní příležitosti', en: 'Sales opportunities' },
  ownProposalEngine: true,
  page: '/prodej/prilezitosti',
  reads: {
    records: { title: { cs: 'Přehled obchodních příležitostí', en: 'Sales opportunities overview' } },
  },
  revision: { read: 'records' },
});
