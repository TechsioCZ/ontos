import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import {
  hasCompleteGeneratedModuleApiSeam,
  hasCompleteGeneratedModuleRead,
} from '../generated-governed-http-boundary.mts';

const root = path.resolve(import.meta.dirname, '../..');
const owner = 'verticals/projects';
const readFile = `${owner}/src/api/read-project.read.ts`;
const moduleId = 'projects.core';
const name = 'read-project';

const readSources = (directory: string, sources = new Map<string, string>()): Map<string, string> => {
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

const sources = readSources(owner);
const source = sources.get(readFile) ?? '';
const accepts = (input: string, diagnostics?: string[]): boolean =>
  hasCompleteGeneratedModuleRead(
    new Map([...sources, [readFile, input]]),
    readFile,
    owner,
    moduleId,
    name,
    diagnostics,
  );

it('proves the actual curried Projects Read load and its bound owner scoped factory', () => {
  const diagnostics: string[] = [];
  expect(accepts(source, diagnostics), diagnostics.join('\n')).toBe(true);
  // Other owners' in-flight probes may append their own labels; none may report this Read.
  expect(diagnostics.filter((entry) => entry.includes('curried owner') || entry.includes(readFile))).toEqual([]);
  const seamDiagnostics: string[] = [];
  expect(
    hasCompleteGeneratedModuleApiSeam(sources, `${owner}/shared/api.ts`, 'projects', seamDiagnostics),
    seamDiagnostics.join('\n'),
  ).toBe(true);
});

const controls: readonly (readonly [string, string, string])[] = [
  [
    'swapped curried services and tenant',
    'context.services,\n        context.scope.tenantId,',
    'context.scope.tenantId,\n        context.services,',
  ],
  [
    'foreign tenant projection',
    'context.scope.tenantId,\n      )(input.projectId)',
    'context.scope.principalId,\n      )(input.projectId)',
  ],
  ['foreign request projection', '(input.projectId).pipe(', '(context.projectId).pipe('],
  ['flipped tenant guard', 'value.tenantId === tenantId', 'value.tenantId !== tenantId'],
  [
    'dropped tenant guard',
    'value.tenantId === tenantId\n              ? Effect.succeed(value)',
    'true\n              ? Effect.succeed(value)',
  ],
  [
    'value from the not_found branch',
    "not_found: () =>\n            Effect.fail(new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'Project was not found' })),",
    'not_found: ({ value }) => Effect.succeed(value),',
  ],
  ['renamed lookup tag', 'found: ({ value }) =>', 'some: ({ value }) =>'],
  ['dropped Match.exhaustive', '        Match.exhaustive,\n', ''],
  [
    'foreign Match namespace',
    "import { Effect, Match } from 'effect';",
    "import { Effect } from 'effect';\nimport { Match } from './foreign-match.ts';",
  ],
  [
    'foreign Effect namespace',
    "import { Effect, Match } from 'effect';",
    "import { Match } from 'effect';\nimport { Effect } from './foreign-effect.ts';",
  ],
  ['foreign success branch', '? Effect.succeed(value)', '? foreign.succeed(value)'],
  ['foreign failure construction', 'new ReadHandlerNotFound({ code:', 'new ForeignReadHandlerNotFound({ code:'],
  [
    'unbound finder method',
    'find: (projectId: string) => persistence.find(projectId)',
    'find: (projectId: string) => find(projectId)',
  ],
  [
    'foreign persistence factory',
    "from '../services/project-persistence.service.ts'",
    "from '../../foreign/project-persistence.service.ts'",
  ],
  ['altered factory principal', 'operationId: scope.principalId,', 'operationId: scope.tenantId,'],
  [
    'foreign factory transaction',
    'makeProjectPersistenceService(transaction, {',
    'makeProjectPersistenceService(scope, {',
  ],
  [
    'renamed published method',
    'return Effect.succeed({ find: (projectId: string) => persistence.find(projectId) });',
    'return Effect.succeed({ lookup: (projectId: string) => persistence.find(projectId) });',
  ],
  ['result ignores the loaded value', 'result: project }', 'result: undefined }'],
  [
    'unbound load handler',
    'makeReadProjectHandler(\n        context.services,\n        context.scope.tenantId,\n      )(input.projectId)',
    'foreignHandler(\n        context.services,\n        context.scope.tenantId,\n      )(input.projectId)',
  ],
] as const;

for (const [defect, before, after] of controls) {
  it(`rejects the Projects Read with ${defect}`, () => {
    const invalid = source.replace(before, after);
    expect(invalid).not.toBe(source);
    expect(parseSync(readFile, invalid).errors).toEqual([]);
    expect(accepts(invalid)).toBe(false);
  });
}

it('rejects a shadowed or reassigned curried handler and native namespaces', () => {
  for (const mutation of [
    '\nexport const makeReadProjectHandler = foreign;\n',
    '\nexport let makeReadProjectHandler = foreign;\n',
    '\nEffect.fail = foreign;\n',
    '\nMatch.tags = foreign;\n',
  ]) {
    const invalid = `${source}${mutation}`;
    expect(parseSync(readFile, invalid).errors).toEqual([]);
    expect(accepts(invalid), mutation).toBe(false);
  }
});

it('rejects a forged owner factory that publishes no real persistence record', () => {
  const forged = source.replace(
    `  (transaction, scope) => {
    const persistence = makeProjectPersistenceService(transaction, {
      operationId: scope.principalId,
      tenantId: scope.tenantId,
    });
    return Effect.succeed({ find: (projectId: string) => persistence.find(projectId) });
  },`,
    '  () => Effect.succeed({}),',
  );
  expect(forged).not.toBe(source);
  expect(parseSync(readFile, forged).errors).toEqual([]);
  expect(accepts(forged)).toBe(false);
});
