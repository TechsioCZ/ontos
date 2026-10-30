import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { createInstance } from 'i18next';

import cs from '../../locales/cs/workforce.json';
import en from '../../locales/en/workforce.json';

const prefix = 'workforce.pages.employees.aiActivity';
const cases = [
  { denied: 'Zamítnuto', executed: 'Provedeno', language: 'cs' },
  { denied: 'Denied', executed: 'Executed', language: 'en' },
];

for (const { denied, executed, language } of cases) {
  it.effect(`preserves ${language} activity counters across native plural categories`, () =>
    Effect.gen(function* activityCountTranslations() {
      const i18n = createInstance();
      yield* Effect.promise(() =>
        i18n.init({
          defaultNS: 'workforce',
          fallbackLng: false,
          initAsync: false,
          lng: language,
          ns: ['workforce'],
          resources: { cs: { workforce: cs }, en: { workforce: en } },
        }),
      );
      for (const count of [0, 1, 2, 4, 5, 11, 1.5]) {
        expect(i18n.t(`${prefix}.executed`, { count })).toBe(`${executed}: ${count}`);
        expect(i18n.t(`${prefix}.denied`, { count })).toBe(`${denied}: ${count}`);
      }
    }),
  );
}
