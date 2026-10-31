import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const code = 'effect-native(no-promise-shaped-port)';
const fixture = 'tools/oxlint/effect-native/tests/fixtures/no-promise-shaped-port/proof/decoded-driver.mts.fixture';
const CLIENT_FILENAME = 'client.mjs';
const EFFECT_IMPORTS = '{ Effect, Predicate, Schema }';
const EXTRA_USE = '// __EXTRA_USE__';
const MIRROR_INTERFACE = 'interface SharedClient';

it('proves imported Promise mirrors only when the module, guard, decoder and every call stay at the foreign edge', () => {
  withTemporaryWorkspace((root) => {
    const project = path.join(root, 'project');
    const scripts = path.join(project, 'scripts');
    const foreign = path.join(root, 'foreign');
    const commonGit = path.join(root, 'git');
    const linkedGit = path.join(commonGit, 'worktrees', 'linked');
    const linked = path.join(root, 'linked');
    for (const directory of [scripts, foreign, linkedGit, linked]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(path.join(project, '.git'), `gitdir: ${commonGit}\n`);
    writeFileSync(path.join(linked, '.git'), `gitdir: ${linkedGit}\n`);
    writeFileSync(path.join(linkedGit, 'commondir'), '../..\n');
    const driver = path.join(foreign, CLIENT_FILENAME);
    const local = path.join(project, CLIENT_FILENAME);
    const linkedDriver = path.join(linked, CLIENT_FILENAME);
    const wrongExport = path.join(foreign, 'other.mjs');
    const driverSource = 'export async function openTab() { return "native"; }\n';
    for (const filename of [driver, local, linkedDriver]) {
      writeFileSync(filename, driverSource);
    }
    writeFileSync(wrongExport, 'export async function other() { return "native"; }\n');
    const template = readFileSync(path.join(appRoot, fixture), 'utf-8');
    const base = template.replace('__FOREIGN_MODULE__', JSON.stringify(driver));
    const browser = readFileSync(path.join(appRoot, 'scripts/demo/mcp-oauth-e2e/browser.mts'), 'utf-8').replace(
      /const clientPath = '[^']+';/u,
      `const clientPath = ${JSON.stringify(driver)};`,
    );
    const valid = new Map([
      ['native-driver.mts', base],
      ['real-browser-reproducer.mts', browser],
      [
        'renamed-imports.mts',
        base
          .replace(EFFECT_IMPORTS, '{ Effect as E, Predicate as P, Schema as S }')
          .replaceAll('Effect.', 'E.')
          .replaceAll('Schema.', 'S.')
          .replaceAll('Predicate.', 'P.'),
      ],
    ]);
    const invalid = new Map([
      ['local-service.mts', base.replace(JSON.stringify(driver), JSON.stringify(local))],
      ['same-git-worktree.mts', base.replace(JSON.stringify(driver), JSON.stringify(linkedDriver))],
      [
        'unresolved-module.mts',
        base.replace(JSON.stringify(driver), JSON.stringify(path.join(foreign, 'missing.mjs'))),
      ],
      ['missing-export.mts', base.replace(JSON.stringify(driver), JSON.stringify(wrongExport))],
      [
        'dynamic-module.mts',
        base.replace(`const clientPath = ${JSON.stringify(driver)};`, 'const clientPath = chooseModule();'),
      ],
      ['escaping-receiver.mts', base.replace(EXTRA_USE, 'return client;')],
      ['escaping-method.mts', base.replace(EXTRA_USE, 'consume(client.openTab);')],
      ['unconverted-call.mts', base.replace(EXTRA_USE, 'client.openTab();')],
      [
        'escaping-promise.mts',
        base.replace(
          'try: async () => await client.openTab(),',
          'try: async () => { const pending = client.openTab(); publish(pending); return await pending; },',
        ),
      ],
      ['escaping-inferred-type.mts', base.replace(EXTRA_USE, 'type Escaped = typeof client;')],
      ['local-owner-type.mts', `${base}\ndeclare const localService: SharedClient;\n`],
      ['local-owner-inheritance.mts', `${base}\ninterface LocalService extends SharedClient {}\n`],
      ['exported-schema.mts', base.replace('const SharedClientSchema =', 'export const SharedClientSchema =')],
      ['wrong-guard.mts', base.replace('Predicate.isFunction(value)', 'Predicate.isString(value)')],
      [
        'schema-reuse.mts',
        `${base}\nSchema.decodeUnknownResult(SharedClientSchema)({ openTab: async () => "owned" });\n`,
      ],
      ['unused-schema.mts', base.slice(0, base.indexOf('export const open'))],
      [
        'fake-effect.mts',
        base
          .replace(EFFECT_IMPORTS, '{ Effect as RealEffect, Predicate, Schema }')
          .replace(MIRROR_INTERFACE, 'const Effect = { ...RealEffect };\ninterface SharedClient'),
      ],
      [
        'fake-schema.mts',
        base
          .replace(EFFECT_IMPORTS, '{ Effect, Predicate, Schema as RealSchema }')
          .replace(MIRROR_INTERFACE, 'const Schema = { ...RealSchema };\ninterface SharedClient'),
      ],
      [
        'fake-predicate.mts',
        base
          .replace(EFFECT_IMPORTS, '{ Effect, Predicate as RealPredicate, Schema }')
          .replace(MIRROR_INTERFACE, 'const Predicate = { ...RealPredicate };\ninterface SharedClient'),
      ],
      [
        'overridden-thunk.mts',
        base.replace(
          'try: async () => await client.openTab(),',
          'try: async () => await client.openTab(), ...otherOptions,',
        ),
      ],
    ]);
    for (const [name, source] of [...valid, ...invalid]) {
      writeFileSync(path.join(scripts, name), source);
    }
    const files = [...valid.keys(), ...invalid.keys()].map((name) => `scripts/${name}`);
    const run = runOxlint(fixtureConfigPath('no-promise-shaped-port'), files, project);
    expect(run.exitCode).toBe(1);
    expect(run.numberOfFiles).toBe(files.length);
    for (const name of valid.keys()) {
      expect(
        run.diagnostics.filter(
          (item) => item.filename.endsWith(`/scripts/${name}`) || item.filename === `scripts/${name}`,
        ),
        name,
      ).toEqual([]);
    }
    for (const [name, source] of invalid) {
      const findings = run.diagnostics.filter(
        (item) => item.filename.endsWith(`/scripts/${name}`) || item.filename === `scripts/${name}`,
      );
      const memberLine = source.split('\n').findIndex((line) => line.includes('readonly openTab:')) + 1;
      expect(findings.length, name).toBeGreaterThan(0);
      expect(
        findings.every((item) => item.code === code),
        name,
      ).toBe(true);
      expect(
        findings.some((item) => item.labels.some((label) => label.span.line === memberLine)),
        name,
      ).toBe(true);
    }
  });
});
