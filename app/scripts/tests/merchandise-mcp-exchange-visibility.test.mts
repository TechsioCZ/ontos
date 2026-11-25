import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  OntosMcpHidden,
  OntosMcpToolCatalogJsonSchema,
} from '../../packages/core-runtime/src/modules/mcp-contribution.ts';
import { merchandiseManifest } from '../../verticals/merchandise/vertical.manifest.ts';
import { merchandiseMcpContribution } from '../../verticals/merchandise/shared/mcp/contribution.ts';
import { deriveOntosMcpContribution } from '../ontos-mcp-contribution.mts';

it('derives the actual Merchandise MCP catalog while keeping Symmy-only exchange reads off the agent surface', () => {
  const surface = merchandiseManifest.publicSurface;
  const derived = deriveOntosMcpContribution({
    actions: surface.actions,
    api: surface.api,
    appId: 'merchandise',
    authored: surface.mcp,
    moduleId: merchandiseManifest.module.id,
  });
  if (derived === undefined) {
    throw new Error('The Merchandise MCP contribution was not derived');
  }
  const catalog = Schema.decodeUnknownSync(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
  for (const key of ['demo-catalog-revision', 'demo-order-export'] as const) {
    expect(key in surface.api).toBe(true);
    expect(merchandiseMcpContribution.reads[key]).toBe(OntosMcpHidden);
    expect(catalog.tools.every((tool) => tool.invoke.path !== `/reads/${key}`)).toBe(true);
  }
  expect(catalog.tools.some((tool) => tool.invoke.path === '/reads/records')).toBe(true);
});
