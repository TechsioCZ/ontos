import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { hasCompleteGeneratedModuleApiSeam } from '../generated-governed-http-boundary.mts';

const root = path.resolve(import.meta.dirname, '../..');
const owner = 'verticals/projects';
const handler = `${owner}/api/index.ts`;
const readSources = (directory: string, sources = new Map<string, string>()) => {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (['node_modules', 'dist', '.output', '.modern', 'coverage', 'cloudflare-dist'].includes(entry.name)) {
      continue;
    }
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      readSources(file, sources);
    } else if (entry.name.endsWith('.ts') || entry.name === 'package.json') {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
  return sources;
};

it('distinguishes archive from unarchive handlers while rejecting missing or duplicated publication', () => {
  const sources = readSources(owner);
  const entry = sources.get(handler) ?? '';
  const archive = '  archiveProjectActionApiLive,';
  expect(entry).toContain(archive);
  expect(hasCompleteGeneratedModuleApiSeam(sources, `${owner}/shared/api.ts`)).toBe(true);
  for (const replacement of ['', `${archive}\n  ${archive}`]) {
    const invalid = new Map([...sources, [handler, entry.replace(archive, replacement)]]);
    expect(hasCompleteGeneratedModuleApiSeam(invalid, `${owner}/shared/api.ts`)).toBe(false);
  }
});
