// Merges the base namespace with one locale file per agenda (locales/<lang>/agendas/<agenda>.json),
// so every lane edits only its own locale file. Keys: `facility-operations.<agenda>.<key>`.
import csAgenda from '../../locales/cs/agendas/agenda.json';
import csAssets from '../../locales/cs/agendas/assets.json';
import csDocuments from '../../locales/cs/agendas/documents.json';
import csMeters from '../../locales/cs/agendas/meters.json';
import csPurchasing from '../../locales/cs/agendas/purchasing.json';
import csSecurity from '../../locales/cs/agendas/security.json';
import csBase from '../../locales/cs/facility-operations.json';
import enAgenda from '../../locales/en/agendas/agenda.json';
import enAssets from '../../locales/en/agendas/assets.json';
import enDocuments from '../../locales/en/agendas/documents.json';
import enMeters from '../../locales/en/agendas/meters.json';
import enPurchasing from '../../locales/en/agendas/purchasing.json';
import enSecurity from '../../locales/en/agendas/security.json';
import enBase from '../../locales/en/facility-operations.json';

export const csResource = {
  'facility-operations': {
    ...csBase['facility-operations'],
    agenda: csAgenda,
    assets: csAssets,
    documents: csDocuments,
    meters: csMeters,
    purchasing: csPurchasing,
    security: csSecurity,
  },
};

export const enResource = {
  'facility-operations': {
    ...enBase['facility-operations'],
    agenda: enAgenda,
    assets: enAssets,
    documents: enDocuments,
    meters: enMeters,
    purchasing: enPurchasing,
    security: enSecurity,
  },
};

export const facilityOperationsI18nResources = {
  cs: { 'facility-operations': csResource },
  en: { 'facility-operations': enResource },
} as const;
