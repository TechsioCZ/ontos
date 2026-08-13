import type { Resources } from '@modern-js/plugin-i18n/runtime';
import type csResource from '../../locales/cs/crm.json';
type CrmLocaleResource = typeof csResource;
export declare const createCrmI18nResources: (resources: Record<'cs' | 'en', CrmLocaleResource>) => Resources;
export declare const crmFallbackLanguage = "en";
export declare const crmSupportedLanguages: string[];
export {};
