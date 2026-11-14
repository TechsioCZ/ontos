// CRM locale resources (owned by crm-scaffold). Each area owns locales/<lang>/crm-<area>.json shaped
// `{ "<area>": { ... } }`; keys are read as t('crm.<area>.<key>'). Base keys live in locales/<lang>/crm.json.
import csBase from '../../locales/cs/crm.json';
import csClients from '../../locales/cs/crm-clients.json';
import csImports from '../../locales/cs/crm-imports.json';
import csReports from '../../locales/cs/crm-reports.json';
import csVisits from '../../locales/cs/crm-visits.json';
import enBase from '../../locales/en/crm.json';
import enClients from '../../locales/en/crm-clients.json';
import enImports from '../../locales/en/crm-imports.json';
import enReports from '../../locales/en/crm-reports.json';
import enVisits from '../../locales/en/crm-visits.json';

export const crmI18nResources = {
  cs: { crm: { crm: { ...csBase.crm, ...csClients, ...csVisits, ...csImports, ...csReports } } },
  en: { crm: { crm: { ...enBase.crm, ...enClients, ...enVisits, ...enImports, ...enReports } } },
} as const;
