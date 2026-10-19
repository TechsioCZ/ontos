// Merges the base namespace with one locale file per agenda (locales/<lang>/agendas/<agenda>.json),
// so every lane edits only its own locale file. Keys: `siampark-ops.<agenda>.<key>`.
import csAgenda from '../../locales/cs/agendas/agenda.json';
import csAssets from '../../locales/cs/agendas/assets.json';
import csDocuments from '../../locales/cs/agendas/documents.json';
import csMeters from '../../locales/cs/agendas/meters.json';
import csPurchasing from '../../locales/cs/agendas/purchasing.json';
import csSecurity from '../../locales/cs/agendas/security.json';
import csBase from '../../locales/cs/siampark-ops.json';
import enAgenda from '../../locales/en/agendas/agenda.json';
import enAssets from '../../locales/en/agendas/assets.json';
import enDocuments from '../../locales/en/agendas/documents.json';
import enMeters from '../../locales/en/agendas/meters.json';
import enPurchasing from '../../locales/en/agendas/purchasing.json';
import enSecurity from '../../locales/en/agendas/security.json';
import enBase from '../../locales/en/siampark-ops.json';

export const csResource = {
  'siampark-ops': {
    ...csBase['siampark-ops'],
    agenda: csAgenda,
    assets: csAssets,
    documents: csDocuments,
    meters: csMeters,
    purchasing: csPurchasing,
    security: csSecurity,
  },
};

export const enResource = {
  'siampark-ops': {
    ...enBase['siampark-ops'],
    agenda: enAgenda,
    assets: enAssets,
    documents: enDocuments,
    meters: enMeters,
    purchasing: enPurchasing,
    security: enSecurity,
  },
};

export const siamparkOpsI18nResources = {
  cs: { 'siampark-ops': csResource },
  en: { 'siampark-ops': enResource },
} as const;
