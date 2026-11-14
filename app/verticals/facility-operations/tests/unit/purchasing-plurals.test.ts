import { createInstance } from 'i18next';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import purchasing from '../../locales/cs/agendas/purchasing.json';

it.effect('declines purchasing lead times consistently in detail, availability and replenishment', () =>
  Effect.gen(function* purchasingPlurals() {
    const i18n = createInstance();
    yield* Effect.promise(() =>
      i18n.init({ fallbackLng: false, lng: 'cs', resources: { cs: { translation: purchasing } } }),
    );
    for (const [count, expected] of [
      [0, '0 dní'],
      [1, '1 den'],
      [2, '2 dny'],
      [4, '4 dny'],
      [5, '5 dní'],
      [21, '21 dní'],
    ] as const) {
      expect(i18n.t('leadTimeDays', { count })).toBe(expected);
      expect(i18n.t('plan.availableFrom', { count, date: '20. 10. 2026' })).toContain(expected);
      expect(i18n.t('replenish.leadTime', { count, date: '20. 10. 2026' })).toContain(expected);
    }
  }),
);
