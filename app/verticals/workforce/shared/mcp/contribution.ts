/** Employee management tools offered to agents. */
import { defineOntosMcpContribution } from '@app/core-runtime';

export const workforceMcpContribution = defineOntosMcpContribution({
  approvals: true,
  commandFieldLabels: {
    email: 'E-mail',
    phone: 'Telefon',
  },
  commands: {
    BulkUpdateEmployees: { title: { cs: 'Hromadně upravit zaměstnance', en: 'Update employees in bulk' } },
    CreateEmployee: { title: { cs: 'Přidat zaměstnance', en: 'Add an employee' } },
    UpdateEmployee: { title: { cs: 'Upravit zaměstnance', en: 'Update an employee' } },
  },
  description: {
    cs: 'Organizační struktura, zaměstnanci a oddělení. Bez přidělování oprávnění.',
    en: 'Organization chart, employees and departments. Does not grant access.',
  },
  keywords: 'zaměstnanec zaměstnanci oddělení tým employee staff department team',
  label: { cs: 'Zaměstnanci', en: 'Employees' },
  page: '/prodej/zamestnanci',
  reads: {
    records: { title: { cs: 'Přehled zaměstnanců a oddělení', en: 'Employees and departments overview' } },
  },
  revision: { read: 'records' },
});
