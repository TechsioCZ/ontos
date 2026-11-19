import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { MediaAssetNotFound, MediaUnavailable } from '../../src/media/errors.ts';
import { MediaAssetIdSchema } from '../../src/media/identity.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema } from '../../src/media/public-contract.ts';
import { mediaAssetRepositoryFromTransaction } from '../../src/media/repository.ts';
import type { MediaAssetRecord } from '../../src/media/repository.ts';
import { MediaStorageKeySchema, deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '44444444-4444-4444-8444-444444444444';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const bytes = (count: number) => Schema.decodeUnknownSync(MediaByteSizeSchema)(count);
const sha = (value: string) => Schema.decodeUnknownSync(MediaContentSha256Schema)(value);
const mediaAssetId = Schema.decodeUnknownSync(MediaAssetIdSchema)('55555555-5555-4555-8555-555555555555');
const trustedScope = (extra: { readonly legalEntityId?: string }) =>
  Object.freeze({
    ...Schema.decodeSync(TrustedPrincipalContextSchema)({
      authBindingId: '11111111-1111-4111-8111-111111111111',
      authContextRef: 'media-repository-fixture',
      authMethod: 'session',
      principalId,
      tenantId,
      ...extra,
    }),
    correlationId: 'media-repository-fixture',
  });
const scopeWith = (withLegalEntity: boolean) => trustedScope(withLegalEntity ? { legalEntityId } : {});

const epoch = DateTime.toDateUtc(DateTime.makeUnsafe(0));
const baseRecord: MediaAssetRecord = {
  byteSize: 5n,
  contentSha256: null,
  createdAt: epoch,
  displayFilename: 'a.png',
  externalSourceRef: null,
  ingestedByPrincipalId: null,
  ingestionSource: 'user',
  legalEntityId: null,
  mediaAssetId,
  mimeType: 'image/png',
  originalFilename: null,
  processingStatus: 'uploaded',
  sealedAt: null,
  storageKey: deriveMediaStorageKey({ mediaAssetId, tenantId }),
  storageObjectVersionRef: null,
  storageProvider: 'provider',
  tenantId,
  updatedAt: epoch,
};

/** The scripted connection answers positionally, so a row follows the table's column order. */
const COLUMN_ORDER = [
  'mediaAssetId',
  'tenantId',
  'legalEntityId',
  'ingestedByPrincipalId',
  'ingestionSource',
  'externalSourceRef',
  'storageProvider',
  'storageKey',
  'storageObjectVersionRef',
  'originalFilename',
  'displayFilename',
  'mimeType',
  'byteSize',
  'contentSha256',
  'sealedAt',
  'processingStatus',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof MediaAssetRecord)[];
const row = (overrides: Partial<MediaAssetRecord> = {}) => {
  const record = { ...baseRecord, ...overrides };
  return Object.fromEntries(COLUMN_ORDER.map((column) => [column, record[column]]));
};

interface Statement {
  readonly parameters: readonly unknown[];
  readonly sql: string;
}

const whereOf = (statement: Statement | undefined) => statement?.sql.split(' where ')[1] ?? '';

/** A repository over a scripted database; `answers` serves each `core.media_assets` statement in order. */
const fixture = Effect.fn('MediaRepositoryFixture.make')(function* fixture(
  answers: readonly (readonly object[] | Effect.Effect<never, SqlError>)[],
  withLegalEntity = false,
) {
  const statements: Statement[] = [];
  const remaining = [...answers];
  const scope = scopeWith(withLegalEntity);
  const database = yield* makeTestDatabase((sql, parameters) => {
    if (sql.includes('current_setting')) {
      return Effect.succeed([{ legal_entity_id: scope.legalEntityId ?? '', tenant_id: scope.tenantId }]);
    }
    if (sql.includes('"core"."media_assets"')) {
      statements.push({ parameters, sql });
      const next = remaining.shift() ?? [];
      return Effect.isEffect(next) ? next : Effect.succeed(next);
    }
    return Effect.succeed([]);
  });
  const installed = yield* installOperationalScope(database, scope);
  return { repository: mediaAssetRepositoryFromTransaction(installed), statements };
});

it.effect('finds an asset only by the scope tenant and its id, tenant-wide when no company is selected', () =>
  Effect.gen(function* tenantWideFind() {
    const { repository, statements } = yield* fixture([[row()]]);
    expect((yield* repository.find(mediaAssetId)).mediaAssetId).toBe(mediaAssetId);
    const [statement] = statements;
    expect(statement?.sql).toContain('"tenant_id" =');
    expect(statement?.sql).toContain('"media_asset_id" =');
    expect(whereOf(statement)).not.toContain('legal_entity_id');
    expect(statement?.parameters).toContain(tenantId);
    expect(statement?.parameters).toContain(mediaAssetId);
  }),
);

it.effect('narrows to the selected company plus company-less assets, as an owner-local predicate', () =>
  Effect.gen(function* narrowedFind() {
    const { repository, statements } = yield* fixture([[row()]], true);
    yield* repository.find(mediaAssetId);
    expect(whereOf(statements[0])).toMatch(
      /"legal_entity_id" is null\)\) or \("core"\."media_assets"\."legal_entity_id" = \$3\)/u,
    );
    expect(statements[0]?.parameters).toContain(legalEntityId);
  }),
);

it.effect('answers a missing or foreign asset with the same not-found, and an ambiguous identity as unavailable', () =>
  Effect.gen(function* notFoundAndAmbiguous() {
    const { repository } = yield* fixture([[], [row(), row()]]);
    expect(Schema.is(MediaAssetNotFound)(yield* Effect.flip(repository.find(mediaAssetId)))).toBe(true);
    expect(Schema.is(MediaUnavailable)(yield* Effect.flip(repository.find(mediaAssetId)))).toBe(true);
  }),
);

it.effect('maps a database failure to an unavailable asset without leaking its diagnostic', () =>
  Effect.gen(function* persistenceFailure() {
    const failure = Effect.fail(
      new SqlError({ reason: new ConnectionError({ cause: 'synthetic secret host=db.internal' }) }),
    );
    const { repository } = yield* fixture([failure]);
    const error = yield* Effect.flip(repository.find(mediaAssetId));
    expect(Schema.is(MediaUnavailable)(error)).toBe(true);
    const wire = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Union([MediaUnavailable, MediaAssetNotFound])),
    )(error);
    expect(wire).not.toContain('db.internal');
  }),
);

it.effect('reserves an uploaded asset with the trusted tenant and company and a key derived from its own id', () =>
  Effect.gen(function* reserve() {
    const expectedKey = deriveMediaStorageKey({ mediaAssetId, tenantId });
    const { repository, statements } = yield* fixture([[row({ legalEntityId })]], true);
    const reserved = yield* repository.reserve({
      byteSize: bytes(5),
      displayFilename: 'a.png',
      ingestionSource: 'user',
      mediaAssetId,
      mimeType: 'image/png',
      storageProvider: 'provider',
    });
    expect(Schema.is(MediaStorageKeySchema)(reserved.storageKey)).toBe(true);
    const [statement] = statements;
    expect(statement?.sql).toMatch(/^insert into "core"\."media_assets"/iu);
    expect(statement?.parameters).toEqual(
      expect.arrayContaining([tenantId, legalEntityId, 'uploaded', expectedKey, 'provider', 5n]),
    );
  }),
);

it.effect('moves uploaded to ready only through a guarded update that seals the confirmed bytes', () =>
  Effect.gen(function* readyTransition() {
    const digest = sha('b'.repeat(64));
    const { repository, statements } = yield* fixture([[row({ contentSha256: digest, processingStatus: 'ready' })]]);
    const outcome = yield* repository.transition(mediaAssetId, {
      confirmed: { byteSize: bytes(7), contentSha256: digest, storageObjectVersionRef: 'v1' },
      to: 'ready',
    });
    expect(outcome.kind).toBe('applied');
    const [statement] = statements;
    expect(statement?.sql).toMatch(/^update "core"\."media_assets"/iu);
    expect(statement?.sql).toContain('"processing_status" in (');
    expect(statement?.sql).toContain('"sealed_at" =');
    expect(statement?.parameters).toEqual(expect.arrayContaining([tenantId, mediaAssetId, 'ready', digest, 7n]));
    // The guard names exactly the statuses allowed to enter ready; ready itself is not one of them.
    expect(statement?.parameters).toEqual(expect.arrayContaining(['uploaded', 'scanning']));
    expect(statement?.parameters.filter((value) => value === 'ready')).toHaveLength(1);
  }),
);

it.effect('leaves a ready asset untouched and reports it as rejected rather than regressing it', () =>
  Effect.gen(function* noRegress() {
    const ready = row({ contentSha256: 'c'.repeat(64), processingStatus: 'ready' });
    const { repository, statements } = yield* fixture([[], [ready]]);
    const outcome = yield* repository.transition(mediaAssetId, { to: 'failed' });
    expect(outcome).toEqual({ current: ready, kind: 'rejected' });
    expect(statements[0]?.sql).toMatch(/^update/iu);
    expect(statements[0]?.parameters).not.toContain('ready');
  }),
);

it.effect('reports a transition of a missing asset as not found', () =>
  Effect.gen(function* missingTransition() {
    const { repository } = yield* fixture([[], []]);
    expect(
      Schema.is(MediaAssetNotFound)(yield* Effect.flip(repository.transition(mediaAssetId, { to: 'scanning' }))),
    ).toBe(true);
  }),
);

it.effect('renames only the display file name inside the scope', () =>
  Effect.gen(function* rename() {
    const { repository, statements } = yield* fixture([[row({ displayFilename: 'b.png' })]]);
    expect((yield* repository.renameDisplayFilename(mediaAssetId, 'b.png')).displayFilename).toBe('b.png');
    expect(statements[0]?.sql).toContain('"display_filename" =');
    expect(statements[0]?.sql).not.toMatch(/"storage_key" =|"original_filename" =|"processing_status" =/u);
  }),
);

it.effect('finds a storage identity inside the tenant and treats two owners as an invariant defect', () =>
  Effect.gen(function* storageIdentity() {
    const storageKey = deriveMediaStorageKey({ mediaAssetId, tenantId });
    const { repository, statements } = yield* fixture([[], [row()], [row(), row()]]);
    expect(yield* repository.findByStorageIdentity({ storageKey, storageProvider: 'provider' })).toEqual(Option.none());
    expect(
      (yield* repository.findByStorageIdentity({ storageKey, storageProvider: 'provider' })).pipe(
        Option.map((found) => found.mediaAssetId),
      ),
    ).toEqual(Option.some(mediaAssetId));
    expect(
      Schema.is(MediaUnavailable)(
        yield* Effect.flip(repository.findByStorageIdentity({ storageKey, storageProvider: 'provider' })),
      ),
    ).toBe(true);
    expect(statements[0]?.parameters).toEqual(expect.arrayContaining([tenantId, 'provider', storageKey]));
  }),
);
