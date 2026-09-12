import { defineRuntimeConfig } from '@modern-js/runtime';
import { createInstance } from 'i18next';
import { createUltramodernApiRuntimeConfig } from '@app/shared-contracts';

import csResource from '../locales/cs/payment-term-catalog.json';
import enResource from '../locales/en/payment-term-catalog.json';

const i18nInstance = createInstance();

export default defineRuntimeConfig(
  createUltramodernApiRuntimeConfig({
    csResource,
    enResource,
    i18nInstance,
  }),
);
