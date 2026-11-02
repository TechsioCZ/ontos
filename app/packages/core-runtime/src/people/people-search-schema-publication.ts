import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { fullyConsistent } from '../permissions/client.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../permissions/schema.ts';
import type { SpiceDbRpc } from '../permissions/spicedb-rpc.ts';

export class PeopleSearchSchemaPublicationError extends Schema.TaggedError<PeopleSearchSchemaPublicationError>()(
  'PeopleSearchSchemaPublicationError',
  {
    reason: Schema.String,
  },
) {}
const failure = (reason: string) => new PeopleSearchSchemaPublicationError({ reason });
const unavailable = (cause: unknown) =>
  Object.defineProperty(failure('People search schema publication is temporarily unavailable'), 'cause', {
    value: cause,
  });
const peopleRelations =
  '  // Core people containment inherits the directory permission, never a module reader grant.\n  relation people_company: legal_entity\n  relation people_tenant: tenant\n';
const previousRead = '  permission read = (reader + module->read_all) & module->access';
const peopleRead =
  '  permission read = ((reader + module->read_all) & module->access) + ((people_company->read_people + people_tenant->read_people) & people_company->access)';
const resourceStart = 'definition resource {\n  relation module: module_access\n';
export const PEOPLE_SEARCH_PREVIOUS_SCHEMA = ONTOS_SPICEDB_SCHEMA.replace(peopleRelations, '').replace(
  peopleRead,
  previousRead,
);
// The operator ships before runtime activation. Both releases derive the same exact predecessor/target pair.
export const PEOPLE_SEARCH_SCHEMA = PEOPLE_SEARCH_PREVIOUS_SCHEMA.replace(
  resourceStart,
  `${resourceStart}${peopleRelations}`,
).replace(previousRead, peopleRead);

type SchemaClient = Pick<SpiceDbRpc, 'readSchema' | 'diffSchema' | 'writeSchema'>;
/** Run only in an exclusive operator schema-publication window. This never writes grants or memberships. */
export const publishPeopleSearchSchema = Effect.fn('PeopleSearchSchemaPublication.publish')(function* publish(
  client: SchemaClient,
  apply: boolean,
) {
  if (
    !PEOPLE_SEARCH_SCHEMA.includes(`${resourceStart}${peopleRelations}`) ||
    !PEOPLE_SEARCH_SCHEMA.includes(peopleRead)
  ) {
    return yield* failure('The code-owned people schema does not match the reviewed additive transition');
  }
  const current = yield* client
    .diffSchema(v1.DiffSchemaRequest.create({ comparisonSchema: PEOPLE_SEARCH_SCHEMA, consistency: fullyConsistent }))
    .pipe(Effect.mapError(unavailable));
  if (current.diffs.length === 0) {
    return { status: 'unchanged' as const };
  }
  const previous = yield* client
    .diffSchema(
      v1.DiffSchemaRequest.create({ comparisonSchema: PEOPLE_SEARCH_PREVIOUS_SCHEMA, consistency: fullyConsistent }),
    )
    .pipe(Effect.mapError(unavailable));
  if (previous.diffs.length !== 0) {
    return yield* failure('The native schema is not the exact reviewed predecessor; no write was performed');
  }
  if (!apply) {
    return { status: 'ready' as const };
  }
  // Recheck the predecessor immediately before the write. The server exposes no schema CAS operation.
  const [snapshot, recheck] = yield* Effect.all(
    [
      client.readSchema(v1.ReadSchemaRequest.create({})),
      client.diffSchema(
        v1.DiffSchemaRequest.create({ comparisonSchema: PEOPLE_SEARCH_PREVIOUS_SCHEMA, consistency: fullyConsistent }),
      ),
    ],
    { concurrency: 2 },
  ).pipe(Effect.mapError(unavailable));
  yield* client.readSchema(v1.ReadSchemaRequest.create({})).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((beforeWrite) =>
      recheck.diffs.length !== 0 || beforeWrite.schemaText !== snapshot.schemaText
        ? Effect.fail(failure('The schema changed during publication; no write was performed'))
        : Effect.void,
    ),
  );
  yield* client
    .writeSchema(v1.WriteSchemaRequest.create({ schema: PEOPLE_SEARCH_SCHEMA }))
    .pipe(Effect.mapError(unavailable));
  const verified = yield* client
    .diffSchema(v1.DiffSchemaRequest.create({ comparisonSchema: PEOPLE_SEARCH_SCHEMA, consistency: fullyConsistent }))
    .pipe(Effect.mapError(unavailable));
  if (verified.diffs.length !== 0) {
    return yield* failure('The published schema could not be verified; stop before rebuilding people search');
  }
  return { status: 'published' as const };
});
