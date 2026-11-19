import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { MediaAssetNotFound, MediaUnavailable } from '../../src/media/errors.ts';
import { MediaAssetIdSchema } from '../../src/media/identity.ts';
import { makeMediaAssetRepository } from '../../src/media/repository.ts';
import type { ReserveMediaAssetInput } from '../../src/media/repository.ts';
import { MediaByteSizeSchema, MediaContentSha256Schema } from '../../src/media/public-contract.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';

/*
 * The Media repository against PostgreSQL: what the owner's own constraints and guarded updates enforce, which a
 * scripted database cannot show. Fixtures are written by the administrative login and removed afterwards; the
 * repository itself runs through the runtime login inside a Core scoped transaction.
 */

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const bytes = (count: number) => Schema.decodeUnknownSync(MediaByteSizeSchema)(count);
const sha = (value: string) => Schema.decodeUnknownSync(MediaContentSha256Schema)(value);
const digest = sha('c'.repeat(64));

interface Tenant {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const insertTenant = Effect.fn('CoreMediaRepositoryTest.insertTenant')(function* insertTenant(
  admin: PgClient.PgClient,
) {
  const tenantId = yield* nextUuid;
  const principalId = yield* nextUuid;
  const legalEntityId = yield* nextUuid;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* cleanTenant() {
      yield* admin.unsafe('delete from core.media_assets where tenant_id = $1', [tenantId]);
      yield* admin.unsafe('delete from core.legal_entities where tenant_id = $1', [tenantId]);
      yield* admin.unsafe('delete from core.principals where tenant_id = $1', [tenantId]);
      yield* admin.unsafe('delete from core.tenants where tenant_id = $1', [tenantId]);
    }).pipe(Effect.orDie),
  );
  yield* admin.unsafe(
    `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Media tenant', 'active', 'en')`,
    [tenantId, `media-${tenantId}`],
  );
  yield* admin.unsafe(
    `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'human', 'Media principal', 'active')`,
    [principalId, tenantId],
  );
  yield* admin.unsafe(
    `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, 'Media company', 'CZ', $3, 'active')`,
    [legalEntityId, tenantId, legalEntityId],
  );
  return { legalEntityId, principalId, tenantId } satisfies Tenant;
});

const scopeOf = (tenant: Tenant, legalEntityId: string | undefined) => {
  const principal = {
    authBindingId: tenant.principalId,
    authContextRef: `media-repository-${tenant.tenantId}`,
    authMethod: 'session',
    principalId: tenant.principalId,
    tenantId: tenant.tenantId,
  } as const;
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? principal : { ...principal, legalEntityId },
  ).pipe(Effect.map((trusted) => ({ ...trusted, correlationId: `media-repository-${tenant.tenantId}` })));
};

/** The administrative login for fixtures, and the runtime login the repository runs through in a scoped transaction. */
const openDatabases = Effect.fn('CoreMediaRepositoryTest.openDatabases')(function* openDatabases() {
  const connections = yield* loadDatabaseConnectionPair();
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  const runtime = yield* makeTestDatabaseFromClient(
    yield* makeTestPgClient(connections.runtime.connectionString),
    coreRelations,
  );
  const inScope = <Result, Failure>(
    tenant: Tenant,
    legalEntityId: string | undefined,
    run: (repository: ReturnType<typeof makeMediaAssetRepository>) => Effect.Effect<Result, Failure>,
  ) =>
    scopeOf(tenant, legalEntityId).pipe(
      Effect.flatMap((scope) =>
        runtime.transaction((transaction) =>
          installOperationalScope(transaction, scope).pipe(Effect.map(makeMediaAssetRepository), Effect.flatMap(run)),
        ),
      ),
    );
  return { admin, inScope };
});

const reservation = (
  mediaAssetId: Schema.Schema.Type<typeof MediaAssetIdSchema>,
  overrides: Partial<ReserveMediaAssetInput> = {},
) =>
  ({
    byteSize: bytes(5),
    displayFilename: 'Brochure.pdf',
    ingestionSource: 'user',
    mediaAssetId,
    mimeType: 'application/pdf',
    storageProvider: 'test-provider',
    ...overrides,
  }) satisfies ReserveMediaAssetInput;

const newAssetId = nextUuid.pipe(Effect.flatMap(Schema.decodeUnknownEffect(MediaAssetIdSchema)));

it.layer(NodeCrypto.layer, { excludeTestServices: true })('core media repository', (suite) => {
  suite.effect('reserves two uploads with the same name and metadata as two distinct assets with distinct keys', () =>
    Effect.gen(function* distinctAssets() {
      const { admin, inScope } = yield* openDatabases();
      const tenant = yield* insertTenant(admin);
      const first = yield* newAssetId;
      const second = yield* newAssetId;
      const assets = yield* inScope(tenant, undefined, (repository) =>
        Effect.all([repository.reserve(reservation(first)), repository.reserve(reservation(second))]),
      );
      expect(assets[0].mediaAssetId).not.toBe(assets[1].mediaAssetId);
      expect(assets[0].storageKey).not.toBe(assets[1].storageKey);
      expect(assets.map(({ processingStatus }) => processingStatus)).toEqual(['uploaded', 'uploaded']);
      expect(assets[0].storageKey).toBe(deriveMediaStorageKey({ mediaAssetId: first, tenantId: tenant.tenantId }));
      expect(assets.map(({ tenantId }) => tenantId)).toEqual([tenant.tenantId, tenant.tenantId]);
    }).pipe(Effect.scoped),
  );

  suite.effect('seals ready exactly once and never regresses a ready asset', () =>
    Effect.gen(function* readyNeverRegresses() {
      const { admin, inScope } = yield* openDatabases();
      const tenant = yield* insertTenant(admin);
      const mediaAssetId = yield* newAssetId;
      yield* inScope(tenant, undefined, (repository) => repository.reserve(reservation(mediaAssetId)));
      const sealed = yield* inScope(tenant, undefined, (repository) =>
        repository.transition(mediaAssetId, {
          confirmed: { byteSize: bytes(7), contentSha256: digest, storageObjectVersionRef: 'v1' },
          to: 'ready',
        }),
      );
      expect(sealed.kind).toBe('applied');
      for (const to of ['uploaded', 'scanning', 'failed', 'ready'] as const) {
        const outcome = yield* inScope(tenant, undefined, (repository) =>
          to === 'uploaded'
            ? repository.transition(mediaAssetId, { to: 'scanning' })
            : repository.transition(
                mediaAssetId,
                to === 'ready' ? { confirmed: { byteSize: bytes(1), contentSha256: sha('d'.repeat(64)) }, to } : { to },
              ),
        );
        expect(outcome.kind).toBe('rejected');
      }
      const [row] = yield* admin.unsafe<{
        byte_size: string;
        content_sha256: string;
        processing_status: string;
        sealed_at: Date | null;
        storage_object_version_ref: string;
      }>(
        'select processing_status, content_sha256, byte_size::text, storage_object_version_ref, sealed_at from core.media_assets where media_asset_id = $1',
        [mediaAssetId],
      );
      expect(row).toMatchObject({
        byte_size: '7',
        content_sha256: digest,
        processing_status: 'ready',
        storage_object_version_ref: 'v1',
      });
      expect(row?.sealed_at).not.toBeNull();
    }).pipe(Effect.scoped),
  );

  suite.effect('moves uploaded to failed without a digest, and a failed asset never becomes ready', () =>
    Effect.gen(function* failedIsFinal() {
      const { admin, inScope } = yield* openDatabases();
      const tenant = yield* insertTenant(admin);
      const mediaAssetId = yield* newAssetId;
      yield* inScope(tenant, undefined, (repository) => repository.reserve(reservation(mediaAssetId)));
      const failed = yield* inScope(tenant, undefined, (repository) =>
        repository.transition(mediaAssetId, { to: 'failed' }),
      );
      expect(failed.kind).toBe('applied');
      const retry = yield* inScope(tenant, undefined, (repository) =>
        repository.transition(mediaAssetId, { confirmed: { byteSize: bytes(5), contentSha256: digest }, to: 'ready' }),
      );
      expect(retry.kind).toBe('rejected');
      if (retry.kind === 'rejected') {
        expect(retry.current.processingStatus).toBe('failed');
        expect(retry.current.contentSha256).toBeNull();
        expect(retry.current.sealedAt).toBeNull();
      }
    }).pipe(Effect.scoped),
  );

  suite.effect('keeps tenants apart: another tenant neither finds, renames nor transitions the asset', () =>
    Effect.gen(function* tenantIsolation() {
      const { admin, inScope } = yield* openDatabases();
      const owner = yield* insertTenant(admin);
      const other = yield* insertTenant(admin);
      const mediaAssetId = yield* newAssetId;
      yield* inScope(owner, undefined, (repository) => repository.reserve(reservation(mediaAssetId)));
      const probes = yield* inScope(other, undefined, (repository) =>
        Effect.all([
          Effect.flip(repository.find(mediaAssetId)),
          Effect.flip(repository.renameDisplayFilename(mediaAssetId, 'stolen.pdf')),
          Effect.flip(repository.transition(mediaAssetId, { to: 'failed' })),
        ]),
      );
      for (const probe of probes) {
        expect(Schema.is(MediaAssetNotFound)(probe)).toBe(true);
      }
      const untouched = yield* inScope(owner, undefined, (repository) => repository.find(mediaAssetId));
      expect(untouched.displayFilename).toBe('Brochure.pdf');
      expect(untouched.processingStatus).toBe('uploaded');
    }).pipe(Effect.scoped),
  );

  suite.effect('refuses a principal or a company of another tenant through the same-tenant composite constraints', () =>
    Effect.gen(function* compositeConstraints() {
      const { admin, inScope } = yield* openDatabases();
      const owner = yield* insertTenant(admin);
      const other = yield* insertTenant(admin);
      const principalAssetId = yield* newAssetId;
      const companyAssetId = yield* newAssetId;
      // A refused insert aborts the transaction, exactly as it fails the Action that owns it.
      const foreignPrincipal = yield* Effect.flip(
        inScope(owner, undefined, (repository) =>
          repository.reserve(reservation(principalAssetId, { ingestedByPrincipalId: other.principalId })),
        ),
      );
      expect(Schema.is(MediaUnavailable)(foreignPrincipal)).toBe(true);
      const foreignCompany = yield* Effect.flip(
        inScope(owner, other.legalEntityId, (repository) => repository.reserve(reservation(companyAssetId))),
      );
      expect(Schema.is(MediaUnavailable)(foreignCompany)).toBe(true);
      const rows = yield* admin.unsafe<{ count: string }>(
        'select count(*)::text as count from core.media_assets where tenant_id = $1',
        [owner.tenantId],
      );
      expect(rows[0]?.count).toBe('0');
    }).pipe(Effect.scoped),
  );

  suite.effect('narrows to the selected company plus company-less assets, tenant-wide when none is selected', () =>
    Effect.gen(function* companyNarrowing() {
      const { admin, inScope } = yield* openDatabases();
      const tenant = yield* insertTenant(admin);
      const otherCompany = yield* nextUuid;
      yield* admin.unsafe(
        `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, 'Other company', 'CZ', $3, 'active')`,
        [otherCompany, tenant.tenantId, otherCompany],
      );
      const companyless = yield* newAssetId;
      const owned = yield* newAssetId;
      yield* inScope(tenant, undefined, (repository) => repository.reserve(reservation(companyless)));
      yield* inScope(tenant, tenant.legalEntityId, (repository) => repository.reserve(reservation(owned)));
      const visible = (legalEntityId: string | undefined, mediaAssetId: typeof owned) =>
        inScope(tenant, legalEntityId, (repository) => Effect.exit(repository.find(mediaAssetId))).pipe(
          Effect.map(Exit.isSuccess),
        );
      expect(yield* visible(undefined, owned)).toBe(true);
      expect(yield* visible(tenant.legalEntityId, owned)).toBe(true);
      expect(yield* visible(otherCompany, owned)).toBe(false);
      expect(yield* visible(otherCompany, companyless)).toBe(true);
    }).pipe(Effect.scoped),
  );

  suite.effect('renames only the display name and finds the single owner of a storage identity', () =>
    Effect.gen(function* renameAndIdentity() {
      const { admin, inScope } = yield* openDatabases();
      const tenant = yield* insertTenant(admin);
      const mediaAssetId = yield* newAssetId;
      const reserved = yield* inScope(tenant, undefined, (repository) =>
        repository.reserve(reservation(mediaAssetId, { originalFilename: 'raw.pdf' })),
      );
      const renamed = yield* inScope(tenant, undefined, (repository) =>
        repository.renameDisplayFilename(mediaAssetId, 'Renamed.pdf'),
      );
      expect(renamed).toMatchObject({
        displayFilename: 'Renamed.pdf',
        originalFilename: 'raw.pdf',
        processingStatus: 'uploaded',
        storageKey: reserved.storageKey,
      });
      const found = yield* inScope(tenant, undefined, (repository) =>
        repository.findByStorageIdentity({
          storageKey: deriveMediaStorageKey({ mediaAssetId, tenantId: tenant.tenantId }),
          storageProvider: 'test-provider',
        }),
      );
      expect(found.pipe(Option.map(({ mediaAssetId: id }) => id))).toEqual(Option.some(mediaAssetId));
    }).pipe(Effect.scoped),
  );
});
