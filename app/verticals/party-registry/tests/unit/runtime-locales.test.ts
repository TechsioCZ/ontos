import assert from 'node:assert/strict';
import test from 'node:test';
import { Predicate } from 'effect';
import runtime from '../../src/modern.runtime.ts';
import csResource from '../../locales/cs/translation.json' with { type: 'json' };
import enResource from '../../locales/en/translation.json' with { type: 'json' };

test('API-only runtime registers both existing locale resources without adding a business namespace', () => {
  const configuration = Predicate.isFunction(runtime) ? runtime('index') : runtime;
  const { i18n } = configuration;
  assert.ok(i18n?.i18nInstance);
  assert.deepEqual(i18n.initOptions?.resources, {
    cs: { translation: csResource },
    en: { translation: enResource },
  });
  assert.deepEqual(i18n.initOptions?.supportedLngs, ['en', 'cs']);
  assert.deepEqual(i18n.initOptions?.ns, ['translation']);
  assert.equal(i18n.initOptions?.defaultNS, 'translation');
  assert.equal(i18n.initOptions?.fallbackLng, 'en');
});
