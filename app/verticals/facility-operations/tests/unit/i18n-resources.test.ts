import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { createInstance } from 'i18next';

import csBase from '../../locales/cs/facility-operations.json';
import enBase from '../../locales/en/facility-operations.json';
import {
  csResource,
  enResource,
  facilityOperationsI18nResources,
  withCsAgendaResources,
  withEnAgendaResources,
} from '../../src/i18n/resources.ts';

it('uses the runtime root Czech catalog while preserving all agenda translations', () => {
  const resource = withCsAgendaResources({
    ...csBase,
    'facility-operations': { ...csBase['facility-operations'], title: 'Runtime Czech title' },
  });
  expect(resource).toEqual({
    'facility-operations': { ...csResource['facility-operations'], title: 'Runtime Czech title' },
  });
  expect(csBase['facility-operations'].title).not.toBe('Runtime Czech title');
  expect(Object.keys(resource['facility-operations'])).toEqual(Object.keys(csResource['facility-operations']));
});

it('uses the runtime root English catalog while preserving all agenda translations', () => {
  const resource = withEnAgendaResources({
    ...enBase,
    'facility-operations': { ...enBase['facility-operations'], title: 'Runtime English title' },
  });
  expect(resource).toEqual({
    'facility-operations': { ...enResource['facility-operations'], title: 'Runtime English title' },
  });
  expect(enBase['facility-operations'].title).not.toBe('Runtime English title');
  expect(Object.keys(resource['facility-operations'])).toEqual(Object.keys(enResource['facility-operations']));
});

it.effect('resolves the existing history action copy for every native Czech and English count category', () =>
  Effect.gen(function* historyCountTranslations() {
    const i18n = createInstance();
    yield* Effect.promise(() =>
      i18n.init({
        defaultNS: 'facility-operations',
        fallbackLng: false,
        initAsync: false,
        lng: 'cs',
        ns: ['facility-operations'],
        resources: facilityOperationsI18nResources,
      }),
    );
    for (const count of [0, 1, 2, 4, 5, 11, 1.5]) {
      expect(i18n.t('facility-operations.common.history.more', { count, lng: 'cs' })).toBe(
        `Zobrazit starší (${count})`,
      );
      expect(i18n.t('facility-operations.common.history.more', { count, lng: 'en' })).toBe(`Show older (${count})`);
    }
  }),
);
