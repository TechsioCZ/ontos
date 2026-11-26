#!/usr/bin/env node
// Loads the demo stage's catalogue of one tenant (category tree, products with variants, prices, parameters and
// public image URLs) into the matching tenant of the stable sales environment, through governed reads on stage and
// native merchandise Actions on stable, as the stable tenant owner. It only reads stage.
//   cd app && node scripts/demo/copy-stage-catalog-to-stable.mts <akros|sroubshop|n1> [work-dir]
// Reads app/.zerops-stable/config.json and bootstrap-bundle.json (owner passwords; never printed). Idempotent:
// categories are skipped by id, products by SKU; the stage dump in work-dir resumes. Rerun until it reports 0 failed.
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
  ManageCatalogPayloadSchema,
} from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { loadCatalog } from '../../../ops/zerops-stable/bootstrap.mjs';
import { loadStableConfig } from '../../../ops/zerops-stable/config.mjs';
import { parseBootstrapBundle } from '../../../ops/zerops-stable/gha-bootstrap.mjs';

const enc = Schema.toEncoded;
const slug = process.argv[2];
const D = `${process.argv[3] ?? path.join(tmpdir(), 'ontos-stable-catalog-copy')}/`;
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
const program = Effect.gen(function* program() {
  const source = stageClient(SOURCE);
  const target = makeClient('stable', () =>
    connectSeedClient(
      { legalEntityId: written.legalEntity.legalEntityId, shellUrl: config.origins.shell, tenantId: written.tenantId },
      owner.email,
      Redacted.make(bundle.passwords.get(owner.email.toLowerCase())),
    ),
  );
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
        slug: c.slug,
      },
      [],
    );
    const r = yield* target
      .call('/merchandise/actions/manage-catalog', ManageCatalogPayloadSchema, { command, expectedRevision: revision })
      .pipe(Effect.result);
    if (r._tag === 'Success') {
      revision = r.success.revision;
      catOk += 1;
      have.add(c.id);
    } else {
      catFail += 1;
      revision = (yield* target.read({ limit: 0, summary: true })).revision;
    }
  }
  log('categories source', srcTree.length, 'created', catOk, 'failed', catFail);
  const products = yield* dump(source, `${D}src-${slug}.jsonl`);
  const existing = new Set();
  for (let offset = 0; ;) {
    const res = yield* target.read({ limit: 250, offset, productSort: 'sku', summary: true });
    for (const p of res.products) {
      existing.add(p.sku.trim().toLowerCase());
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
    if (existing.has(p.sku.trim().toLowerCase())) {
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
      command.variants = command.variants.map((v) => {
        const out = strip(v, ['priceHistory', 'grossPriceMinor']);
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
      existing.add(p.sku.trim().toLowerCase());
    } else {
      fail += 1;
      if (fail <= 10) {
        log('product fail', p.sku, reasonOf(r.failure).slice(0, 400));
      }
      revision = (yield* target.read({ limit: 0, summary: true })).revision;
    }
    if ((ok + fail) % 100 === 0) {
      log('progress ok', ok, 'fail', fail);
    }
  }
  log('DONE products created', ok, 'failed', fail, 'target now', existing.size);
});
await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))).catch((error) => {
  log('FATAL', reasonOf(error).slice(0, 1000));
  process.exitCode = 1;
});
