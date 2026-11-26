import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { hasCompleteGeneratedModuleApiSeam } from '../generated-governed-http-boundary.mts';
import { readWorkspaceManifests } from './module-entrypoint-boundary-fixtures.mts';

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
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.json')) {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
  return sources;
};

it.live('distinguishes archive from unarchive handlers while rejecting missing or duplicated publication', () =>
  Effect.gen(function* archivePublication() {
    const sources = readSources(owner, new Map(yield* readWorkspaceManifests(root, ['packages', 'verticals'])));
    const entry = sources.get(handler) ?? '';
    const archive = 'archiveProjectActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),';
    expect(hasCompleteGeneratedModuleApiSeam(sources, `${owner}/shared/api.ts`)).toBe(true);
    for (const replacement of ['', `${archive}\n  ${archive}`]) {
      const invalid = new Map([...sources, [handler, entry.replace(archive, replacement)]]);
      expect(hasCompleteGeneratedModuleApiSeam(invalid, `${owner}/shared/api.ts`)).toBe(false);
    }
  }),
);

it.live('proves the actual shared runtime declaration and rejects counterfeit owner views', () =>
  Effect.gen(function* sharedRuntimeDeclaration() {
    const sources = readSources(owner, new Map(yield* readWorkspaceManifests(root, ['packages', 'verticals'])));
    const manifestFile = `${owner}/vertical.manifest.ts`;
    const registrationFile = `${owner}/vertical.registration.ts`;
    const runtimeFile = `${owner}/vertical.runtime-declaration.ts`;
    const manifest = sources.get(manifestFile) ?? '';
    const registration = sources.get(registrationFile) ?? '';
    const runtime = sources.get(runtimeFile) ?? '';
    const handlerSource = sources.get(handler) ?? '';
    const shared = `${owner}/shared/api.ts`;
    const diagnostics: string[] = [];
    expect(hasCompleteGeneratedModuleApiSeam(sources, shared, 'projects', diagnostics), diagnostics.join('\n')).toBe(
      true,
    );
    const controls: readonly (readonly [string, string])[] = [
      [
        manifestFile,
        manifest.replace(
          "from './vertical.runtime-declaration.ts'",
          "from '../foreign/vertical.runtime-declaration.ts'",
        ),
      ],
      [registrationFile, registration.replace('...projectsRuntimeDeclaration,', '...foreignDeclaration,')],
      [
        manifestFile,
        manifest.replace(
          '...projectsRuntimeManifest.publicSurface,',
          '...projectsRuntimeManifest.publicSurface, api: {},',
        ),
      ],
      [runtimeFile, runtime.replace('actions: projectsRuntimeManifest.publicSurface.actions,', 'actions: [],')],
      [
        runtimeFile,
        runtime.replace("const projectModuleKey = 'projects.core'", "const projectModuleKey = 'foreign.core'"),
      ],
      [runtimeFile, runtime.replace("from '@app/core-runtime'", "from './fake-core.ts'")],
      [
        runtimeFile,
        runtime.replace("VerticalRuntimeRegistrationInput['manifest']", "UnprovenRuntimeInput['manifest']"),
      ],
      [runtimeFile, `${runtime}\nexport const projectsRuntimeManifest = unproven;`],
      [
        handler,
        handlerSource.replace(
          "from '../vertical.runtime-declaration.ts'",
          "from '../../foreign/vertical.runtime-declaration.ts'",
        ),
      ],
      [handler, handlerSource.replaceAll('projectsBackendRegistration', 'unprovenBackendRegistration')],
    ];
    for (const [file, invalid] of controls) {
      expect(invalid).not.toBe(sources.get(file));
      expect(hasCompleteGeneratedModuleApiSeam(new Map([...sources, [file, invalid]]), shared)).toBe(false);
    }
    const missing = new Map(sources);
    missing.delete(runtimeFile);
    expect(hasCompleteGeneratedModuleApiSeam(missing, shared)).toBe(false);
  }),
);

it.live('judges the whole client aggregate of a module that publishes no package read', () =>
  Effect.gen(function* projectsAggregate() {
    const sources = readSources(owner, new Map(yield* readWorkspaceManifests(root, ['packages', 'verticals'])));
    const aggregate = `${owner}/src/api/projects-client.ts`;
    const shared = `${owner}/shared/api.ts`;
    const source = sources.get(aggregate) ?? '';
    expect(source).not.toBe('');
    for (const [appended, expected] of [
      ['export const load = (path: string) => require(path);\n', 'loads a module it does not read statically'],
      ["export * from './missing.ts';\n", 'names ./missing.ts, which is no file of the workspace'],
      ['export const = ;\n', `${aggregate}: does not parse`],
      ["export { Typo } from './archive-project-action-client.ts';\n", `${aggregate}: export Typo cannot be followed`],
    ] as const) {
      const diagnostics: string[] = [];
      expect(
        hasCompleteGeneratedModuleApiSeam(
          new Map([...sources, [aggregate, `${source}${appended}`]]),
          shared,
          'projects',
          diagnostics,
        ),
        appended,
      ).toBe(false);
      expect(diagnostics.join('\n'), appended).toContain(expected);
    }
  }),
);
