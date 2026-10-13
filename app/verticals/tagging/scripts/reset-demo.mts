// Sales-demo owner seed for demo.tagging.
// Contract: app/scripts/demo/reset-demo.mts spawns this script with `--sales-demo`, DATABASE_ADMIN_URL
// and DEMO_RESET_PROFILE=sales in the environment, in a fixed owner order. IDs come from demoId() in
// app/scripts/demo/fixture-ids.mts; this script writes only the tagging state row of the demo tenant.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { demoId, demoLegalEntityId, demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import { TaggingStateSchema } from '../shared/apis/records.ts';
import type { SubjectKind, TagColor } from '../shared/apis/records.ts';
import { taggingRelations, taggingStates } from '../src/database/schema.ts';

class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}

interface SubjectRef {
  readonly key: string;
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

const refs = (kind: SubjectKind, keys: readonly string[]): readonly SubjectRef[] => keys.map((key) => ({ key, kind }));

const TAG_SEEDS: readonly TagSeed[] = [
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

/**
 * Encoded tagging state. Assignment times are spread deterministically over the last 90 days,
 * anchored at the reset time, so repeated resets keep the same tags and assignments.
 */
const seedState = (now: DateTime.Utc) => {
  const createdAt = DateTime.formatIso(DateTime.subtract(now, { days: 120 }));
  const tags = TAG_SEEDS.map((seed) => ({
    color: seed.color,
    createdAt,
    id: demoId('tag', seed.key),
    name: seed.name,
    subjectKinds: [...seed.subjectKinds],
    updatedAt: createdAt,
  }));
  const assignments = TAG_SEEDS.flatMap((seed) => seed.subjects.map((subject) => ({ seed, subject }))).map(
    (entry, index) => ({
      assignedAt: DateTime.formatIso(DateTime.subtract(now, { days: (index * 37) % 90, hours: (index * 5) % 24 })),
      subject: { id: demoId(entry.subject.kind, entry.subject.key), kind: entry.subject.kind },
      tagId: demoId('tag', entry.seed.key),
    }),
  );
  return { assignments, tags };
};

const writeState = Effect.fn('Tagging.writeDemoState')(function* writeDemoState() {
  const now = yield* DateTime.now;
  const state = yield* Schema.decodeUnknownEffect(TaggingStateSchema)(seedState(now));
  const encoded = yield* Schema.encodeEffect(TaggingStateSchema)(state);
  const db = yield* makeWithDefaults({ relations: taggingRelations });
  yield* db
    .insert(taggingStates)
    .values({
      legalEntityId: demoLegalEntityId,
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
    `Tagging demo state reset: ${TAG_SEEDS.length} tags, ${encoded.assignments.length} assignments`,
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
  readonly salesDemo: boolean;
  readonly validateOnly: boolean;
}) {
  if (!options.salesDemo) {
    return yield* new ResetInputError({ reason: '--sales-demo is required' });
  }
  // Validate-only is a no-op: nothing is written.
  if (options.validateOnly) {
    return yield* Console.log('tagging: sales-demo seed validated; no data changed');
  }
  return yield* writeState();
});

const cli = Command.make(
  'reset-tagging-demo',
  {
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
