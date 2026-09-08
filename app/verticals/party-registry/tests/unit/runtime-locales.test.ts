import assert from 'node:assert/strict';
import test from 'node:test';
import { Predicate } from 'effect';
import runtime from '../../src/modern.runtime.ts';
import csResource from '../../locales/cs/translation.json' with { type: 'json' };
import enResource from '../../locales/en/translation.json' with { type: 'json' };
import { partyRegistryI18nResources } from '../../src/i18n/resources.ts';

test('runtime registers the Party Registry page namespace alongside shared translations', () => {
  const configuration = Predicate.isFunction(runtime) ? runtime('index') : runtime;
  const { i18n } = configuration;
  assert.ok(i18n?.i18nInstance);
  assert.deepEqual(i18n.initOptions?.resources, {
    cs: { ...partyRegistryI18nResources.cs, translation: csResource },
    en: { ...partyRegistryI18nResources.en, translation: enResource },
  });
  assert.deepEqual(i18n.initOptions?.supportedLngs, ['en', 'cs']);
  assert.deepEqual(i18n.initOptions?.ns, ['party-registry', 'translation']);
  assert.equal(i18n.initOptions?.defaultNS, 'party-registry');
  assert.equal(i18n.initOptions?.fallbackLng, 'en');
});
