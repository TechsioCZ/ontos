// Sales-demo owner seed for demo.tagging.
// Contract: app/scripts/demo/reset-demo.mts spawns this script with `--sales-demo`, DATABASE_ADMIN_URL
// and DEMO_RESET_PROFILE=sales in the environment, in a fixed owner order. IDs come from demoId() in
// app/scripts/demo/fixture-ids.mts. `--sales-demo` resets the tagging state row of the trading company (0020) and
// adds the e-shop catalogues; `--company-catalogues` only adds the e-shop catalogues.
//
// E-shop companies (Kavárna Doma 0023, AKROS 0024): their administrators hold read-only Štítky, so no Action can
// create these tags. Their products and orders have deterministic IDs (merchandise seed-eshop/seed-akros), so the
// catalogue is written here, and only for a company that has no tagging state yet: existing tags are never touched.
// Nájempark and Velkoobchod Hanák tags go through the public Actions: app/scripts/demo/seed-company-content.mts.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import {
  akrosDemoLegalEntityId,
  demoId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
} from '../../../scripts/demo/fixture-ids.mts';
import { TaggingStateSchema } from '../shared/apis/records.ts';
import type { SubjectKind, TagColor } from '../shared/apis/records.ts';
import { taggingRelations, taggingStates } from '../src/database/schema.ts';

class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}

interface SubjectRef {
  readonly id: string;
  readonly kind: SubjectKind;
}

interface TagSeed {
  readonly color: TagColor;
  readonly key: string;
  readonly name: string;
  readonly subjectKinds: readonly SubjectKind[];
  readonly subjects: readonly SubjectRef[];
}

/** Zero-padded keys from `from` to `to` inclusive, e.g. keysFrom('c', 36, 38) -> c36, c37, c38. */
const keysFrom = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, offset) => `${prefix}${String(from + offset).padStart(2, '0')}`);

const refs = (
  kind: SubjectKind,
  keys: readonly string[],
  idOf: (key: string) => string = (key) => demoId(kind, key),
): readonly SubjectRef[] => keys.map((key) => ({ id: idOf(key), kind }));

const SALES_TAG_SEEDS: readonly TagSeed[] = [
  {
    color: 'yellow',
    key: 'vip',
    name: 'VIP',
    subjectKinds: ['customer'],
    subjects: refs('customer', ['c01', 'c02', 'c05', 'c08', 'c13']),
  },
  {
    color: 'red',
    key: 'riziko',
    name: 'Riziko',
    subjectKinds: ['customer', 'order'],
    subjects: refs('customer', ['c07', 'c19', 'c31']),
  },
  {
    color: 'green',
    key: 'novy',
    name: 'Nový zákazník',
    subjectKinds: ['customer'],
    subjects: refs('customer', keysFrom('c', 36, 40)),
  },
  {
    color: 'purple',
    key: 'strategicky',
    name: 'Strategický',
    subjectKinds: ['customer', 'opportunity'],
    subjects: [...refs('customer', ['c01', 'c05', 'c13']), ...refs('opportunity', ['o01', 'o02', 'o03', 'o10'])],
  },
  {
    color: 'orange',
    key: 'vyprodej',
    name: 'Výprodej',
    subjectKinds: ['product'],
    subjects: refs('product', keysFrom('p', 18, 21)),
  },
  {
    color: 'blue',
    key: 'klicovy-produkt',
    name: 'Klíčový produkt',
    subjectKinds: ['product'],
    subjects: refs('product', ['p01', 'p02', 'p05', 'p09']),
  },
  {
    color: 'gray',
    key: 'senior',
    name: 'Senior',
    subjectKinds: ['employee'],
    subjects: refs('employee', ['obchod', 'martin-kucera', 'jiri-horak']),
  },
  {
    color: 'pink',
    key: 'expres',
    name: 'Expresní',
    subjectKinds: ['order'],
    subjects: [],
  },
  {
    color: 'blue',
    key: 'velka-zakazka',
    name: 'Velká zakázka',
    subjectKinds: ['opportunity'],
    subjects: refs('opportunity', ['o01', 'o04', 'o07']),
  },
];

/** Kavárna Doma: products by catalogue slug (`demoId('eshop.product', slug)`), orders o1–o6 (`demoId('eshop.order', key)`). */
const kavarnaProducts = (slugs: readonly string[]) => refs('product', slugs, (slug) => demoId('eshop.product', slug));
const kavarnaOrders = (keys: readonly string[]) => refs('order', keys, (key) => demoId('eshop.order', key));
const KAVARNA_TAG_SEEDS: readonly TagSeed[] = [
  {
    color: 'yellow',
    key: 'bestseller',
    name: 'Bestseller',
    subjectKinds: ['product'],
    subjects: kavarnaProducts(['espresso-domaci-smes', 'etiopie-yirgacheffe', 'kolumbie-huila', 'hario-v60']),
  },
  {
    color: 'orange',
    key: 'vanocni-nabidka',
    name: 'Vánoční nabídka',
    subjectKinds: ['product'],
    subjects: kavarnaProducts(['darkova-sada-objevitel', 'cajova-kazeta', 'sada-domaci-barista']),
  },
  {
    color: 'red',
    key: 'doplnit-zasoby',
    name: 'Doplnit zásoby',
    subjectKinds: ['product'],
    subjects: kavarnaProducts([
      'guatemala-antigua',
      'rwanda-nyamasheke',
      'darjeeling-first-flush',
      'filtry-v60',
      'timemore-c3',
    ]),
  },
  {
    color: 'purple',
    key: 'mikrolot',
    name: 'Mikrolot',
    subjectKinds: ['product'],
    subjects: kavarnaProducts(['rwanda-nyamasheke', 'kena-aa-nyeri']),
  },
  {
    color: 'green',
    key: 'bez-kofeinu',
    name: 'Bez kofeinu',
    subjectKinds: ['product'],
    subjects: kavarnaProducts(['kolumbie-decaf-mleta', 'rooibos-vanilka']),
  },
  {
    color: 'pink',
    key: 'darkove-baleni',
    name: 'Dárkové balení',
    subjectKinds: ['order'],
    subjects: kavarnaOrders(['o3']),
  },
  {
    color: 'blue',
    key: 'priorita-expedice',
    name: 'Priorita expedice',
    subjectKinds: ['order'],
    subjects: kavarnaOrders(['o3', 'o4']),
  },
  {
    color: 'gray',
    key: 'osobni-odber',
    name: 'Osobní odběr',
    subjectKinds: ['order'],
    subjects: kavarnaOrders(['o5']),
  },
];

/** AKROS: catalogue product IDs (`product-<source id>`), sample orders by position (`demoId('akros.order', index)`). */
const akrosProducts = (ids: readonly string[]) => refs('product', ids, (id) => `product-${id}`);
const akrosOrders = (indexes: readonly string[]) => refs('order', indexes, (index) => demoId('akros.order', index));
const AKROS_TAG_SEEDS: readonly TagSeed[] = [
  {
    color: 'orange',
    key: 'akcni-cena',
    name: 'Akční cena',
    subjectKinds: ['product'],
    subjects: akrosProducts(['16619', '15867', '21474']),
  },
  {
    color: 'green',
    key: 'novinka',
    name: 'Novinka v sortimentu',
    subjectKinds: ['product'],
    subjects: akrosProducts(['20182', '21783', '21827', '26348']),
  },
  {
    color: 'gray',
    key: 'na-objednavku',
    name: 'Na objednávku',
    subjectKinds: ['product'],
    subjects: akrosProducts(['22689', '28900', '25978', '25677']),
  },
  {
    color: 'blue',
    key: 'namorni-prostredi',
    name: 'Námořní prostředí (A4)',
    subjectKinds: ['product'],
    subjects: akrosProducts(['22970', '24094', '21090', '22397', '21600']),
  },
  {
    color: 'yellow',
    key: 'fotovoltaika',
    name: 'Fotovoltaika',
    subjectKinds: ['product'],
    subjects: akrosProducts(['17872']),
  },
  {
    color: 'red',
    key: 'expresni-expedice',
    name: 'Expresní expedice',
    subjectKinds: ['order'],
    subjects: akrosOrders(['1', '2']),
  },
  {
    color: 'pink',
    key: 'overit-platbu',
    name: 'Ověřit platbu',
    subjectKinds: ['order'],
    subjects: akrosOrders(['0']),
  },
];

interface CompanyCatalogue {
  readonly key: string;
  readonly label: string;
  readonly legalEntityId: string;
  readonly tags: readonly TagSeed[];
}
const salesCatalogue: CompanyCatalogue = {
  key: '',
  label: 'Obchodní firma',
  legalEntityId: demoLegalEntityId,
  tags: SALES_TAG_SEEDS,
};
const eshopCatalogues: readonly CompanyCatalogue[] = [
  { key: 'kavarna', label: 'Kavárna Doma', legalEntityId: eshopDemoLegalEntityId, tags: KAVARNA_TAG_SEEDS },
  { key: 'akros', label: 'AKROS', legalEntityId: akrosDemoLegalEntityId, tags: AKROS_TAG_SEEDS },
];

/** Trading-company tag IDs keep their original keys; other companies prefix theirs, e.g. `kavarna:bestseller`. */
const tagIdOf = (catalogue: CompanyCatalogue, seed: TagSeed) =>
  demoId('tag', catalogue.key === '' ? seed.key : `${catalogue.key}:${seed.key}`);

/**
 * Encoded tagging state. Assignment times are spread deterministically over the last 90 days,
 * anchored at the reset time, so repeated resets keep the same tags and assignments.
 */
const seedState = (catalogue: CompanyCatalogue, now: DateTime.Utc) => {
  const createdAt = DateTime.formatIso(DateTime.subtract(now, { days: 120 }));
  const tags = catalogue.tags.map((seed) => ({
    color: seed.color,
    createdAt,
    id: tagIdOf(catalogue, seed),
    name: seed.name,
    subjectKinds: [...seed.subjectKinds],
    updatedAt: createdAt,
  }));
  const assignments = catalogue.tags
    .flatMap((seed) => seed.subjects.map((subject) => ({ seed, subject })))
    .map((entry, index) => ({
      assignedAt: DateTime.formatIso(DateTime.subtract(now, { days: (index * 37) % 90, hours: (index * 5) % 24 })),
      subject: { id: entry.subject.id, kind: entry.subject.kind },
      tagId: tagIdOf(catalogue, entry.seed),
    }));
  return { assignments, tags };
};

const encodeCatalogue = Effect.fn('Tagging.encodeCatalogue')(function* encodeCatalogue(
  catalogue: CompanyCatalogue,
  now: DateTime.Utc,
) {
  const state = yield* Schema.decodeUnknownEffect(TaggingStateSchema)(seedState(catalogue, now));
  return yield* Schema.encodeEffect(TaggingStateSchema)(state);
});

/** Resets the trading company's tagging state to the seed at revision 0. */
const resetSalesState = Effect.fn('Tagging.resetSalesState')(function* resetSalesState(now: DateTime.Utc) {
  const encoded = yield* encodeCatalogue(salesCatalogue, now);
  const db = yield* makeWithDefaults({ relations: taggingRelations });
  yield* db
    .insert(taggingStates)
    .values({
      legalEntityId: salesCatalogue.legalEntityId,
      revision: 0,
      state: encoded,
      tenantId: demoTenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 0, state: encoded, updatedAt: DateTime.toDateUtc(now) },
      target: [taggingStates.tenantId, taggingStates.legalEntityId],
    });
  return yield* Console.log(
    `Tagging demo state reset: ${salesCatalogue.tags.length} tags, ${encoded.assignments.length} assignments`,
  );
});

/** Adds an e-shop company's catalogue only when the company has no tagging state yet; existing tags stay untouched. */
const addEshopCatalogue = Effect.fn('Tagging.addEshopCatalogue')(function* addEshopCatalogue(
  catalogue: CompanyCatalogue,
  now: DateTime.Utc,
) {
  const encoded = yield* encodeCatalogue(catalogue, now);
  const db = yield* makeWithDefaults({ relations: taggingRelations });
  const inserted = yield* db
    .insert(taggingStates)
    .values({
      legalEntityId: catalogue.legalEntityId,
      revision: 0,
      state: encoded,
      tenantId: demoTenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoNothing()
    .returning({ revision: taggingStates.revision });
  return yield* Console.log(
    inserted.length === 1
      ? `Tagging ${catalogue.label}: ${catalogue.tags.length} tags, ${encoded.assignments.length} assignments added`
      : `Tagging ${catalogue.label}: company already has Štítky; unchanged`,
  );
});

const resetPgLive = PgClient.layerFrom(
  Effect.gen(function* resetPool() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
);

const resetDemo = Effect.fn('Tagging.resetDemo')(function* resetDemo(options: {
  readonly companyCatalogues: boolean;
  readonly salesDemo: boolean;
  readonly validateOnly: boolean;
}) {
  if (!options.salesDemo && !options.companyCatalogues) {
    return yield* new ResetInputError({ reason: '--sales-demo or --company-catalogues is required' });
  }
  const now = yield* DateTime.now;
  // Validate-only builds and decodes every catalogue; nothing is written.
  if (options.validateOnly) {
    const encoded = yield* Effect.forEach([salesCatalogue, ...eshopCatalogues], (catalogue) =>
      encodeCatalogue(catalogue, now),
    );
    return yield* Console.log(
      `tagging: seeds validated (tags per company: ${encoded.map((state) => state.tags.length).join(', ')}); no data changed`,
    );
  }
  if (options.salesDemo) {
    yield* resetSalesState(now);
  }
  return yield* Effect.forEach(eshopCatalogues, (catalogue) => addEshopCatalogue(catalogue, now), {
    concurrency: 1,
    discard: true,
  });
});

const cli = Command.make(
  'reset-tagging-demo',
  {
    companyCatalogues: Flag.Boolean('company-catalogues').pipe(Flag.withDefault(false)),
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  resetDemo,
);

const mainLive = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(resetPgLive),
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(mainLive)));
