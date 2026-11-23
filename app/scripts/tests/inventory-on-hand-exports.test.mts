import { equal, ok } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Schema } from 'effect';

const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  exports: Schema.Record(Schema.String, Schema.Unknown),
})))(readFileSync(new URL('../../verticals/inventory/package.json', import.meta.url), 'utf8'));
const catalog = createRequire(new URL('../../verticals/catalog/src/products-admin/page-data.ts', import.meta.url));

test('Catalog resolves both on-hand imports directly to the existing Inventory owner files', () => {
  for (const [subpath, target] of [
    ['./api/catalog-variant-on-hand-page', './shared/apis/catalog-variant-on-hand-page.ts'],
    ['./api/catalog-variant-on-hand-page-client', './src/api/catalog-variant-on-hand-page-client.ts'],
  ] satisfies readonly (readonly [string, string])[]) {
    equal(manifest.exports[subpath], target);
    const ownerFile = new URL(`../../verticals/inventory/${target}`, import.meta.url);
    ok(existsSync(ownerFile));
    equal(catalog.resolve(`@app/inventory/${subpath.slice(2)}`), fileURLToPath(ownerFile));
  }
});

test('the source-provisioning exports remain present beside the restored on-hand API', () => {
  for (const subpath of [
    './actions/define-source-provisioning-policy',
    './api/source-stock-position-resolution',
    './api/provision-source-stock-item-action',
    './source-provisioning',
  ]) {
    ok(subpath in manifest.exports);
  }
});
