// @rstest-environment node
/**
 * Core and the Shell platform must not know any MicroVertical: every vertical id, module id, tool name, label,
 * navigation entry, review rule or follow-up comes from the composed module contracts. This test fails when a
 * vertical id appears in that source as a quoted literal or a path segment, or a module id appears anywhere.
 * Allowed exceptions: demo guide content and seed data (tenant data, not platform behaviour).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from '@rstest/core';

const appRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const verticalsRoot = path.join(appRoot, 'verticals');

/** All of Core and the Shell server and UI. */
const GUARDED = [
  'packages/core-runtime/src',
  'packages/shared-contracts/src',
  'apps/shell-super-app/api',
  'apps/shell-super-app/server',
  'apps/shell-super-app/shared',
  'apps/shell-super-app/src',
  'scripts/ontos-mcp-contribution.mts',
];

/** Demo guide content and seed data (`demo-seed/` directories) name the demo tenants' modules on purpose. */
const EXCEPTIONS = ['apps/shell-super-app/src/demo-guide/guides/'];
const SEED_DIRECTORY = `${path.sep}demo-seed${path.sep}`;

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

const isException = (file: string): boolean => {
  const relative = path.relative(appRoot, file);
  return file.includes(SEED_DIRECTORY) || EXCEPTIONS.some((exception) => relative.startsWith(exception));
};

const filesOf = (relative: string): string[] => {
  const absolute = path.join(appRoot, relative);
  if (statSync(absolute).isFile()) {
    return [absolute];
  }
  return readdirSync(absolute, { recursive: true })
    .map((entry) => path.join(absolute, String(entry)))
    .filter(
      (file) =>
        /\.(?:mts|ts|tsx)$/u.test(file) && !file.includes(`${path.sep}node_modules${path.sep}`) && statSync(file).isFile(),
    )
    .filter((file) => !isException(file));
};

it('finds the verticals of this workspace', () => {
  expect(verticals.length).toBeGreaterThan(5);
});

it('keeps Core and the whole Shell platform free of vertical ids', () => {
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
