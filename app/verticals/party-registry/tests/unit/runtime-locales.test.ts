import { expect, it } from '@app/effect-rstest';

import { Predicate } from 'effect';
import runtime from '../../src/modern.runtime.ts';
import csResource from '../../locales/cs/translation.json' with { type: 'json' };
import enResource from '../../locales/en/translation.json' with { type: 'json' };
import { partyRegistryI18nResources } from '../../src/i18n/resources.ts';

it('runtime registers the Party Registry page namespace alongside shared translations', () => {
  const configuration = Predicate.isFunction(runtime) ? runtime('index') : runtime;
  const { i18n } = configuration;
  expect(i18n?.i18nInstance).toBeTruthy();
  if (i18n?.i18nInstance === undefined) {
    throw new Error('Expected value to be present');
  }
  expect(i18n.initOptions?.resources).toEqual({
    cs: { ...partyRegistryI18nResources.cs, translation: csResource },
    en: { ...partyRegistryI18nResources.en, translation: enResource },
  });
  expect(i18n.initOptions?.supportedLngs).toEqual(['en', 'cs']);
  expect(i18n.initOptions?.ns).toEqual(['party-registry', 'translation']);
  expect(i18n.initOptions?.defaultNS).toBe('party-registry');
  expect(i18n.initOptions?.fallbackLng).toBe('en');
});
