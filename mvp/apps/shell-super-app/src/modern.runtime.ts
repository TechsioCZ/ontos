import { flattenLocaleResource } from '@mvp/shared-contracts';
import { defineRuntimeConfig } from '@modern-js/runtime';
import { ultramodernBoundaryDebuggerPlugin } from '@modern-js/runtime/boundary-debugger';
import { createInstance } from 'i18next';
import csResource from '../locales/cs/shell.json';
import enResource from '../locales/en/shell.json';
import { ultramodernRouteNamespace } from './routes/ultramodern-route-metadata';

const i18nInstance = createInstance();
const resources = {
  cs: { [ultramodernRouteNamespace]: flattenLocaleResource(csResource) },
  en: { [ultramodernRouteNamespace]: flattenLocaleResource(enResource) },
} as const;

export default defineRuntimeConfig({
  i18n: {
    i18nInstance,
    initOptions: {
      defaultNS: ultramodernRouteNamespace,
      fallbackLng: 'en',
      interpolation: {
        escapeValue: false,
      },
      ns: [ultramodernRouteNamespace, 'translation'],
      resources,
      supportedLngs: ['en', 'cs'],
    },
  },
  plugins: [
    ultramodernBoundaryDebuggerPlugin({
      metadata: {
        appId: 'shell-super-app',
        boundaries: [
          {
            appId: 'shell-super-app',
            label: 'Shell Super App',
            mfName: 'shellSuperApp',
            ownerTeam: 'super-app-platform',
            packageName: '@mvp/shell-super-app',
            role: 'host',
          },
          {
            appId: 'property-registry',
            label: 'PropertyRegistry Vertical',
            mfName: 'verticalPropertyRegistry',
            ownerTeam: 'super-app-platform',
            packageName: '@mvp/property-registry',
            role: 'vertical',
          },
          {
            appId: 'accounting-core',
            label: 'AccountingCore Vertical',
            mfName: 'verticalAccountingCore',
            ownerTeam: 'super-app-platform',
            packageName: '@mvp/accounting-core',
            role: 'vertical',
          },
        ],
        schemaVersion: 1,
      },
    }),
  ],

  router: {
    framework: 'tanstack',
  },
});
