import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  publishPeopleSearchSchema,
  PEOPLE_SEARCH_PREVIOUS_SCHEMA,
  PEOPLE_SEARCH_SCHEMA,
  PeopleSearchSchemaPublicationError,
} from '../../src/people/people-search-schema-publication.ts';

const difference = v1.DiffSchemaResponse.create({ diffs: [v1.ReflectionSchemaDiff.create({})] });
it.effect('schema dry-run validates exact predecessor without writing, and already-published is idempotent', () =>
  Effect.gen(function* noWrite() {
    for (const schema of [PEOPLE_SEARCH_SCHEMA, PEOPLE_SEARCH_PREVIOUS_SCHEMA]) {
      let writes = 0;
      const result = yield* publishPeopleSearchSchema(
        {
          diffSchema: ({ comparisonSchema }) =>
            Effect.succeed(comparisonSchema === schema ? v1.DiffSchemaResponse.create({}) : difference),
          readSchema: () => Effect.succeed(v1.ReadSchemaResponse.create({ schemaText: schema })),
          writeSchema: () => {
            writes += 1;
            return Effect.succeed(v1.WriteSchemaResponse.create({}));
          },
        },
        false,
      );
      expect(result.status).toBe(schema === PEOPLE_SEARCH_SCHEMA ? 'unchanged' : 'ready');
      expect(writes).toBe(0);
    }
  }),
);
it.effect('publishes only the exact additive schema, verifies natively, and does not expose grant operations', () =>
  Effect.gen(function* publish() {
    let schema = PEOPLE_SEARCH_PREVIOUS_SCHEMA;
    let writes = 0;
    const result = yield* publishPeopleSearchSchema(
      {
        diffSchema: ({ comparisonSchema }) =>
          Effect.succeed(comparisonSchema === schema ? v1.DiffSchemaResponse.create({}) : difference),
        readSchema: () => Effect.succeed(v1.ReadSchemaResponse.create({ schemaText: schema })),
        writeSchema: (request) => {
          ({ schema } = request);
          writes += 1;
          return Effect.succeed(v1.WriteSchemaResponse.create({}));
        },
      },
      true,
    );
    expect(result.status).toBe('published');
    expect(schema).toBe(PEOPLE_SEARCH_SCHEMA);
    expect(writes).toBe(1);
  }),
);
it.effect('unknown or concurrently changed native schema fails closed before any write', () =>
  Effect.gen(function* refuse() {
    let writes = 0;
    const unknown = yield* publishPeopleSearchSchema(
      {
        diffSchema: () => Effect.succeed(difference),
        readSchema: () => Effect.succeed(v1.ReadSchemaResponse.create({ schemaText: 'unknown' })),
        writeSchema: () => {
          writes += 1;
          return Effect.succeed(v1.WriteSchemaResponse.create({}));
        },
      },
      true,
    ).pipe(Effect.flip);
    expect(Schema.is(PeopleSearchSchemaPublicationError)(unknown)).toBe(true);
    let calls = 0;
    const concurrent = yield* publishPeopleSearchSchema(
      {
        diffSchema: ({ comparisonSchema }) => {
          calls += 1;
          return Effect.succeed(
            calls === 2 && comparisonSchema === PEOPLE_SEARCH_PREVIOUS_SCHEMA
              ? v1.DiffSchemaResponse.create({})
              : difference,
          );
        },
        readSchema: () => Effect.succeed(v1.ReadSchemaResponse.create({ schemaText: 'changed' })),
        writeSchema: () => {
          writes += 1;
          return Effect.succeed(v1.WriteSchemaResponse.create({}));
        },
      },
      true,
    ).pipe(Effect.flip);
    expect(Schema.is(PeopleSearchSchemaPublicationError)(concurrent)).toBe(true);
    expect(writes).toBe(0);
  }),
);
