import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runScaffold } from '../../../../scripts/scaffolding/cli.mts';
import {
  MODULE_MANIFEST_RESOURCE_SLOT_END,
  MODULE_MANIFEST_RESOURCE_SLOT_START,
} from '../../../../scripts/scaffolding/shared.mts';

export const GENERATED_OWNER = {
  actionKey: 'isolation.owner.create-record',
  appId: 'isolation-owner',
  moduleId: 'isolation.owner',
  resourceType: 'isolation.owner.record',
  slug: 'isolation-owner',
} as const;

const json = <Value>(value: Value): string => `${JSON.stringify(value, null, 2)}\n`;
const appRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');

const writeFixtureFile = async (
  root: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
};

const replaceRequired = (source: string, current: string, replacement: string): string => {
  if (!source.includes(current)) {
    throw new Error(`Generated isolation fixture no longer contains ${JSON.stringify(current)}`);
  }
  return source.replace(current, replacement);
};

const createWorkspace = async (root: string): Promise<void> => {
  await writeFixtureFile(
    root,
    'package.json',
    json({ name: 'generated-owner-fixture', private: true }),
  );
  await writeFixtureFile(
    root,
    `verticals/${GENERATED_OWNER.slug}/module-federation.config.ts`,
    'export default { exposes: {} };\n',
  );
  await writeFixtureFile(
    root,
    `verticals/${GENERATED_OWNER.slug}/tsconfig.json`,
    json({ compilerOptions: { composite: true }, include: ['api', 'shared', 'src'] }),
  );
  await writeFixtureFile(
    root,
    `verticals/${GENERATED_OWNER.slug}/package.json`,
    json({
      dependencies: {},
      modernjs: {
        apiRuntime: 'effect',
        appId: GENERATED_OWNER.appId,
        preset: 'presetUltramodern',
        role: 'module-federation-remote',
        topology: '../../topology/reference-topology.json',
      },
      name: '@app/isolation-owner',
      private: true,
      scripts: {
        build: 'modern build && MODERNJS_DEPLOY=node modern deploy --skip-build',
        'cloudflare:build':
          'MODERNJS_DEPLOY=cloudflare modern build && MODERNJS_DEPLOY=cloudflare modern deploy --skip-build',
      },
      type: 'module',
      version: '0.0.0',
    }),
  );
  await writeFixtureFile(
    root,
    `verticals/${GENERATED_OWNER.slug}/src/routes/ultramodern-route-head.tsx`,
    'export const UltramodernRouteHead = () => null;\n',
  );
  await writeFixtureFile(
    root,
    'topology/reference-topology.json',
    json({
      schemaVersion: 1,
      verticals: [
        {
          domain: 'isolation',
          id: GENERATED_OWNER.appId,
          kind: 'vertical',
          moduleFederation: { name: 'verticalIsolationOwner', role: 'remote' },
          package: '@app/isolation-owner',
          path: `verticals/${GENERATED_OWNER.slug}`,
        },
      ],
    }),
  );
};

const linkRuntimeDependencies = async (root: string): Promise<void> => {
  await mkdir(path.join(root, 'node_modules', '@app'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', '@modern-js'), { recursive: true });
  await Promise.all([
    symlink(
      path.join(appRoot, 'packages/core-runtime'),
      path.join(root, 'node_modules/@app/core-runtime'),
      'dir',
    ),
    symlink(
      path.join(appRoot, 'packages/shared-contracts'),
      path.join(root, 'node_modules/@app/shared-contracts'),
      'dir',
    ),
    symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/@modern-js/plugin-bff'),
      path.join(root, 'node_modules/@modern-js/plugin-bff'),
      'dir',
    ),
    symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/drizzle-orm'),
      path.join(root, 'node_modules/drizzle-orm'),
      'dir',
    ),
    symlink(
      path.join(appRoot, 'node_modules/effect'),
      path.join(root, 'node_modules/effect'),
      'dir',
    ),
    symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/jose'),
      path.join(root, 'node_modules/jose'),
      'dir',
    ),
  ]);
};

const addResourceType = async (root: string): Promise<void> => {
  const manifestPath = path.join(root, `verticals/${GENERATED_OWNER.slug}/vertical.manifest.ts`);
  const manifest = await readFile(manifestPath, 'utf-8');
  const withResourceType = replaceRequired(
    manifest,
    `      ${MODULE_MANIFEST_RESOURCE_SLOT_START}
      ${MODULE_MANIFEST_RESOURCE_SLOT_END}`,
    `      ${MODULE_MANIFEST_RESOURCE_SLOT_START}
      {
        capabilities: {
          graphVisible: false,
          linkable: true,
          mediaAttachable: false,
          searchable: true,
          timelineVisible: true,
        },
        description: 'Disposable isolation record.',
        key: '${GENERATED_OWNER.resourceType}',
        label: 'Isolation record',
        owningModuleId: '${GENERATED_OWNER.moduleId}',
      },
      ${MODULE_MANIFEST_RESOURCE_SLOT_END}`,
  );
  const withResourceDetail = replaceRequired(
    withResourceType,
    '      resourceDetails: [],',
    `      resourceDetails: [
        {
          apiKey: '${GENERATED_OWNER.moduleId}.resource-detail',
          contributionKey: '${GENERATED_OWNER.moduleId}.detail.record',
          entrypoint: {
            access: 'read',
            authorization: { kind: 'context_permission', permission: 'module.access' },
            entrypointKey: '${GENERATED_OWNER.moduleId}.api.resource-detail',
            moduleKey: '${GENERATED_OWNER.moduleId}',
            role: 'api',
            scope: 'tenant',
          },
          resourceType: '${GENERATED_OWNER.resourceType}',
        },
      ],`,
  );
  await writeFile(
    manifestPath,
    replaceRequired(
      withResourceDetail,
      '      timelines: [],',
      `      timelines: [
        {
          apiKey: '${GENERATED_OWNER.moduleId}.resource-list',
          contributionKey: '${GENERATED_OWNER.moduleId}.timeline.record',
          entrypoint: {
            access: 'read',
            authorization: { kind: 'context_permission', permission: 'module.access' },
            entrypointKey: '${GENERATED_OWNER.moduleId}.api.resource-list',
            moduleKey: '${GENERATED_OWNER.moduleId}',
            role: 'api',
            scope: 'tenant',
          },
          resourceType: '${GENERATED_OWNER.resourceType}',
        },
      ],`,
    ),
    'utf-8',
  );
};

const adaptContract = async (
  root: string,
  name: 'resource-detail' | 'resource-list',
  request: string,
  response: string,
): Promise<void> => {
  const contractPath = path.join(root, `verticals/${GENERATED_OWNER.slug}/shared/apis/${name}.ts`);
  let contract = await readFile(contractPath, 'utf-8');
  const type = name === 'resource-detail' ? 'ResourceDetail' : 'ResourceList';
  contract = replaceRequired(
    contract,
    `export const ${type}RequestSchema = Schema.Struct({});`,
    `export const ${type}RequestSchema = ${request};`,
  );
  contract = replaceRequired(
    contract,
    `export const ${type}ResponseSchema = Schema.Struct({ ok: Schema.Literal(true) });`,
    `export const ${type}ResponseSchema = ${response};`,
  );
  await writeFile(contractPath, contract, 'utf-8');
};

const ownerRepositorySource = (schemaName: string): string => `
// Test-owned adaptation of Codesmith-generated disposable owner artifacts.
import { eq } from 'drizzle-orm';
import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

const ownerSchema = pgSchema('${schemaName}');
const tenantRecords = ownerSchema.table('tenant_records', {
  resourceId: uuid('resource_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
});
const entityRecords = ownerSchema.table('entity_records', {
  legalEntityId: uuid('legal_entity_id').notNull(),
  resourceId: uuid('resource_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
});

type OwnerExecutor = Pick<NodePgDatabase, 'insert' | 'select'>;

export const makeOwnerRepository = (transaction: OwnerExecutor) => ({
  // Deliberately buggy: these reads omit tenant and legal-entity predicates.
  detail: (resourceId: string) =>
    transaction.select().from(entityRecords).where(eq(entityRecords.resourceId, resourceId)),
  listTenant: () => transaction.select().from(tenantRecords),
  search: () => transaction.select().from(entityRecords),
  // Deliberately trusts payload ownership. Forced RLS must reject a foreign scope.
  insertEntity: (value: {
    readonly legalEntityId: string;
    readonly resourceId: string;
    readonly tenantId: string;
    readonly title: string;
  }) => transaction.insert(entityRecords).values(value),
});
`;

const instrumentationSource = `
export const generatedOwnerHandlerCounts = {
  action: 0,
  detail: 0,
  list: 0,
  search: 0,
};
`;

const detailReadSource = `
// @generated by OntOS Codesmith module-api v1
import {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  defineRead,
  defineTenantModuleEntrypoint,
} from '@app/core-runtime';
import { Effect } from 'effect';
import { ResourceDetailRequestSchema, ResourceDetailResponseSchema } from '../../shared/apis/resource-detail.ts';
import { generatedOwnerHandlerCounts } from '../isolation/instrumentation.ts';
import { makeOwnerRepository } from '../isolation/owner-repository.ts';

export const resourceDetailEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: '${GENERATED_OWNER.moduleId}.api.resource-detail',
  moduleKey: '${GENERATED_OWNER.moduleId}',
  role: 'api',
});

export const resourceDetailRead = defineRead(
  {
    accessKind: 'detail',
    entrypoint: resourceDetailEntrypoint,
    evidencePolicy: { captureMode: 'metadata_only', policyKey: '${GENERATED_OWNER.moduleId}.api.resource-detail.evidence.v1' },
    inputSchema: ResourceDetailRequestSchema,
    legalEntityScope: 'required',
    owningModuleKey: '${GENERATED_OWNER.moduleId}',
    permissionTarget: 'resource',
    policies: [],
    readKey: '${GENERATED_OWNER.moduleId}.api.resource-detail',
    resultSchema: ResourceDetailResponseSchema,
    schemaVersion: '1',
  },
  ({ resourceId }, context) =>
    Effect.gen(function* generatedDetail() {
      generatedOwnerHandlerCounts.detail += 1;
      const rows = yield* Effect.tryPromise({
        catch: () => new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner detail is unavailable' }),
        try: () => context.services.detail(resourceId),
      });
      const row = rows[0];
      if (row === undefined) {
        return yield* new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'Owner record was not found' });
      }
      return {
        evidence: { resultCount: 1 },
        result: { fields: [{ label: 'scope', value: row.title }], title: row.title },
      };
    }),
  (transaction) => Effect.succeed(makeOwnerRepository(transaction)),
  ({ resourceId }) => ({
    kind: 'resource',
    resource: { moduleId: '${GENERATED_OWNER.moduleId}', resourceId, resourceType: '${GENERATED_OWNER.resourceType}' },
  }),
);
`;

const listReadSource = `
// @generated by OntOS Codesmith module-api v1
import { ReadHandlerUnavailable, defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { Effect } from 'effect';
import { ResourceListRequestSchema, ResourceListResponseSchema } from '../../shared/apis/resource-list.ts';
import { generatedOwnerHandlerCounts } from '../isolation/instrumentation.ts';
import { makeOwnerRepository } from '../isolation/owner-repository.ts';

export const resourceListEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: '${GENERATED_OWNER.moduleId}.api.resource-list',
  moduleKey: '${GENERATED_OWNER.moduleId}',
  role: 'api',
});

export const resourceListRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: resourceListEntrypoint,
    evidencePolicy: { captureMode: 'metadata_only', policyKey: '${GENERATED_OWNER.moduleId}.api.resource-list.evidence.v1' },
    inputSchema: ResourceListRequestSchema,
    legalEntityScope: 'required',
    owningModuleKey: '${GENERATED_OWNER.moduleId}',
    permissionTarget: 'resource',
    policies: [],
    readKey: '${GENERATED_OWNER.moduleId}.api.resource-list',
    resultSchema: ResourceListResponseSchema,
    schemaVersion: '1',
  },
  ({ resourceId }, context) =>
    Effect.gen(function* generatedList() {
      generatedOwnerHandlerCounts.list += 1;
      const rows = yield* Effect.tryPromise({
        catch: () => new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner list is unavailable' }),
        try: () => context.services.listTenant(),
      });
      return {
        evidence: { resultCount: rows.length },
        result: {
          entries: rows.map((row: { readonly title: string }, index: number) => ({
            occurredAt: '2026-08-09T00:00:00.000Z',
            summary: row.title,
            timelineEntryId: \`\${resourceId}-\${index}\`,
          })),
          projectionLagging: false,
        },
      };
    }),
  (transaction) => Effect.succeed(makeOwnerRepository(transaction)),
  ({ resourceId }) => ({
    kind: 'resource',
    resource: { moduleId: '${GENERATED_OWNER.moduleId}', resourceId, resourceType: '${GENERATED_OWNER.resourceType}' },
  }),
);
`;

const searchReadSource = `
// @generated by OntOS Codesmith Governed Contribution v1
// @ontos-contribution-kind search-provider
import { ReadHandlerUnavailable, defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { Effect } from 'effect';
import { RecordsProviderRequestSchema, RecordsProviderResponseSchema } from '../../shared/apis/records-search.ts';
import { generatedOwnerHandlerCounts } from '../isolation/instrumentation.ts';
import { makeOwnerRepository } from '../isolation/owner-repository.ts';

export const recordsEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: '${GENERATED_OWNER.moduleId}.search.records',
  moduleKey: '${GENERATED_OWNER.moduleId}',
  role: 'search',
});

export const recordsRead = defineRead(
  {
    accessKind: 'search',
    entrypoint: recordsEntrypoint,
    evidencePolicy: { captureMode: 'metadata_only', policyKey: '${GENERATED_OWNER.moduleId}.search.records.evidence.v1' },
    inputSchema: RecordsProviderRequestSchema,
    legalEntityScope: 'required',
    owningModuleKey: '${GENERATED_OWNER.moduleId}',
    permissionTarget: 'module',
    policies: [],
    readKey: '${GENERATED_OWNER.moduleId}.search.records',
    resultSchema: RecordsProviderResponseSchema,
    schemaVersion: '1',
  },
  ({ query }, context) =>
    Effect.gen(function* generatedSearch() {
      generatedOwnerHandlerCounts.search += 1;
      const rows = yield* Effect.tryPromise({
        catch: () => new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner search is unavailable' }),
        try: () => context.services.search(),
      });
      const normalized = query.toLocaleLowerCase('en');
      const result = rows
        .filter((row: { readonly title: string }) => row.title.toLocaleLowerCase('en').includes(normalized))
        .map((row: { readonly resourceId: string; readonly title: string }) => ({
          ref: { moduleId: '${GENERATED_OWNER.moduleId}', resourceId: row.resourceId, resourceType: '${GENERATED_OWNER.resourceType}' },
          title: row.title,
        }));
      return { evidence: { resultCount: result.length }, result };
    }),
  (transaction) => Effect.succeed(makeOwnerRepository(transaction)),
  () => ({ kind: 'module', moduleId: '${GENERATED_OWNER.moduleId}' }),
  (result) => result.map(({ ref }) => ref),
);
`;

const actionSource = `
// @generated by OntOS Codesmith Action v1
// @ontos-action-owner ${GENERATED_OWNER.moduleId}
// @ontos-action-slug create-record
import { Effect, Schema } from 'effect';
import { defineAction, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { generatedOwnerHandlerCounts } from '../isolation/instrumentation.ts';
import { makeOwnerRepository } from '../isolation/owner-repository.ts';

export const CreateRecordPayload = Schema.Struct({
  legalEntityId: Schema.String.check(Schema.isUUID()),
  resourceId: Schema.String.check(Schema.isUUID()),
  tenantId: Schema.String.check(Schema.isUUID()),
  title: Schema.String,
});
export const CreateRecordResult = Schema.Struct({ created: Schema.Literal(true) });
export class CreateRecordRejected extends Schema.TaggedError<CreateRecordRejected>()(
  'CreateRecordRejected',
  { code: Schema.Literal('owner_write_rejected'), reason: Schema.String },
) {}

export const createRecordAction = defineAction(
  {
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: '${GENERATED_OWNER.actionKey}.access.v1' },
    actionKey: '${GENERATED_OWNER.actionKey}',
    auditProfile: 'standard',
    domainErrorSchema: CreateRecordRejected,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: '${GENERATED_OWNER.actionKey}',
      moduleKey: '${GENERATED_OWNER.moduleId}',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleKey: '${GENERATED_OWNER.moduleId}',
    payloadSchema: CreateRecordPayload,
    policies: [],
    resultSchema: CreateRecordResult,
    schemaVersion: '1',
  },
  (payload, context) =>
    Effect.gen(function* generatedAction() {
      generatedOwnerHandlerCounts.action += 1;
      if (payload.title === 'trigger safe logging defect') {
        return yield* Effect.die(new Error('Generated owner safe defect'));
      }
      yield* Effect.tryPromise({
        catch: () => new CreateRecordRejected({ code: 'owner_write_rejected', reason: 'The owner write was rejected' }),
        try: () => context.services.insertEntity(payload),
      });
      return { created: true as const };
    }),
  (transaction) => Effect.succeed(makeOwnerRepository(transaction)),
);
`;

const adaptGeneratedOwner = async (root: string, schemaName: string): Promise<void> => {
  const verticalRoot = `verticals/${GENERATED_OWNER.slug}`;
  await adaptContract(
    root,
    'resource-detail',
    'Schema.Struct({ resourceId: Schema.String.check(Schema.isUUID()) })',
    `Schema.Struct({
  fields: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
  title: Schema.String,
})`,
  );
  await adaptContract(
    root,
    'resource-list',
    'Schema.Struct({ resourceId: Schema.String.check(Schema.isUUID()) })',
    `Schema.Struct({
  entries: Schema.Array(Schema.Struct({
    occurredAt: Schema.String,
    summary: Schema.String,
    timelineEntryId: Schema.String,
  })),
  projectionLagging: Schema.Boolean,
})`,
  );
  await Promise.all([
    writeFixtureFile(
      root,
      `${verticalRoot}/src/isolation/instrumentation.ts`,
      instrumentationSource,
    ),
    writeFixtureFile(
      root,
      `${verticalRoot}/src/isolation/owner-repository.ts`,
      ownerRepositorySource(schemaName),
    ),
    writeFixtureFile(root, `${verticalRoot}/src/api/resource-detail.read.ts`, detailReadSource),
    writeFixtureFile(root, `${verticalRoot}/src/api/resource-list.read.ts`, listReadSource),
    writeFixtureFile(root, `${verticalRoot}/src/search/records.provider.ts`, searchReadSource),
    writeFixtureFile(root, `${verticalRoot}/src/actions/create-record.action.ts`, actionSource),
  ]);
};

export interface GeneratedOwnerFixture {
  readonly dispose: () => Promise<void>;
  readonly root: string;
  readonly verticalRoot: string;
}

export const createGeneratedOwnerFixture = async (
  schemaName: string,
): Promise<GeneratedOwnerFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ontos-generated-owner-'));
  try {
    await createWorkspace(root);
    await runScaffold(
      'module-contract',
      ['--vertical', GENERATED_OWNER.slug, '--module', GENERATED_OWNER.moduleId],
      { workspaceRoot: root },
    );
    await addResourceType(root);
    await runScaffold(
      'action',
      [
        '--vertical',
        GENERATED_OWNER.slug,
        '--action',
        'create-record',
        '--authorization',
        'action_execution',
        '--legal-entity-scope',
        'required',
        '--provisioning',
        'tenant_membership_default',
      ],
      { workspaceRoot: root },
    );
    await runScaffold(
      'module-api',
      [
        '--vertical',
        GENERATED_OWNER.slug,
        '--name',
        'resource-detail',
        '--authorization',
        'context_permission',
        '--permission',
        'module.access',
      ],
      { workspaceRoot: root },
    );
    await runScaffold(
      'module-api',
      [
        '--vertical',
        GENERATED_OWNER.slug,
        '--name',
        'resource-list',
        '--authorization',
        'context_permission',
        '--permission',
        'module.access',
      ],
      { workspaceRoot: root },
    );
    await runScaffold(
      'search-provider',
      [
        '--vertical',
        GENERATED_OWNER.slug,
        '--name',
        'records',
        '--resource',
        'record',
        '--authorization',
        'context_permission',
        '--permission',
        'module.access',
      ],
      { workspaceRoot: root },
    );
    await adaptGeneratedOwner(root, schemaName);
    await linkRuntimeDependencies(root);
    return {
      dispose: async () => await rm(root, { force: true, recursive: true }),
      root,
      verticalRoot: path.join(root, 'verticals', GENERATED_OWNER.slug),
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
};
