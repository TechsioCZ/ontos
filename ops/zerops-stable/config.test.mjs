import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { StableConfigError, loadStableConfig, validateStableConfig } from './config.mjs';

const examplePath = fileURLToPath(new URL('example.config.json', import.meta.url));
const example = () => JSON.parse(readFileSync(examplePath, 'utf8'));
const rejects = (change, field) => {
  const config = example();
  change(config);
  assert.throws(() => validateStableConfig(config), (error) => {
    assert.ok(error instanceof StableConfigError);
    assert.match(error.message, new RegExp(field.replaceAll(/[.[\]]/gu, '\\$&'), 'u'));
    return true;
  });
};

test('the example config is valid, normalized and frozen', async () => {
  const config = await loadStableConfig(examplePath);
  assert.equal(config.projectId, 'STABLEproject000000000');
  assert.deepEqual(Object.keys(config.variables), ['app', 'storefront', 'shop', 'n1', 'spicedb']);
  assert.ok(Object.isFrozen(config.variables.app));
  assert.deepEqual(validateStableConfig(config), config);
});

test('normalizes UUIDs and JSON policies', () => {
  const config = example();
  config.variables.shop.ONTOS_STOREFRONT_LEGAL_ENTITY_ID = '00000000-0000-4000-8000-00000000000A';
  config.variables.storefront.ONTOS_STOREFRONT_ERP_OFFERS = JSON.stringify(
    JSON.parse(config.variables.storefront.ONTOS_STOREFRONT_ERP_OFFERS),
    null,
    2,
  );
  const normalized = validateStableConfig(config);
  assert.equal(normalized.variables.shop.ONTOS_STOREFRONT_LEGAL_ENTITY_ID, '00000000-0000-4000-8000-00000000000a');
  assert.doesNotMatch(normalized.variables.storefront.ONTOS_STOREFRONT_ERP_OFFERS, /\n/u);
});

test('the stable project is not the demo project', () => {
  rejects((config) => (config.projectId = config.demoProjectId), 'projectId');
  rejects((config) => (config.services.app = config.demoProjectId), 'services.app');
  rejects((config) => (config.services.shop = config.services.storefront), 'services.shop');
  rejects((config) => delete config.services.db18, 'services');
});

test('origins are distinct bare https origins', () => {
  rejects((config) => (config.origins.shell = 'http://ontos.example.com'), 'origins.shell');
  rejects((config) => (config.origins.shell = 'https://ontos.example.com/'), 'origins.shell');
  rejects((config) => (config.origins.shell = 'https://ontos.example.com:8443'), 'origins.shell');
  rejects((config) => (config.origins.n1 = config.origins.shop), 'origins.n1');
  rejects((config) => delete config.origins.n1, 'origins');
});

test('storefront identities are explicit and distinct', () => {
  rejects((config) => delete config.variables.storefront.STOREFRONT_BRAND, 'variables.storefront');
  rejects((config) => delete config.variables.n1.ONTOS_STOREFRONT_TENANT_ID, 'variables.n1');
  rejects(
    (config) => (config.variables.shop.ONTOS_STOREFRONT_APP_ID = config.variables.storefront.ONTOS_STOREFRONT_APP_ID),
    'variables.shop.ONTOS_STOREFRONT_APP_ID',
  );
  rejects((config) => (config.variables.n1.STOREFRONT_IMAGE_HOSTS = 'n1.example.com, cdn.example.com'), 'variables.n1.STOREFRONT_IMAGE_HOSTS');
});

test('an ERP offer is keyed by its own storefront only', () => {
  rejects((config) => {
    config.variables.shop.ONTOS_STOREFRONT_ERP_OFFERS = config.variables.storefront.ONTOS_STOREFRONT_ERP_OFFERS;
  }, 'variables.shop.ONTOS_STOREFRONT_ERP_OFFERS');
});

test('mail sender and account are explicit', () => {
  rejects((config) => delete config.variables.app.SMTP_FROM, 'variables.app');
  rejects((config) => (config.variables.app.SMTP_FROM = 'OntOS'), 'variables.app.SMTP_FROM');
  rejects((config) => (config.variables.app.CLOUDFLARE_EMAIL_ACCOUNT_ID = 'account'), 'variables.app.CLOUDFLARE_EMAIL_ACCOUNT_ID');
});

test('takes no variable outside its setup allow-list and never echoes a value', () => {
  const secret = 'postgresql://user:hunter2-not-for-logs@db/x';
  const config = example();
  config.variables.app.DATABASE_URL = secret;
  assert.throws(() => validateStableConfig(config), (error) => !error.message.includes('hunter2') && /DATABASE_URL/u.test(error.message));
  const invalid = example();
  invalid.variables.app.SMTP_FROM = 'hunter2-not-for-logs';
  assert.throws(() => validateStableConfig(invalid), (error) => !error.message.includes('hunter2'));
  rejects((value) => (value.variables.spicedb.SPICEDB_LOG_LEVEL = 'debug'), 'variables.spicedb');
});

test('loadStableConfig names an unreadable file', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-stable-config-'));
  const file = path.join(directory, 'config.json');
  writeFileSync(file, '{ not json');
  await assert.rejects(loadStableConfig(file), StableConfigError);
});
