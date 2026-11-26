#!/usr/bin/env node
// Fills one tenant of the stable sales environment with the demo stage's e-shop, through governed reads on stage and
// native merchandise Actions on stable, as the stable tenant owner. It only reads stage. Fresh stable, per shop:
//   cd app && for s in akros sroubshop n1; do node scripts/demo/copy-stage-catalog-to-stable.mts $s; done
// Steps (default all, in this order; name some to run only those):
//   catalog  category tree, products with variants, prices, parameters, public image URLs (skips by id / SKU)
//   stock    every product's and variant's stock on hand set to stage's (RECEIPT/ADJUSTMENT of the difference)
//   samples  the 8 synthetic sales-bootstrap products (SALES_PRODUCTS) hidden and archived out of the admin list
//   verify   products, in-stock products and stock differences versus stage
// Reads app/.zerops-stable/config.json and bootstrap-bundle.json (owner passwords; never printed). Every step is
// idempotent; rerun until catalog reports 0 failed and verify reports 0 differences. Work dir: ONTOS_COPY_DIR.
// ŠroubShop's stage photos are stage-only media; it takes the AKROS photos of the same SKU instead.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { connectSeedClient } from './seed-client.mts';
import { RecordsRequestSchema, RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import {
  ApplyCommandPayloadSchema,
  ApplyCommandResultSchema,
  CleanupDemoPayloadSchema,
  ManageCatalogPayloadSchema,
  RecordStockMovementPayloadSchema,
} from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { loadCatalog } from '../../../ops/zerops-stable/bootstrap.mjs';
import { loadStableConfig } from '../../../ops/zerops-stable/config.mjs';
import { parseBootstrapBundle, SALES_PRODUCTS } from '../../../ops/zerops-stable/gha-bootstrap.mjs';

const enc = Schema.toEncoded;
const slug = process.argv[2];
const STEPS = process.argv.length > 3 ? process.argv.slice(3) : ['catalog', 'stock', 'samples', 'verify'];
const D = `${process.env.ONTOS_COPY_DIR ?? path.join(tmpdir(), 'ontos-stable-catalog-copy')}/`;
mkdirSync(D, { recursive: true });
const STABLE = fileURLToPath(new URL('../../.zerops-stable/', import.meta.url));
const logFile = `${D}copy-${slug}.log`;
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  appendFileSync(logFile, `${line}\n`);
  console.log(line);
};
const SOURCE = { akros: 'eshop@akros.demo', n1: 'admin@n1.ontos.demo', sroubshop: 'eshop@sroubarna.demo' }[slug];
const stageOrigin = 'https://ontos-stage.web-revolution.cz';
const config = await loadStableConfig(`${STABLE}config.json`);
const bundle = parseBootstrapBundle(readFileSync(`${STABLE}bootstrap-bundle.json`, 'utf-8'), {
  catalog: loadCatalog(),
  config,
});
const written = bundle.accounts.tenants.find((t) => t.slug === slug);
const owner = written.accounts.find(({ grants }) => grants.owner);
const stageIdentity = async (email) => {
  const signIn = await fetch(`${stageOrigin}/shell-super-app-api/auth/sign-in`, {
    body: JSON.stringify({ email, password: 'password1234' }),
    headers: { 'content-type': 'application/json', origin: stageOrigin },
    method: 'POST',
  });
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return (await (await fetch(`${stageOrigin}/shell-super-app-api/auth/session`, { headers: { cookie } })).json())
    .identity;
};
const strip = (o, keys) =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => !keys.includes(k) && v !== undefined));
const PRODUCT_DROP = [
  'id',
  'createdAt',
  'updatedAt',
  'priceHistory',
  'contentHistory',
  'currentPriceMinor',
  'grossPriceMinor',
  'availability',
  'lowStock',
  'stockOnHand',
  'stockValueMinor',
  'vatRate',
  'searchMatch',
  'variantRecords',
  'variantCount',
  'variantSummary',
  'storefrontVariantPreview',
  'descriptionParagraphs',
  'gallery',
  'categoryPathIds',
  'relatedProductIds',
  'demoArchive',
];
const isMedia = (s) => typeof s === 'string' && s.startsWith('media:');
const reasonOf = (e) => String(e?.reason ?? e?.message ?? JSON.stringify(e));
const transient = (e) =>
  /HTTP 409|HTTP 50\d|TransportError|Transport error|fetch failed|timed out|Timeout|HTTP 429/u.test(reasonOf(e));

// A client that reconnects after a release change or a transport failure.
const makeClient = (label, connect) => {
  let current;
  const ensure = Effect.suspend(() =>
    current
      ? Effect.succeed(current)
      : connect().pipe(
          Effect.tap((c) =>
            Effect.sync(() => {
              current = c;
            }),
          ),
        ),
  );
  const run = (f, write = false) =>
    Effect.gen(function* run() {
      for (let attempt = 1; ; attempt += 1) {
        const r = yield* ensure.pipe(Effect.flatMap(f), Effect.result);
        if (r._tag === 'Success') {
          return r.success;
        }
        if (
          !transient(r.failure) ||
          attempt >= 30 ||
          (write &&
            !/gateway-context|sign-in|tenant\/switch|legal-entity\/switch|stage identity/u.test(reasonOf(r.failure)))
        ) {
          return yield* Effect.fail(r.failure);
        }
        log(label, 'retry', attempt, reasonOf(r.failure).slice(0, 160));
        current = undefined;
        yield* Effect.sleep(Duration.seconds(Math.min(60, attempt * 5)));
      }
    });
  return {
    call: (path, schema, payload) =>
      run((c) => c.call('merchandise', path, enc(schema), payload, enc(ApplyCommandResultSchema), true), true),
    read: (view) =>
      run((c) =>
        c.call('merchandise', '/reads/records', enc(RecordsRequestSchema), { view }, enc(RecordsResponseSchema)),
      ),
  };
};
const stageClient = (email) =>
  makeClient(`stage ${email}`, () =>
    Effect.tryPromise({
      catch: (e) => ({ reason: `TransportError stage identity ${e}` }),
      try: async () => await stageIdentity(email),
    }).pipe(
      Effect.flatMap((id) =>
        connectSeedClient(
          { legalEntityId: id.legalEntityId, shellUrl: `${stageOrigin}/`, tenantId: id.tenantId },
          email,
          Redacted.make('password1234'),
        ),
      ),
    ),
  );
const dump = (client, file) =>
  Effect.gen(function* dump() {
    const lines = existsSync(file) ? readFileSync(file, 'utf-8').split('\n').filter(Boolean) : [];
    let offset = lines.length;
    for (;;) {
      const res = yield* client.read({ limit: 250, offset, productSort: 'sku' });
      if (res.products.length > 0) {
        appendFileSync(file, `${res.products.map((p) => JSON.stringify(p)).join('\n')}\n`);
      }
      offset += res.products.length;
      if (res.products.length === 0 || offset >= res.indicators.productCount) {
        log('dumped', file, offset, 'of', res.indicators.productCount);
        break;
      }
    }
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  });
// Every product of a tenant, with variant records (stock on hand per variant), by SKU.
const listAll = (client, summary = false) =>
  Effect.gen(function* listAll() {
    const all = new Map();
    let revision = 0;
    for (let offset = 0; ;) {
      const res = yield* client.read({ limit: summary ? 250 : 50, offset, productSort: 'sku', summary });
      for (const p of res.products) {
        all.set(p.sku.trim().toLowerCase(), p);
      }
      ({ revision } = res);
      offset += res.products.length;
      if (res.products.length === 0 || offset >= res.indicators.productCount) {
        return { all, revision };
      }
    }
  });
// The stock lines of a product: one per variant when it has variants, else the product itself.
const stockLines = (p) =>
  (p.variantRecords ?? []).length > 0 ? new Map(p.variantRecords.map((v) => [v.id, v])) : new Map([['', p]]);
const stockDiffs = (stage, stable) => {
  const diffs = [];
  for (const [sku, s] of stage) {
    const t = stable.get(sku);
    if (!t) {
      continue;
    }
    const tl = stockLines(t);
    for (const [key, sl] of stockLines(s)) {
      const target = key === '' ? (tl.size === 1 ? tl.get('') : undefined) : tl.get(key);
      const delta = (sl.stockOnHand ?? 0) - (target?.stockOnHand ?? 0);
      if (target && delta !== 0) {
        diffs.push({ delta, productId: t.id, sku, variantId: key === '' ? undefined : target.id });
      }
    }
  }
  return diffs;
};
const program = Effect.gen(function* program() {
  const source = stageClient(SOURCE);
  const target = makeClient('stable', () =>
    connectSeedClient(
      { legalEntityId: written.legalEntity.legalEntityId, shellUrl: config.origins.shell, tenantId: written.tenantId },
      owner.email,
      Redacted.make(bundle.passwords.get(owner.email.toLowerCase())),
    ),
  );
  if (STEPS.includes('catalog')) {
    const akrosImages = new Map();
    if (slug === 'sroubshop') {
      for (const p of yield* dump(stageClient('eshop@akros.demo'), `${D}src-akros.jsonl`)) {
        akrosImages.set(p.sku.toLowerCase(), p);
        for (const v of p.variants ?? []) {
          if (v.sku) {
            akrosImages.set(`v:${v.sku.toLowerCase()}`, v);
          }
        }
      }
    }
    const srcTree = (yield* source.read({ includeCategories: true, limit: 0 })).categories ?? [];
    const tgtState = yield* target.read({ includeCategories: true, limit: 0 });
    let { revision } = tgtState;
    const have = new Set((tgtState.categories ?? []).map((c) => c.id));
    const byId = new Map(srcTree.map((c) => [c.id, c]));
    const depth = (c) => {
      let d = 0;
      let p = c.parentId;
      while (p && byId.has(p) && d < 50) {
        d += 1;
        p = byId.get(p).parentId;
      }
      return d;
    };
    let catFail = 0;
    let catOk = 0;
    const createdNow = new Set();
    for (const c of [...srcTree].sort((a, b) => depth(a) - depth(b))) {
      if (have.has(c.id)) {
        continue;
      }
      const command = strip(
        {
          _tag: 'CreateCategory',
          heading: c.heading,
          id: c.id,
          name: c.name,
          parentId: c.parentId ?? null,
          position: Math.max(0, Math.trunc(c.position)),
          published: c.published,
          // Stage keeps some legacy slugs (a-2_1, material-1.4404, din-7504-) that the slug rule refuses.
          slug: c.slug
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/gu, '-')
            .replaceAll(/^-+|-+$/gu, ''),
        },
        [],
      );
      let r = yield* target
        .call('/merchandise/actions/manage-catalog', ManageCatalogPayloadSchema, {
          command,
          expectedRevision: revision,
        })
        .pipe(Effect.result);
      if (r._tag === 'Failure' && command.slug !== c.slug) {
        // A repaired slug may meet an existing one; the category id keeps it unique.
        revision = (yield* target.read({ limit: 0, summary: true })).revision;
        r = yield* target
          .call('/merchandise/actions/manage-catalog', ManageCatalogPayloadSchema, {
            command: { ...command, slug: `${command.slug}-${c.id}` },
            expectedRevision: revision,
          })
          .pipe(Effect.result);
      }
      if (r._tag === 'Success') {
        revision = r.success.revision;
        catOk += 1;
        have.add(c.id);
        createdNow.add(c.id);
      } else {
        catFail += 1;
        log('category fail', c.id, c.slug, JSON.stringify(command).slice(0, 300), reasonOf(r.failure).slice(0, 600));
        revision = (yield* target.read({ limit: 0, summary: true })).revision;
      }
    }
    log('categories source', srcTree.length, 'created', catOk, 'failed', catFail);
    const products = yield* dump(source, `${D}src-${slug}.jsonl`);
    const existing = new Map();
    for (let offset = 0; ;) {
      const res = yield* target.read({ limit: 250, offset, productSort: 'sku', summary: true });
      for (const p of res.products) {
        existing.set(p.sku.trim().toLowerCase(), p.id);
      }
      offset += res.products.length;
      if (res.products.length === 0 || offset >= res.indicators.productCount) {
        break;
      }
    }
    log('target products before', existing.size, 'source', products.length);
    let fail = 0;
    let ok = 0;
    for (const p of products) {
      const stableId = existing.get(p.sku.trim().toLowerCase());
      if (stableId !== undefined) {
        // A product copied before its category existed gets the category now.
        const ids = [p.categoryId, ...(p.additionalCategoryIds ?? [])];
        if (ids.some((id) => createdNow.has(id))) {
          const patch = strip(
            {
              additionalCategoryIds: p.additionalCategoryIds?.filter((id) => have.has(id)),
              categoryId: have.has(p.categoryId) ? p.categoryId : undefined,
            },
            [],
          );
          const u = yield* target
            .call('/merchandise/actions/manage-catalog', ManageCatalogPayloadSchema, {
              command: { _tag: 'UpdateProduct', id: stableId, patch },
              expectedRevision: revision,
            })
            .pipe(Effect.result);
          if (u._tag === 'Success') {
            revision = u.success.revision;
            log('product category linked', p.sku, p.categoryId);
          } else {
            log('product category link fail', p.sku, reasonOf(u.failure).slice(0, 400));
            revision = (yield* target.read({ limit: 0, summary: true })).revision;
          }
        }
        continue;
      }
      const command = {
        ...strip(p, PRODUCT_DROP),
        _tag: 'CreateProduct',
        priceMinor: p.currentPriceMinor,
        taxClassificationCode: p.taxClassificationCode ?? 'cz.vat.standard',
      };
      if (command.categoryId && !have.has(command.categoryId)) {
        delete command.categoryId;
      }
      if (command.additionalCategoryIds) {
        command.additionalCategoryIds = command.additionalCategoryIds.filter((id) => have.has(id));
      }
      if (command.variants) {
        // Stage holds a few legacy products whose variants repeat a SKU, which the owner refuses; a repeat gets a suffix.
        const seenSkus = new Set();
        command.variants = command.variants.map((v) => {
          const out = strip(v, ['priceHistory', 'grossPriceMinor']);
          for (let n = 2; out.sku && seenSkus.has(out.sku.toLowerCase()); n += 1) {
            out.sku = `${v.sku}-${n}`;
          }
          if (out.sku) {
            seenSkus.add(out.sku.toLowerCase());
          }
          if (isMedia(out.imageSrc)) {
            const a = akrosImages.get(`v:${(v.sku ?? '').toLowerCase()}`);
            if (a?.imageSrc && !isMedia(a.imageSrc)) {
              out.imageSrc = a.imageSrc;
            } else {
              delete out.imageSrc;
            }
          }
          return out;
        });
      }
      if (isMedia(command.imageSrc) || (command.images ?? []).some(isMedia)) {
        const a = akrosImages.get(p.sku.toLowerCase());
        if (a && !isMedia(a.imageSrc)) {
          command.imageSrc = a.imageSrc;
          command.images = (a.images ?? []).filter((i) => !isMedia(i));
        } else {
          delete command.imageSrc;
          command.images = (command.images ?? []).filter((i) => !isMedia(i));
        }
      }
      const r = yield* target
        .call('/merchandise/actions/apply-command', ApplyCommandPayloadSchema, { command, expectedRevision: revision })
        .pipe(Effect.result);
      if (r._tag === 'Success') {
        revision = r.success.revision;
        ok += 1;
        existing.set(p.sku.trim().toLowerCase(), r.success.entityIds?.[0]);
      } else {
        fail += 1;
        log('product fail', p.sku, reasonOf(r.failure).slice(0, 1200));
        revision = (yield* target.read({ limit: 0, summary: true })).revision;
      }
      if ((ok + fail) % 100 === 0) {
        log('progress ok', ok, 'fail', fail);
      }
    }
    log('DONE products created', ok, 'failed', fail, 'target now', existing.size);
  }
  if (STEPS.includes('stock')) {
    const stage = (yield* listAll(source)).all;
    let { all: stable, revision } = yield* listAll(target);
    const diffs = stockDiffs(stage, stable);
    log('stock lines to correct', diffs.length);
    let ok = 0;
    let fail = 0;
    for (const d of diffs) {
      const command = strip(
        {
          _tag: 'RecordStockMovement',
          delta: d.delta,
          note: 'Stav skladu podle ukázkového prostředí',
          productId: d.productId,
          reason: d.delta > 0 ? 'RECEIPT' : 'ADJUSTMENT',
          variantId: d.variantId,
        },
        [],
      );
      const r = yield* target
        .call('/merchandise/actions/record-stock-movement', RecordStockMovementPayloadSchema, {
          command,
          expectedRevision: revision,
        })
        .pipe(Effect.result);
      if (r._tag === 'Success') {
        revision = r.success.revision;
        ok += 1;
      } else {
        fail += 1;
        log('stock fail', d.sku, d.variantId ?? '', reasonOf(r.failure).slice(0, 600));
        revision = (yield* target.read({ limit: 0, summary: true })).revision;
      }
      if ((ok + fail) % 200 === 0) {
        log('stock progress ok', ok, 'fail', fail);
      }
    }
    log('STOCK DONE movements', ok, 'failed', fail);
  }
  if (STEPS.includes('samples')) {
    for (const { sku } of SALES_PRODUCTS) {
      const res = yield* target.read({ limit: 5, search: sku, summary: true });
      let { revision } = res;
      const p = res.products.find((x) => x.sku.toLowerCase() === sku.toLowerCase());
      if (!p) {
        log('sample', sku, 'absent or archived');
        continue;
      }
      if (p.active !== false || p.published !== false) {
        revision = (yield* target.call('/merchandise/actions/manage-catalog', ManageCatalogPayloadSchema, {
          command: { _tag: 'UpdateProduct', id: p.id, patch: { active: false, published: false } },
          expectedRevision: revision,
        })).revision;
      }
      yield* target.call('/merchandise/actions/cleanup-demo', CleanupDemoPayloadSchema, {
        command: { _tag: 'ArchiveDemoProduct', id: p.id, reason: 'Ukázkový produkt prodejního prostředí' },
        expectedRevision: revision,
      });
      log('sample', sku, 'archived');
    }
  }
  if (STEPS.includes('verify')) {
    const stage = (yield* listAll(source)).all;
    const stable = (yield* listAll(target)).all;
    const inStock = (m) => [...m.values()].filter((p) => p.stockOnHand > 0).length;
    const missing = [...stage.keys()].filter((sku) => !stable.has(sku));
    const extra = [...stable.keys()].filter((sku) => !stage.has(sku));
    log(
      'VERIFY',
      JSON.stringify({
        extraOnStable: extra.slice(0, 20),
        inStockStable: inStock(stable),
        inStockStage: inStock(stage),
        missingOnStable: missing,
        productsStable: stable.size,
        productsStage: stage.size,
        stockDifferences: stockDiffs(stage, stable).length,
      }),
    );
  }
});
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))).catch((error) => {
  log('FATAL', reasonOf(error).slice(0, 1000));
  process.exitCode = 1;
});
