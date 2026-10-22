/** Employee management tools offered to agents. */
import { defineOntosMcpContribution } from '@app/core-runtime';

export const workforceMcpContribution = defineOntosMcpContribution({
  approvals: true,
  commands: {
    BulkUpdateEmployees: { title: { cs: 'Hromadně upravit zaměstnance', en: 'Update employees in bulk' } },
    CreateEmployee: { title: { cs: 'Přidat zaměstnance', en: 'Add an employee' } },
    UpdateEmployee: { title: { cs: 'Upravit zaměstnance', en: 'Update an employee' } },
  },
  description: {
    cs: 'Zaměstnanci, jejich role a oddělení.',
    en: 'Employees, their roles and departments.',
  },
  keywords: 'zaměstnanec zaměstnanci lidé role oddělení tým employee staff people role department team',
  label: { cs: 'Lidé a role', en: 'People and roles' },
  page: '/prodej/zamestnanci',
  reads: {
    records: { title: { cs: 'Přehled zaměstnanců, rolí a oddělení', en: 'Employees, roles and departments overview' } },
  },
  revision: { read: 'records' },
});
