import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'effect-rstest';

// A vertical host whose read runtime lacks the governed module route refuses to start as soon as one of
// its reads calls another module (`makeReadRuntimeLive`, `module_call_without_route`). Every host gets
// the route up front, so a read that starts calling another module needs no host change.
const verticalsRoot = fileURLToPath(new URL('../../verticals/', import.meta.url));
const READ_RUNTIME = /\b(?:GovernedMakeReadRuntimeLive|makeReadRuntimeLive)\(/u;

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry);
    if (statSync(file).isDirectory()) {
      return sourceFiles(file);
    }
    return file.endsWith('.ts') ? [file] : [];
  });

const hostReadRuntimeFiles = (): string[] =>
  readdirSync(verticalsRoot).flatMap((vertical) => {
    const api = path.join(verticalsRoot, vertical, 'api');
    return existsSync(api) ? sourceFiles(api).filter((file) => READ_RUNTIME.test(readFileSync(file, 'utf-8'))) : [];
  });

it('gives every vertical host read runtime the governed module route', () => {
  const hosts = hostReadRuntimeFiles();
  expect(hosts.length).toBeGreaterThan(0);
  const missing = hosts.filter((file) => !readFileSync(file, 'utf-8').includes('ModuleCallRouteLive'));
  expect(missing).toEqual([]);
});
