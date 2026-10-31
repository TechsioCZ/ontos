import { defineOntosMcpContribution } from '@app/core-runtime';

export const propertyPortfolioMcpContribution = defineOntosMcpContribution({
  approvals: true,
  commandFieldLabels: {
    address: 'Adresa',
    category: 'Kategorie',
    lifecycleState: 'Stav',
    name: 'Název',
    note: 'Poznámka',
    propertyRef: 'Nemovitost',
    reason: 'Důvod',
    serialNumber: 'Výrobní číslo',
    unitRef: 'Jednotka',
  },
  commands: {
    ArchiveProperty: { title: { cs: 'Archivovat nemovitost', en: 'Archive a property' } },
    ArchiveUnit: { title: { cs: 'Archivovat jednotku', en: 'Archive a unit' } },
    ChangeAssetLifecycle: { title: { cs: 'Změnit stav vybavení', en: 'Change an equipment lifecycle state' } },
    ChangePropertyLifecycle: { title: { cs: 'Změnit stav nemovitosti', en: 'Change a property lifecycle state' } },
    ChangeUnitLifecycle: { title: { cs: 'Změnit stav jednotky', en: 'Change a unit lifecycle state' } },
    CreateAsset: { title: { cs: 'Přidat vybavení jednotky', en: 'Add unit equipment' } },
    CreateProperty: { title: { cs: 'Vytvořit nemovitost', en: 'Create a property' } },
    CreateUnit: { title: { cs: 'Vytvořit jednotku', en: 'Create a unit' } },
    RestoreProperty: { destructive: false, title: { cs: 'Obnovit nemovitost', en: 'Restore a property' } },
    RestoreUnit: { destructive: false, title: { cs: 'Obnovit jednotku', en: 'Restore a unit' } },
    UpdateAsset: { title: { cs: 'Upravit vybavení jednotky', en: 'Update unit equipment' } },
    UpdateProperty: { title: { cs: 'Upravit nemovitost', en: 'Update a property' } },
    UpdateUnit: { title: { cs: 'Upravit jednotku', en: 'Update a unit' } },
  },
  description: { cs: 'Nemovitosti, jednotky a jejich vybavení.', en: 'Properties, units and their equipment.' },
  keywords: 'nemovitost nemovitosti budova areál jednotka byt kancelář prostor vybavení property building unit',
  label: { cs: 'Nemovitosti a jednotky', en: 'Properties and units' },
  page: '/nemovitosti',
  reads: {
    records: {
      title: { cs: 'Přehled nemovitostí, jednotek a vybavení', en: 'Properties, units and equipment overview' },
    },
  },
  revision: { read: 'records' },
});
