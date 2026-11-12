import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import type { ReactNode } from 'react';
import csResource from '../../locales/cs/tagging.json';
import enResource from '../../locales/en/tagging.json';

/** Resources for the tagging namespace. Pages and shared controls both wrap their copy in this boundary. */
export const taggingI18nResources = {
  cs: { tagging: csResource },
  en: { tagging: enResource },
} as const;

export const TagI18n = ({ children }: { children: ReactNode }) => (
  <FederatedI18nBoundary
    defaultNamespace="tagging"
    fallbackLanguage="en"
    resources={taggingI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    {children}
  </FederatedI18nBoundary>
);
