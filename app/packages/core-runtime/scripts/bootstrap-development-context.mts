import { and, eq, inArray } from 'drizzle-orm';
import { NodeServices } from '@effect/platform-node';
import { Config, Console, DateTime, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../src/auth/staff-authentication-namespace.ts';
import { CoreDatabase, CoreDatabaseLive } from '../src/db/client.ts';
import { DatabaseConfig, parseDatabaseConnectionPair } from '../src/db/config.ts';
import {
  tenants,
  legalEntities,
  principals,
  principalAuthBindings,
  tenantModuleStates,
  searchIndexEntries,
  searchProjectionGenerations,
  searchProjectionRebuilds,
} from '../src/db/schema.ts';
import { bootstrapRelationshipRequest } from '../src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../src/permissions/spicedb-grpc-rpc.ts';

import {
  CoreSearchProjectionDocumentSchema,
  coreSearchReplacementFingerprint,
  decodeCoreSearchProjectionReplacement,
} from '../src/search/projection.ts';

import type { CoreTransaction } from '../src/db/types.ts';
import type { CoreSearchProjectionDocument } from '../src/search/projection.ts';

const partyModuleId = 'party.registry';
const partyResourceType = 'party.registry.party';
const counterpartyResourceType = 'party.registry.counterparty';
const searchResourceTypes = [partyResourceType, counterpartyResourceType];
const Uuid = Schema.String.check(Schema.isUUID());
const Text = Schema.Trim.check(Schema.isNonEmpty());
const PrincipalIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoPrincipalId')));
const AuthBindingIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoAuthBindingId')));
const AuthUserIdSchema = Schema.toEncoded(Text.pipe(Schema.brand('DemoAuthUserId')));
const LegalEntityIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoLegalEntityId')));
const ModuleIdSchema = Schema.toEncoded(Text.pipe(Schema.brand('DemoModuleId')));
const StateIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoStateId')));
const ResourceIdSchema = Schema.toEncoded(Text.pipe(Schema.brand('DemoResourceId')));
const SubjectIdSchema = Schema.toEncoded(Text.pipe(Schema.brand('DemoSubjectId')));
const TenantIdSchema = Schema.toEncoded(Uuid.pipe(Schema.brand('DemoTenantId')));
const FixtureSchema = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      authBindingId: AuthBindingIdSchema,
      authUserId: AuthUserIdSchema,
      displayName: Text,
      principalId: PrincipalIdSchema,
    }),
  ),
  legalEntity: Schema.Struct({
    legalEntityId: LegalEntityIdSchema,
    legalName: Text,
    registrationCountry: Text,
    registrationNumber: Text,
  }),
  modules: Schema.Array(Schema.Struct({ moduleId: ModuleIdSchema, stateId: StateIdSchema })),
  relationships: Schema.Array(
    Schema.Struct({
      relation: Text,
      resourceId: ResourceIdSchema,
      resourceType: Text,
      subjectId: SubjectIdSchema,
      subjectType: Text,
    }),
  ),
  searchDocuments: Schema.optionalKey(Schema.Array(CoreSearchProjectionDocumentSchema)),
  tenant: Schema.Struct({ defaultLocale: Text, displayName: Text, slug: Text, tenantId: TenantIdSchema }),
});
class DevelopmentBootstrapError extends Schema.TaggedError<DevelopmentBootstrapError>()('DevelopmentBootstrapError', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
}) {}

const loadInput = (fixturePath: string) =>
  Effect.gen(function* bootstrapDevelopmentContext() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const fs = yield* FileSystem.FileSystem;
    const input = yield* fs
      .readFileString(fixturePath)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))));
    if (input.searchDocuments !== undefined) {
      const docs = input.searchDocuments;
      const demoTenant = '70000000-0000-4000-8000-000000000020';
      const demoLegal = '71000000-0000-4000-8000-000000000020';
      const partyDocs = docs.filter((row) => row.ref.resourceType === partyResourceType);
      const counterpartyDocs = docs.filter((row) => row.ref.resourceType === counterpartyResourceType);
      if (
        input.tenant.tenantId !== demoTenant ||
        input.legalEntity.legalEntityId !== demoLegal ||
        partyDocs.length !== 6 ||
        counterpartyDocs.length !== 5 ||
        docs.length !== 11 ||
        new Set(docs.map((row) => row.ref.resourceId)).size !== 11 ||
        docs.some(
          (row) =>
            row.ref.tenantId !== demoTenant ||
            row.ref.moduleId !== partyModuleId ||
            row.archived ||
            (row.aliases?.length ?? 0) > 0 ||
            row.matchedRef !== undefined ||
            row.matchedSubjectRef !== undefined ||
            row.facets.length !== 0 ||
            row.metadata.length !== 0 ||
            (row.temporalSearchableText?.length ?? 0) > 0,
        ) ||
        partyDocs.some((row) => row.selectedLegalEntityId !== undefined || row.subjectRef !== undefined) ||
        counterpartyDocs.some(
          (row) =>
            row.selectedLegalEntityId !== demoLegal ||
            row.subjectRef?.tenantId !== demoTenant ||
            row.subjectRef.moduleId !== partyModuleId ||
            row.subjectRef.resourceType !== partyResourceType ||
            !partyDocs.some((party) => party.ref.resourceId === row.subjectRef?.resourceId),
        )
      ) {
        return yield* new DevelopmentBootstrapError({
          reason:
            'Search fixtures must contain exactly six Siampark Parties and five Counterparties in the fixed tenant and legal entity',
        });
      }
      for (const resourceType of searchResourceTypes) {
        yield* Effect.try({
          catch: (cause) => new DevelopmentBootstrapError({ cause, reason: 'Search fixture projection is invalid' }),
          try: () =>
            decodeCoreSearchProjectionReplacement({
              documents: docs.filter((row) => row.ref.resourceType === resourceType),
              moduleId: partyModuleId,
              rebuildVersion: '1',
              resourceType,
              tenantId: demoTenant,
            }),
        });
      }
    }
    return input;
  });
type SeedSearchDocumentPayload = {
  -readonly [
    Key in keyof Pick<
      CoreSearchProjectionDocument,
      'archived' | 'facets' | 'metadata' | 'subjectRef' | 'temporalFacets'
    >
  ]: CoreSearchProjectionDocument[Key];
} & { readonly schemaVersion: '1' };
const bootstrapSearchDocuments = Effect.fn('DevelopmentBootstrap.searchDocuments')(function* installSearchDocuments(
  transaction: CoreTransaction,
  documents: readonly CoreSearchProjectionDocument[],
  tenantId: string,
) {
  const moduleId = partyModuleId;
  const generationScope = and(
    eq(searchProjectionGenerations.tenantId, tenantId),
    eq(searchProjectionGenerations.sourceModuleKey, moduleId),
  );
  yield* transaction
    .insert(searchProjectionGenerations)
    .values({ generation: 1n, sourceModuleKey: moduleId, tenantId })
    .onConflictDoNothing();
  const [current] = yield* transaction
    .select({ generation: searchProjectionGenerations.generation })
    .from(searchProjectionGenerations)
    .where(generationScope)
    .for('update');
  if (current === undefined) {
    return yield* new DevelopmentBootstrapError({ reason: 'Search generation unavailable' });
  }
  const version = current.generation + 1n;
  const now = yield* DateTime.nowAsDate;
  yield* transaction
    .update(searchProjectionGenerations)
    .set({ generation: version, updatedAt: now })
    .where(generationScope);
  yield* transaction
    .delete(searchIndexEntries)
    .where(
      and(
        eq(searchIndexEntries.tenantId, tenantId),
        eq(searchIndexEntries.sourceModuleKey, moduleId),
        inArray(searchIndexEntries.sourceResourceType, searchResourceTypes),
      ),
    );
  for (const document of documents) {
    const facetsJson: SeedSearchDocumentPayload = {
      archived: document.archived,
      facets: document.facets,
      metadata: document.metadata,
      schemaVersion: '1',
    };
    if (document.subjectRef !== undefined) {
      facetsJson.subjectRef = document.subjectRef;
    }
    if (document.temporalFacets !== undefined) {
      facetsJson.temporalFacets = document.temporalFacets;
    }
    const values = {
      bodyText: [document.title, ...document.searchableText]
        .map((value) => value.normalize('NFKC').toLocaleLowerCase('und'))
        .join('\n'),
      deleted: false,
      facetsJson,
      legalEntityId: document.selectedLegalEntityId ?? null,
      projectionVersion: version,
      sourceModuleKey: document.ref.moduleId,
      sourceResourceId: document.ref.resourceId,
      sourceResourceType: document.ref.resourceType,
      tenantId: document.ref.tenantId,
      title: document.title,
      updatedAt: now,
    };
    yield* transaction.insert(searchIndexEntries).values(values);
  }
  for (const resourceType of searchResourceTypes) {
    const replacement = yield* Effect.try({
      catch: (cause) => new DevelopmentBootstrapError({ cause, reason: 'Search projection generation is invalid' }),
      try: () =>
        decodeCoreSearchProjectionReplacement({
          documents: documents
            .filter((row) => row.ref.resourceType === resourceType)
            .map((row) => ({ ...row, projectionVersion: String(version) })),
          moduleId,
          rebuildVersion: String(version),
          resourceType,
          tenantId,
        }),
    });
    const fingerprint = coreSearchReplacementFingerprint(replacement);
    yield* transaction
      .insert(searchProjectionRebuilds)
      .values({
        fingerprint,
        rebuildVersion: version,
        sourceModuleKey: moduleId,
        sourceResourceType: resourceType,
        tenantId,
      })
      .onConflictDoUpdate({
        set: { fingerprint, rebuildVersion: version, updatedAt: now },
        target: [
          searchProjectionRebuilds.tenantId,
          searchProjectionRebuilds.sourceModuleKey,
          searchProjectionRebuilds.sourceResourceType,
        ],
      });
  }

  return yield* Effect.void;
});
const main = (input: typeof FixtureSchema.Type) =>
  Effect.gen(function* bootstrapDevelopmentContext() {
    const { executor } = yield* CoreDatabase;
    yield* executor.transaction((transaction) =>
      Effect.gen(function* bootstrapContextRows() {
        yield* transaction
          .insert(tenants)
          .values({ ...input.tenant, name: input.tenant.displayName, status: 'active' })
          .onConflictDoNothing();
        yield* transaction
          .insert(legalEntities)
          .values({ ...input.legalEntity, status: 'active', tenantId: input.tenant.tenantId })
          .onConflictDoNothing();
        for (const account of input.accounts) {
          yield* transaction
            .insert(principals)
            .values({
              displayName: account.displayName,
              kind: 'human',
              principalId: account.principalId,
              status: 'active',
              tenantId: input.tenant.tenantId,
            })
            .onConflictDoNothing();
          yield* transaction
            .insert(principalAuthBindings)
            .values({
              authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
              principalAuthBindingId: account.authBindingId,
              principalId: account.principalId,
              provider: 'better_auth',
              providerSubjectId: account.authUserId,
              status: 'active',
              subjectType: 'user',
              tenantId: input.tenant.tenantId,
            })
            .onConflictDoNothing();
        }
        for (const module of input.modules) {
          yield* transaction
            .insert(tenantModuleStates)
            .values({
              moduleKey: module.moduleId,
              state: 'active',
              tenantId: input.tenant.tenantId,
              tenantModuleStateId: module.stateId,
            })
            .onConflictDoNothing();
        }
        if (input.searchDocuments !== undefined) {
          yield* bootstrapSearchDocuments(transaction, input.searchDocuments, input.tenant.tenantId);
        }
      }),
    );
    const configuration = yield* loadSpiceDbConfig();
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)) {
      return yield* new DevelopmentBootstrapError({ reason: 'Development bootstrap requires local SpiceDB' });
    }
    const client = yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) => new DevelopmentBootstrapError({ cause, reason: 'Authorization client unavailable' }),
        try: () => openSpiceDbGrpcRpc(configuration, 5000),
      }),
      (value) => Effect.sync(() => value.close()),
    );
    for (let index = 0; index < input.relationships.length; index += 50) {
      yield* client
        .writeRelationships(bootstrapRelationshipRequest(input.relationships.slice(index, index + 50)))
        .pipe(
          Effect.mapError(
            (cause) => new DevelopmentBootstrapError({ cause, reason: 'Development authorization bootstrap failed' }),
          ),
        );
    }
    return yield* Console.log('Development identity and authorization context initialized');
  });
const AdminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Effect.gen(function* adminDatabaseConfiguration() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const pair = yield* Config.all({
      DATABASE_ADMIN_URL: Config.Redacted('DATABASE_ADMIN_URL'),
      DATABASE_URL: Config.Redacted('DATABASE_URL'),
    }).pipe(
      Effect.flatMap((urls) =>
        parseDatabaseConnectionPair({
          DATABASE_ADMIN_URL: Redacted.value(urls.DATABASE_ADMIN_URL),
          DATABASE_URL: Redacted.value(urls.DATABASE_URL),
        }),
      ),
    );
    if (
      ![pair.admin.host, pair.runtime.host].every(
        (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]',
      )
    ) {
      return yield* new DevelopmentBootstrapError({ reason: 'Development bootstrap requires local PostgreSQL' });
    }
    return pair.admin;
  }),
);
const command = Command.make(
  'demo-fixture',
  { fixture: Flag.String('fixture'), validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)) },
  ({ fixture, validateOnly }) =>
    loadInput(fixture).pipe(
      Effect.flatMap((input) =>
        validateOnly
          ? Console.log('Development fixture and search scope validated; no data changed')
          : Layer.build(
              Layer.effectDiscard(main(input)).pipe(
                Layer.provide(CoreDatabaseLive.pipe(Layer.provide(AdminDatabaseConfigLive))),
              ),
            ).pipe(Effect.scoped, Effect.asVoid),
      ),
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DevelopmentBootstrapError)(failure)
            ? `Fixture port failed: ${failure._tag}: ${failure.reason}`
            : `Fixture port failed: ${failure._tag}`,
        ),
      ),
    ),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(NodeServices.layer),
);
await Effect.runPromise(Effect.scoped(Layer.build(runtimeLive)));
