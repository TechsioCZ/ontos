import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';
import { createUltramodernApiRuntimeConfig } from '@app/shared-contracts';

import csResource from '../locales/cs/commerce-customer-context.json';
import enResource from '../locales/en/commerce-customer-context.json';

const i18nInstance = createInstance();

export default defineRuntimeConfig(
  createUltramodernApiRuntimeConfig({
    csResource,
    enResource,
    i18nInstance,
  }),
);
