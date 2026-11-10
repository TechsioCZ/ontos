import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  commandActionSlugOf,
  isProposableModuleCommand,
  OntosMcpToolCatalogJsonSchema,
  ONTOS_MODULE_MCP_TOOL_CATALOG_PATH,
} from '../../packages/core-runtime/src/modules/mcp-contribution.ts';
import { deriveOntosMcpContribution } from '../ontos-mcp-contribution.mts';
import { taggingManifest } from '../../verticals/tagging/vertical.manifest.ts';
import {
  cases as taggingCases,
  makeFixture as taggingFixture,
  registrations as taggingRegistrations,
} from '../../verticals/tagging/tests/unit/registered-action-http-fixture.ts';
import { workforceManifest } from '../../verticals/workforce/vertical.manifest.ts';
import {
  cases as workforceCases,
  makeFixture as workforceFixture,
  registrations as workforceRegistrations,
} from '../../verticals/workforce/tests/unit/registered-action-http-fixture.ts';
import { salesInsightsManifest } from '../../verticals/sales-insights/vertical.manifest.ts';
import {
  cases as salesInsightsCases,
  makeFixture as salesInsightsFixture,
  registrations as salesInsightsRegistrations,
} from '../../verticals/sales-insights/tests/unit/registered-action-http-fixture.ts';
import { merchandiseManifest } from '../../verticals/merchandise/vertical.manifest.ts';
import { workTasksManifest } from '../../verticals/work-tasks/vertical.manifest.ts';
import {
  cases as merchandiseCases,
  makeFixture as merchandiseFixture,
  registrations as merchandiseRegistrations,
} from '../../verticals/merchandise/tests/unit/registered-action-http-fixture.ts';

const expectedContribution = 'Expected the real owner MCP contribution';
const catalogPath = '/.well-known/ontos-module-mcp-tools.json';
const expectedRegistration = 'MCP route must have the actual owner registration';
const createSlug = 'apply-command';
const salesInsightsAppId = 'sales-insights';

it.effect(
  'tagging derives MCP commands from real closed registrations and executes their published HTTP audit identities',
  () =>
    Effect.scoped(
      Effect.gen(function* transportIdentity() {
        const manifest = taggingManifest;
        const derived = deriveOntosMcpContribution({
          actions: manifest.publicSurface.actions,
          api: manifest.publicSurface.api,
          appId: 'tagging',
          authored: manifest.publicSurface.mcp,
          moduleId: manifest.module.id,
        });
        if (derived === undefined) {
          expect.unreachable(expectedContribution);
        }
        expect(derived.contribution.toolCatalog.path).toBe(ONTOS_MODULE_MCP_TOOL_CATALOG_PATH);
        expect(derived.contribution.toolCatalog.path).toBe(catalogPath);
        expect(derived.contribution.toolCatalog.sha256).toBe(
          createHash('sha256').update(derived.toolCatalog).digest('hex'),
        );
        const catalog = yield* Schema.decodeEffect(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
        let exercised = 0;
        for (const { command, slug } of taggingCases) {
          const tool = catalog.tools.find((entry) => entry.invoke.commandTag === command._tag);
          // Authored hidden tools stay hidden. The HTTP-only cleanup/image/review tests remain separate.
          if (tool === undefined) {
            expect(manifest.publicSurface.mcp?.commands?.[command._tag]).toBe('hidden');
            continue;
          }
          expect(tool.invoke.path).toBe(`/tagging/actions/${slug}`);
          expect(tool.access).toBe('write');
          const registration = taggingRegistrations.find(
            (action) => action.descriptor.actionKey === `demo.tagging.${slug}`,
          );
          if (registration === undefined) {
            expect.unreachable(expectedRegistration);
          }
          expect(manifest.publicSurface.actions).toContain(registration);
          yield* Schema.decodeUnknownEffect(registration.descriptor.payloadSchema)({ command, expectedRevision: 1 });
          const { harness, request, writes } = yield* taggingFixture();
          const response = yield* request(tool.invoke.path, command, `mcp-${slug}`);
          expect(response.status).toBe(200);
          expect(harness.snapshot().invocations[0]?.actionKey).toBe(registration.descriptor.actionKey);
          expect(harness.snapshot().committed[0]?.actionKey).toBe(registration.descriptor.actionKey);
          expect(writes).toEqual([command]);
          if (slug !== createSlug) {
            const retired = yield* request('/tagging/actions/apply-command', command, `old-mcp-${slug}`);
            expect(retired.status).toBe(400);
            expect(harness.snapshot().committed).toHaveLength(1);
          }
          exercised += 1;
        }
        expect(exercised).toBeGreaterThan(0);
      }),
    ),
);

it.effect(
  'workforce derives MCP commands from real closed registrations and executes their published HTTP audit identities',
  () =>
    Effect.scoped(
      Effect.gen(function* transportIdentity() {
        const manifest = workforceManifest;
        const derived = deriveOntosMcpContribution({
          actions: manifest.publicSurface.actions,
          api: manifest.publicSurface.api,
          appId: 'workforce',
          authored: manifest.publicSurface.mcp,
          moduleId: manifest.module.id,
        });
        if (derived === undefined) {
          expect.unreachable(expectedContribution);
        }
        expect(derived.contribution.toolCatalog.path).toBe(ONTOS_MODULE_MCP_TOOL_CATALOG_PATH);
        expect(derived.contribution.toolCatalog.path).toBe(catalogPath);
        expect(derived.contribution.toolCatalog.sha256).toBe(
          createHash('sha256').update(derived.toolCatalog).digest('hex'),
        );
        const catalog = yield* Schema.decodeEffect(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
        let exercised = 0;
        for (const { command, slug } of workforceCases) {
          const tool = catalog.tools.find((entry) => entry.invoke.commandTag === command._tag);
          // Authored hidden tools stay hidden. The HTTP-only cleanup/image/review tests remain separate.
          if (tool === undefined) {
            expect(manifest.publicSurface.mcp?.commands?.[command._tag]).toBe('hidden');
            continue;
          }
          expect(tool.invoke.path).toBe(`/workforce/actions/${slug}`);
          expect(tool.access).toBe('write');
          const registration = workforceRegistrations.find(
            (action) => action.descriptor.actionKey === `demo.workforce.${slug}`,
          );
          if (registration === undefined) {
            expect.unreachable(expectedRegistration);
          }
          expect(manifest.publicSurface.actions).toContain(registration);
          yield* Schema.decodeUnknownEffect(registration.descriptor.payloadSchema)({ command, expectedRevision: 1 });
          const { harness, request, writes } = yield* workforceFixture();
          const response = yield* request(tool.invoke.path, command, `mcp-${slug}`);
          expect(response.status).toBe(200);
          expect(harness.snapshot().invocations[0]?.actionKey).toBe(registration.descriptor.actionKey);
          expect(harness.snapshot().committed[0]?.actionKey).toBe(registration.descriptor.actionKey);
          expect(writes).toEqual([command]);
          if (slug !== createSlug) {
            const retired = yield* request('/workforce/actions/apply-command', command, `old-mcp-${slug}`);
            expect(retired.status).toBe(400);
            expect(harness.snapshot().committed).toHaveLength(1);
          }
          exercised += 1;
        }
        expect(exercised).toBeGreaterThan(0);
      }),
    ),
);

it.effect(
  'sales-insights derives MCP commands from real closed registrations and executes their published HTTP audit identities',
  () =>
    Effect.scoped(
      Effect.gen(function* transportIdentity() {
        const manifest = salesInsightsManifest;
        const derived = deriveOntosMcpContribution({
          actions: manifest.publicSurface.actions,
          api: manifest.publicSurface.api,
          appId: salesInsightsAppId,
          authored: manifest.publicSurface.mcp,
          moduleId: manifest.module.id,
        });
        if (derived === undefined) {
          expect.unreachable(expectedContribution);
        }
        expect(derived.contribution.toolCatalog.path).toBe(ONTOS_MODULE_MCP_TOOL_CATALOG_PATH);
        expect(derived.contribution.toolCatalog.path).toBe(catalogPath);
        expect(derived.contribution.toolCatalog.sha256).toBe(
          createHash('sha256').update(derived.toolCatalog).digest('hex'),
        );
        const catalog = yield* Schema.decodeEffect(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
        let exercised = 0;
        for (const { command, slug } of salesInsightsCases) {
          const tool = catalog.tools.find((entry) => entry.invoke.commandTag === command._tag);
          // Authored hidden tools stay hidden. The HTTP-only cleanup/image/review tests remain separate.
          if (tool === undefined) {
            expect(manifest.publicSurface.mcp?.commands?.[command._tag]).toBe('hidden');
            continue;
          }
          expect(tool.invoke.path).toBe(`/sales-insights/actions/${slug}`);
          expect(tool.access).toBe('write');
          const registration = salesInsightsRegistrations.find(
            (action) => action.descriptor.actionKey === `demo.sales-insights.${slug}`,
          );
          if (registration === undefined) {
            expect.unreachable(expectedRegistration);
          }
          expect(manifest.publicSurface.actions).toContain(registration);
          yield* Schema.decodeUnknownEffect(registration.descriptor.payloadSchema)({ command, expectedRevision: 1 });
          const { harness, request, writes } = yield* salesInsightsFixture();
          const response = yield* request(tool.invoke.path, command, `mcp-${slug}`);
          expect(response.status).toBe(200);
          expect(harness.snapshot().invocations[0]?.actionKey).toBe(registration.descriptor.actionKey);
          expect(harness.snapshot().committed[0]?.actionKey).toBe(registration.descriptor.actionKey);
          expect(writes).toEqual([command]);
          if (slug !== createSlug) {
            const retired = yield* request('/sales-insights/actions/apply-command', command, `old-mcp-${slug}`);
            expect(retired.status).toBe(400);
            expect(harness.snapshot().committed).toHaveLength(1);
          }
          exercised += 1;
        }
        expect(exercised).toBeGreaterThan(0);
      }),
    ),
);

it.effect(
  'merchandise derives MCP commands from real closed registrations and executes their published HTTP audit identities',
  () =>
    Effect.scoped(
      Effect.gen(function* transportIdentity() {
        const manifest = merchandiseManifest;
        const derived = deriveOntosMcpContribution({
          actions: manifest.publicSurface.actions,
          api: manifest.publicSurface.api,
          appId: 'merchandise',
          authored: manifest.publicSurface.mcp,
          moduleId: manifest.module.id,
        });
        if (derived === undefined) {
          expect.unreachable(expectedContribution);
        }
        expect(derived.contribution.toolCatalog.path).toBe(ONTOS_MODULE_MCP_TOOL_CATALOG_PATH);
        expect(derived.contribution.toolCatalog.path).toBe(catalogPath);
        expect(derived.contribution.toolCatalog.sha256).toBe(
          createHash('sha256').update(derived.toolCatalog).digest('hex'),
        );
        const catalog = yield* Schema.decodeEffect(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
        let exercised = 0;
        for (const { command, slug } of merchandiseCases) {
          const tool = catalog.tools.find((entry) => entry.invoke.commandTag === command._tag);
          // Authored hidden tools stay hidden. The HTTP-only cleanup/image/review tests remain separate.
          if (tool === undefined) {
            expect(manifest.publicSurface.mcp?.commands?.[command._tag]).toBe('hidden');
            continue;
          }
          expect(tool.invoke.path).toBe(`/merchandise/actions/${slug}`);
          expect(tool.access).toBe('write');
          const registration = merchandiseRegistrations.find(
            (action) => action.descriptor.actionKey === `demo.merchandise.${slug}`,
          );
          if (registration === undefined) {
            expect.unreachable(expectedRegistration);
          }
          expect(manifest.publicSurface.actions).toContain(registration);
          yield* Schema.decodeUnknownEffect(registration.descriptor.payloadSchema)({ command, expectedRevision: 1 });
          const { harness, request, writes } = yield* merchandiseFixture();
          const response = yield* request(tool.invoke.path, command, `mcp-${slug}`);
          expect(response.status).toBe(200);
          expect(harness.snapshot().invocations[0]?.actionKey).toBe(registration.descriptor.actionKey);
          expect(harness.snapshot().committed[0]?.actionKey).toBe(registration.descriptor.actionKey);
          expect(writes).toEqual([command]);
          if (slug !== createSlug) {
            const retired = yield* request('/merchandise/actions/apply-command', command, `old-mcp-${slug}`);
            expect(retired.status).toBe(400);
            expect(harness.snapshot().committed).toHaveLength(1);
          }
          exercised += 1;
        }
        expect(exercised).toBeGreaterThan(0);
      }),
    ),
);

it('all five owners publish canonical clients and schema-only contracts, with no private-path or legacy dispatch alias', () => {
  const require = createRequire(new URL('../../package.json', import.meta.url));
  const operations = [
    { owner: 'crm-activities', slugs: [createSlug] },
    { owner: 'tagging', slugs: [createSlug, 'assign-tag', 'delete-tag', 'unassign-tag', 'update-tag'] },
    { owner: 'workforce', slugs: [createSlug, 'update-employee'] },
    { owner: salesInsightsAppId, slugs: [createSlug, 'assign-metric', 'change-metric-state', 'update-metric'] },
    {
      owner: 'merchandise',
      slugs: [
        createSlug,
        'change-order-status',
        'change-product-images',
        'cleanup-demo',
        'manage-catalog',
        'manage-markets',
        'place-storefront-order',
        'propose-order-changes',
        'record-stock-movement',
        'review-order-changes',
      ],
    },
  ];
  for (const { owner, slugs } of operations) {
    for (const slug of slugs) {
      expect(require.resolve(`@app/${owner}/clients/${slug}`)).toBe(
        fileURLToPath(new URL(`../../verticals/${owner}/src/api/${slug}-action-client.ts`, import.meta.url)),
      );
      expect(require.resolve(`@app/${owner}/contracts/${slug}`)).toBe(
        fileURLToPath(new URL(`../../verticals/${owner}/shared/actions/${slug}.ts`, import.meta.url)),
      );
    }
  }
});

const splitOwners = [
  { appId: 'tagging', cases: taggingCases, manifest: taggingManifest },
  { appId: 'workforce', cases: workforceCases, manifest: workforceManifest },
  { appId: salesInsightsAppId, cases: salesInsightsCases, manifest: salesInsightsManifest },
  { appId: 'merchandise', cases: merchandiseCases, manifest: merchandiseManifest },
] as const;

for (const { appId, cases, manifest } of splitOwners) {
  it(`${appId} publishes which Action owns each command, so proposals and approvals address that Action`, () => {
    const derived = deriveOntosMcpContribution({
      actions: manifest.publicSurface.actions,
      api: manifest.publicSurface.api,
      appId,
      authored: manifest.publicSurface.mcp,
      moduleId: manifest.module.id,
    });
    if (derived === undefined) {
      expect.unreachable(expectedContribution);
    }
    const { commandActions } = derived.contribution;
    expect(cases.length).toBeGreaterThan(0);
    for (const { command, slug } of cases) {
      // Hidden commands are published too: approvals and the module's own AI engine run them.
      expect(commandActions?.[command._tag]).toEqual([slug]);
      expect(commandActionSlugOf(commandActions, command._tag)).toBe(slug);
      // Decisions on the module's own AI changes stay a person's; every other command is proposable on its Action.
      expect(isProposableModuleCommand(commandActions, slug, command)).toBe(slug !== 'review-order-changes');
      if (slug !== createSlug) {
        expect(isProposableModuleCommand(commandActions, createSlug, command)).toBe(false);
      }
    }
  });
}

it('work tasks keeps every command on its unsplit apply-command', () => {
  const manifest = workTasksManifest;
  const derived = deriveOntosMcpContribution({
    actions: manifest.publicSurface.actions,
    api: manifest.publicSurface.api,
    appId: 'work-tasks',
    authored: manifest.publicSurface.mcp,
    moduleId: manifest.module.id,
  });
  if (derived === undefined) {
    expect.unreachable(expectedContribution);
  }
  const { commandActions } = derived.contribution;
  expect(commandActions?.CreateTask).toEqual([createSlug]);
  expect(isProposableModuleCommand(commandActions, createSlug, { _tag: 'CreateTask', title: 'Task' })).toBe(true);
});
