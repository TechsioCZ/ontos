import { equal, ok } from 'node:assert/strict';
import { Schema } from 'effect';
import { it } from 'effect-rstest';

import { OntosMcpHidden, OntosMcpToolCatalogJsonSchema } from '../../packages/core-runtime/src/modules/mcp-contribution.ts';
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
  ok(derived);
  const catalog = Schema.decodeUnknownSync(OntosMcpToolCatalogJsonSchema)(derived.toolCatalog);
  for (const key of ['demo-catalog-revision', 'demo-order-export'] as const) {
    ok(key in surface.api);
    equal(merchandiseMcpContribution.reads[key], OntosMcpHidden);
    ok(catalog.tools.every((tool) => tool.invoke.path !== `/reads/${key}`));
  }
  ok(catalog.tools.some((tool) => tool.invoke.path === '/reads/records'));
});
