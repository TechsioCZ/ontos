/** Customer relationship activity tools offered to agents. */
import { defineOntosMcpContribution } from '@app/core-runtime';

export const crmActivitiesMcpContribution = defineOntosMcpContribution({
  approvals: true,
  commandFieldLabels: {
    kind: 'Druh',
  },
  commands: {
    RecordActivity: { title: { cs: 'Zaznamenat aktivitu', en: 'Record an activity' } },
  },
  description: {
    cs: 'Historie komunikace a aktivit u zákazníků a obchodních partnerů, návazné úkoly a odpovědné osoby.',
    en: 'Customer and partner communication and activity history, follow-up tasks and responsible people.',
  },
  keywords:
    'aktivita komunikace zákazník partner schůzka telefon e-mail historie úkol activity communication customer partner meeting call history follow-up',
  label: { cs: 'Aktivity', en: 'Activities' },
  page: '/aktivity',
  reads: {
    records: { title: { cs: 'Přehled aktivit a komunikace', en: 'Activities and communication overview' } },
  },
  revision: { read: 'records' },
});
