// @rstest-environment node
/**
 * Core, the Shell's MCP endpoint and the platform approval layer must not know any MicroVertical: every vertical
 * id, module id, tool name or label comes from the composed module contracts. This test fails when a vertical
 * id or module id appears in that source (as a quoted literal or a path segment for app ids, anywhere for module ids).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from '@rstest/core';

const appRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const verticalsRoot = path.join(appRoot, 'verticals');

/** Source that must stay free of vertical knowledge. */
const GUARDED = [
  'apps/shell-super-app/api/mcp',
  'apps/shell-super-app/api/oauth-connections',
  'apps/shell-super-app/api/agent-platform/caller.ts',
  'apps/shell-super-app/api/agent-platform/composed-modules.ts',
  'apps/shell-super-app/api/agent-platform/legacy-normalize.ts',
  'apps/shell-super-app/api/agent-platform/legacy-queue.ts',
  'apps/shell-super-app/api/agent-platform/mappers.ts',
  'apps/shell-super-app/api/agent-platform/module-call.ts',
  'apps/shell-super-app/api/agent-platform/proposal-store.ts',
  'packages/shared-contracts/src/agent-access.ts',
  'packages/shared-contracts/src/agent-proposals.ts',
  'apps/shell-super-app/shared/mcp-resource.ts',
  'packages/core-runtime/src/modules/mcp-contribution.ts',
  'packages/core-runtime/src/modules/manifest.ts',
  'scripts/ontos-mcp-contribution.mts',
];

const verticals = readdirSync(verticalsRoot).flatMap((directory) => {
  try {
    const manifest = JSON.parse(readFileSync(path.join(verticalsRoot, directory, 'package.json'), 'utf-8')) as {
      readonly modernjs?: { readonly appId?: string; readonly ontosModule?: { readonly moduleId?: string } };
    };
    return [
      {
        appId: manifest.modernjs?.appId ?? directory,
        moduleId: manifest.modernjs?.ontosModule?.moduleId,
      },
    ];
  } catch {
    return [];
  }
});

const escape = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const patterns = verticals.flatMap(({ appId, moduleId }) => [
  { id: appId, pattern: new RegExp(`['"\`/]${escape(appId)}['"\`/]`, 'u') },
  ...(moduleId === undefined ? [] : [{ id: moduleId, pattern: new RegExp(escape(moduleId), 'u') }]),
]);

const filesOf = (relative: string): string[] => {
  const absolute = path.join(appRoot, relative);
  if (statSync(absolute).isFile()) {
    return [absolute];
  }
  return readdirSync(absolute, { recursive: true })
    .map((entry) => path.join(absolute, String(entry)))
    .filter((file) => /\.(?:mts|ts|tsx)$/u.test(file) && statSync(file).isFile());
};

it('finds the verticals of this workspace', () => {
  expect(verticals.length).toBeGreaterThan(5);
});

it('keeps Core, the MCP endpoint and the approval layer free of vertical ids', () => {
  const hits = GUARDED.flatMap(filesOf).flatMap((file) => {
    const lines = readFileSync(file, 'utf-8').split('\n');
    return lines.flatMap((line, index) =>
      patterns
        .filter(({ pattern }) => pattern.test(line))
        .map(({ id }) => `${path.relative(appRoot, file)}:${index + 1} names ${id}`),
    );
  });
  expect(hits).toEqual([]);
});
