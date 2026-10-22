/** Tag management and assignment tools offered to agents. */
import { defineOntosMcpContribution } from '@app/core-runtime';

export const taggingMcpContribution = defineOntosMcpContribution({
  approvals: true,
  commands: {
    AssignTag: { title: { cs: 'Přiřadit štítek', en: 'Assign a tag' } },
    CreateTag: { title: { cs: 'Vytvořit štítek', en: 'Create a tag' } },
    DeleteTag: { title: { cs: 'Smazat štítek', en: 'Delete a tag' } },
    UnassignTag: { title: { cs: 'Odebrat štítek', en: 'Unassign a tag' } },
    UpdateTag: { title: { cs: 'Upravit štítek', en: 'Update a tag' } },
  },
  description: {
    cs: 'Štítky a jejich přiřazení k zákazníkům, objednávkám, produktům, zaměstnancům a příležitostem.',
    en: 'Tags and their assignment to customers, orders, products, employees and opportunities.',
  },
  keywords: 'štítek štítky označení přiřazení tag label assignment',
  label: { cs: 'Štítky', en: 'Tags' },
  page: '/nastaveni/stitky',
  reads: {
    records: { title: { cs: 'Přehled štítků a přiřazení', en: 'Tags and assignments overview' } },
  },
  revision: { read: 'records' },
});
