// @rstest-environment node
import { Crypto, Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ShellCryptoLive } from '../../../api/auth/gateway-issuer.ts';
import type { McpCatalog, McpCatalogModule, McpCatalogTool } from '../../../api/mcp/catalog.ts';
import { planTools, TYPED_TOOL_CAP } from '../../../api/mcp/tool-plan.ts';
import { buildConnectionTools } from '../../../api/mcp/tools.ts';
import type { McpBackend } from '../../../api/mcp/types.ts';
import { connectionDescription, fixtureCatalog } from './fixture-vertical.ts';

interface PlannedModule {
  readonly agentProposalOnlyWrites?: number;
  readonly genericOnlyReads?: number;
  readonly genericOnlyWrites?: number;
  readonly label: string;
  readonly moduleId: string;
  readonly reads: number;
  readonly writes?: number;
}

const base = () => {
  const [module] = fixtureCatalog().modules;
  const read = module?.tools.find((tool) => tool.access === 'read');
  const write = module?.tools.find((tool) => tool.access === 'write' && !tool.agentProposalOnly);
  if (module === undefined || read === undefined || write === undefined) {
    throw new Error('fixture catalog changed');
  }
  return { module, read, write };
};

const many = (count: number | undefined, make: (index: number) => McpCatalogTool) =>
  Array.from({ length: count ?? 0 }, (_unused, index) => make(index));

const moduleOf = (planned: PlannedModule): McpCatalogModule => {
  const { module, read, write } = base();
  const slug = planned.moduleId.replaceAll(/[^a-z]/gu, '_');
  const tool = (template: McpCatalogTool, kind: string, index: number, extra: Partial<McpCatalogTool> = {}) => ({
    ...template,
    id: `${planned.moduleId}/${kind}/${index}`,
    moduleId: planned.moduleId,
    name: `${slug}__${kind}_${index}`,
    ...extra,
  });
  return {
    ...module,
    label: { cs: planned.label, en: planned.label },
    moduleId: planned.moduleId,
    tools: [
      ...many(planned.reads, (index) => tool(read, 'read', index)),
      ...many(planned.writes, (index) => tool(write, 'write', index)),
      ...many(planned.agentProposalOnlyWrites, (index) => tool(write, 'proposal', index, { agentProposalOnly: true })),
      ...many(planned.genericOnlyReads, (index) => tool(read, 'generic_read', index, { genericOnly: true })),
      ...many(planned.genericOnlyWrites, (index) => tool(write, 'generic_write', index, { genericOnly: true })),
    ],
  };
};

/** The demo connection today: 33 typed tools for a person with direct writes. */
const DEMO: readonly PlannedModule[] = [
  {
    agentProposalOnlyWrites: 8,
    label: 'E-shop – katalog, sklad a objednávky',
    moduleId: 'merchandise',
    reads: 1,
    writes: 7,
  },
  { label: 'Úkoly a projekty', moduleId: 'work.tasks', reads: 1, writes: 10 },
  { label: 'Obchodní trhy', moduleId: 'commerce.market-catalog', reads: 4 },
  { label: 'Registr e-shopů', moduleId: 'storefront.registry', reads: 2 },
];
/** Tax as its contribution publishes it: 7 typed tools, 8 generic-only. */
const TAX: PlannedModule = {
  genericOnlyReads: 5,
  genericOnlyWrites: 3,
  label: 'Daně a DPH',
  moduleId: 'commerce.tax',
  reads: 3,
  writes: 4,
};

const catalogOf = (granted: readonly PlannedModule[]): McpCatalog => ({
  ...fixtureCatalog(),
  // The catalog is sorted by module id; the plan must not depend on that order.
  modules: granted.map(moduleOf).toSorted((left, right) => left.moduleId.localeCompare(right.moduleId)),
});

const descriptionOf = (
  granted: readonly PlannedModule[],
  overrides: Parameters<typeof connectionDescription>[0] = {},
) =>
  connectionDescription({
    modules: granted.map(({ label, moduleId }) => ({ label, moduleId, read: true, write: true })),
    ...overrides,
  });

const typedCountBy = (plan: ReturnType<typeof planTools>) => {
  const counts = new Map<string, number>();
  for (const tool of plan.typed) {
    counts.set(tool.moduleId, (counts.get(tool.moduleId) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
};

describe('typed-tool plan', () => {
  it('keeps every demo module typed and adds tax whole (generic-only entries never listed)', () => {
    const granted = [...DEMO, TAX];
    const plan = planTools(catalogOf(granted), descriptionOf(granted));
    expect(plan.typed).toHaveLength(TYPED_TOOL_CAP);
    expect(typedCountBy(plan)).toEqual({
      'commerce.market-catalog': 4,
      'commerce.tax': 7,
      merchandise: 16,
      'storefront.registry': 2,
      'work.tasks': 11,
    });
    expect(plan.typed.some((tool) => tool.genericOnly === true)).toBe(false);
    expect(plan.typedOverCap).toBe(false);
    expect(plan.modules.every((module) => module.mode === 'typed')).toBe(true);
  });

  it('degrades by whole modules in Czech label order and never to zero typed tools', () => {
    // A tax contribution without generic-only entries (15 tools) no longer fits next to the demo modules.
    const fatTax: PlannedModule = { label: 'Daně a DPH', moduleId: 'commerce.tax', reads: 8, writes: 7 };
    const granted = [...DEMO, fatTax];
    const plan = planTools(catalogOf(granted), descriptionOf(granted));
    expect(plan.modules.map(({ mode, moduleId }) => [moduleId, mode])).toEqual([
      ['commerce.tax', 'typed'],
      ['merchandise', 'typed'],
      ['commerce.market-catalog', 'typed'],
      ['storefront.registry', 'typed'],
      ['work.tasks', 'generic_only'],
    ]);
    expect(typedCountBy(plan)).not.toHaveProperty('work.tasks');
    expect(plan.typed).toHaveLength(37);
    expect(plan.typedCandidates).toBe(48);
    expect(plan.typedOverCap).toBe(true);
  });

  it('is deterministic: the same connection gets the same tools whatever order modules arrive in', () => {
    const granted = [...DEMO, TAX, { label: 'Daně a DPH', moduleId: 'commerce.tax-b', reads: 30 }];
    const first = planTools(catalogOf(granted), descriptionOf(granted));
    const reversed = planTools(
      { ...catalogOf(granted), modules: catalogOf(granted).modules.toReversed() },
      descriptionOf(granted.toReversed()),
    );
    expect(reversed.typed.map(({ id }) => id)).toEqual(first.typed.map(({ id }) => id));
    expect(reversed.modules).toEqual(first.modules);
    // Equal labels fall back to the module id: commerce.tax is placed before commerce.tax-b.
    expect(first.modules.slice(0, 2)).toEqual([
      { candidates: 7, mode: 'typed', moduleId: 'commerce.tax' },
      { candidates: 30, mode: 'typed', moduleId: 'commerce.tax-b' },
    ]);
  });

  it('a module larger than the whole cap stays generic-only and later modules still fit', () => {
    const granted = [{ label: 'Admin katalog', moduleId: 'catalog', reads: 80 }, ...DEMO];
    const plan = planTools(catalogOf(granted), descriptionOf(granted));
    expect(plan.modules[0]).toEqual({ candidates: 80, mode: 'generic_only', moduleId: 'catalog' });
    expect(plan.typed).toHaveLength(33);
    expect(typedCountBy(plan)).not.toHaveProperty('catalog');
    expect(plan.generic).toEqual(expect.arrayContaining(['ontos_capabilities', 'ontos_read', 'ontos_execute']));
  });

  it('counts only tools the connection may use: agent direct writes skip proposal-only Actions', () => {
    const granted = [...DEMO, TAX];
    const plan = planTools(
      catalogOf(granted),
      descriptionOf(granted, {
        acting: { displayName: 'Agent', kind: 'agent', principalId: 'principal-agent' },
      }),
    );
    expect(typedCountBy(plan)['merchandise']).toBe(8);
    expect(plan.typed).toHaveLength(32);
    const readOnly = planTools(catalogOf(granted), descriptionOf(granted, { writePolicy: 'read_only' }));
    expect(readOnly.typed.every((tool) => tool.access === 'read')).toBe(true);
    expect(readOnly.typed).toHaveLength(11);
  });

  it('lists no module the connection may not read', () => {
    const granted = [...DEMO, TAX];
    const plan = planTools(catalogOf(granted), descriptionOf(DEMO));
    expect(typedCountBy(plan)).not.toHaveProperty('commerce.tax');
    expect(plan.modules.map(({ moduleId }) => moduleId)).not.toContain('commerce.tax');
  });
});

const noBackend: McpBackend = {
  callModule: () => Effect.die('no module calls expected'),
  listProposals: Effect.die('no proposal reads expected'),
  submitProposals: () => Effect.die('no proposals expected'),
};

describe('whoami and capabilities report the plan', () => {
  const build = Effect.fn('ToolPlanTest.build')(function* build(
    granted: readonly PlannedModule[],
    writePolicy: 'approval' | 'direct' = 'direct',
  ) {
    const crypto = yield* Effect.service(Crypto.Crypto).pipe(Effect.provide(ShellCryptoLive));
    return buildConnectionTools({
      backend: noBackend,
      catalog: catalogOf(granted),
      crypto,
      description: descriptionOf(granted, { writePolicy }),
      prmUrl: 'https://plan.test/.well-known/oauth-protected-resource/mcp',
      publicOrigin: 'https://plan.test',
    });
  });

  it.effect('names the typed and the generic-only modules in plain language', () =>
    Effect.gen(function* whoamiOverCap() {
      const granted = [...DEMO, { label: 'Daně a DPH', moduleId: 'commerce.tax', reads: 8, writes: 7 }];
      const tools = yield* build(granted);
      const whoami = yield* Effect.fromNullishOr(tools.find(({ name }) => name === 'ontos_whoami'));
      const result = yield* whoami.handler({});
      expect(result.structuredContent?.['typedTools']).toEqual({
        cap: 40,
        count: 37,
        genericOnlyModules: ['work.tasks'],
        noteCs:
          'Vlastní nástroje v seznamu mají moduly: Daně a DPH, E-shop – katalog, sklad a objednávky, Obchodní trhy, Registr e-shopů. Jen přes obecné nástroje (ontos_capabilities, ontos_read, ontos_execute) fungují: Úkoly a projekty. Oprávnění jsou v obou případech stejná.',
        overCap: true,
      });
      const modules = result.structuredContent?.['modules'];
      expect(modules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ moduleId: 'commerce.tax', tools: 15, typedTools: 15 }),
          expect.objectContaining({
            moduleId: 'work.tasks',
            tools: 11,
            toolsNoteCs: expect.stringContaining('ontos_capabilities {moduleId: "work.tasks"}'),
            typedTools: 0,
          }),
        ]),
      );
      expect(tools.some(({ name }) => name.startsWith('work_tasks__'))).toBe(false);
      expect(tools.filter(({ name }) => !name.startsWith('ontos_'))).toHaveLength(37);
    }),
  );

  it.effect('keeps whoami quiet when everything fits and points unlisted tools at the generic tools', () =>
    Effect.gen(function* whoamiFits() {
      // Approval mode: inspecting an Action needs no live-right preflight read.
      const tools = yield* build([...DEMO, TAX], 'approval');
      const whoami = yield* Effect.fromNullishOr(tools.find(({ name }) => name === 'ontos_whoami'));
      const result = yield* whoami.handler({});
      expect(result.structuredContent?.['typedTools']).toEqual({
        cap: 40,
        count: 40,
        genericOnlyModules: [],
        overCap: false,
      });
      const capabilities = yield* Effect.fromNullishOr(tools.find(({ name }) => name === 'ontos_capabilities'));
      const listedRead = yield* capabilities.handler({ id: 'commerce.tax/read/0' });
      expect(listedRead.structuredContent).toMatchObject({ toolName: 'commerce_tax__read_0' });
      const genericRead = yield* capabilities.handler({ id: 'commerce.tax/generic_read/0' });
      expect(genericRead.structuredContent).toMatchObject({ kind: 'read', toolName: 'ontos_read' });
      const genericWrite = yield* capabilities.handler({ id: 'commerce.tax/generic_write/0' });
      expect(genericWrite.structuredContent).toMatchObject({ kind: 'action', toolName: 'ontos_execute' });
    }),
  );
});
