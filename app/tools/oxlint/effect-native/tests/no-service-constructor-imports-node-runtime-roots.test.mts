import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const bootstrapFilename = 'bootstrap.ts';
const privacyCompletionProcess = 'verticals/privacy/tests/support/privacy-completion-http.ts';
const factoryFilename = 'factory.ts';
const supportDirectory = 'tests/support';
const directRunMain = 'NodeRuntime.runMain(Effect.void);';
const lintConfig = nodePath.join(appRoot, 'oxlint.config.ts');

const ruleCode = 'anti-slop-effect(no-service-constructor-imports)';

it('requires a closed stable NodeRuntime import origin across equivalent module aliases', () => {
  withTemporaryWorkspace((directory) => {
    const owner = nodePath.join(directory, 'app/verticals/runtime-owner');
    const api = nodePath.join(owner, 'api');
    const support = nodePath.join(owner, supportDirectory);
    mkdirSync(api, { recursive: true });
    mkdirSync(support, { recursive: true });
    writeFileSync(
      nodePath.join(api, factoryFilename),
      'export const makeService = (dependency: { readonly read: () => string }) => dependency;',
    );
    const consumer = nodePath.join(support, bootstrapFilename);
    const base =
      "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; import { makeService } from '../../api/factory.ts'; void makeService;";
    const main = directRunMain;
    const findings = (extra: string) => {
      writeFileSync(consumer, `${base} ${extra} ${main}`);
      return runOxlint(lintConfig, [consumer], appRoot).diagnostics.filter(({ code }) => code === ruleCode).length;
    };
    expect(findings("import type { NodeRuntime as Other } from '@effect/platform-node';")).toBe(0);
    expect(findings("import type * as Platform from '@effect/platform-node';")).toBe(0);
    for (const extra of [
      "import { NodeRuntime as Other } from '@effect/platform-node'; Other.runMain = replacement;",
      "import { NodeRuntime as Other } from '@effect/platform-node'; void Other;",
      "import * as Platform from '@effect/platform-node'; Platform.NodeRuntime.runMain = replacement;",
      "import * as Platform from '@effect/platform-node'; const Other = Platform.NodeRuntime; void Other;",
      "import * as Other from '@effect/platform-node/NodeRuntime'; Other.runMain = replacement;",
      "import { runMain as other } from '@effect/platform-node/NodeRuntime'; void other;",
      "import Other from '@effect/platform-node/NodeRuntime'; void Other;",
      "const Other = await import('@effect/platform-node/NodeRuntime'); void Other;",
      "const Other = require('@effect/platform-node'); void Other;",
    ]) {
      expect(findings(extra), extra).toBe(1);
    }
  }, testsDirectory);
});

it('proves supported subpath test roots and closed exported controls without admitting runtime capabilities', () => {
  const actualFilename = nodePath.join(appRoot, privacyCompletionProcess);
  const actualSource = readFileSync(actualFilename, 'utf-8');
  const control = actualSource.slice(
    actualSource.indexOf('export const makeReportResponseLossControl'),
    actualSource.indexOf('// Immutable historical TEST producer'),
  );
  expect(control.startsWith('export const makeReportResponseLossControl')).toBe(true);
  expect(runOxlint(lintConfig, [actualFilename], appRoot).diagnostics.filter(({ code }) => code === ruleCode)).toEqual(
    [],
  );
  withTemporaryWorkspace((directory) => {
    const owner = nodePath.join(directory, 'app/verticals/privacy');
    const support = nodePath.join(owner, 'tests/support');
    const api = nodePath.join(owner, 'api');
    mkdirSync(support, { recursive: true });
    mkdirSync(api, { recursive: true });
    writeFileSync(
      nodePath.join(api, 'closed-runtime.ts'),
      'export const makePrivacyApiRuntime = (dependency: {readonly read:()=>string}) => dependency;',
    );
    const filename = nodePath.join(support, 'completion.ts');
    const imports =
      "import {runMain as main} from '@effect/platform-node/NodeRuntime'; import {Effect} from 'effect'; import {makePrivacyApiRuntime} from '../../api/closed-runtime.ts';";
    const assemblyCall = "makePrivacyApiRuntime({read:()=> 'fixture'});";
    const root = 'main(Effect.void);';
    const count = (source: string) => {
      writeFileSync(filename, source);
      return runOxlint(lintConfig, [filename], appRoot).diagnostics.filter(({ code }) => code === ruleCode).length;
    };
    const valid = `${imports} ${control} ${assemblyCall} ${root}`;
    expect(count(valid)).toBe(0);
    expect(
      count(
        `${valid} const startupFlag = '--legacy'; process.argv.includes(startupFlag); void process.ppid; void process.execPath; const legacy = import.meta.fixtureBuild === true;`,
      ),
    ).toBe(0);
    for (const invalid of [
      valid.replace("'@effect/platform-node/NodeRuntime'", "'foreign-runtime'"),
      valid
        .replace('runMain as main', 'runMain as acquired')
        .replace(root, 'const main = acquired; main(Effect.void);'),
      valid.replace(root, 'const launch = () => { main(Effect.void); }; launch();'),
      valid.replace(root, 'main = () => undefined; main(Effect.void);'),
      valid.replace(root, 'void main; main(Effect.void);'),
      valid.replace(control, 'export const unrelated = {};'),
      valid.replace(control, 'export default {};'),
      valid.replace(control, "export * from '../../api/closed-runtime.ts';"),
      valid.replace('let armed = false;', 'let armed = process.pid;'),
      valid.replace('let armed = false;', "let armed = makePrivacyApiRuntime({read:()=> 'bad'});"),
      valid.replace('close();', 'process.exit();'),
      valid.replace('close();', 'const callback = close; callback();'),
      valid.replace('close();', 'return close;'),
      valid.replace('close();', 'close.constructor();'),
      valid.replace(
        'observe: () => ({ armed, committedResponseStatus, discardedResponses })',
        'observe: () => process.env',
      ),
      `${valid} process.ppid = 1;`,
      `${valid} process.execPath = 'foreign';`,
      `${valid} let flag = '--legacy'; process.argv.includes(flag);`,
      `${valid} const flag = process.env.FLAG; process.argv.includes(flag);`,
      `${valid} import.meta.fixtureBuild();`,
      `${valid} const metadata = import.meta;`,
      `${valid} import.meta.fixtureBuild = true;`,
    ]) {
      expect(count(invalid), invalid).toBe(1);
    }
    const runtimeFile = nodePath.join(owner, 'src/runtime.ts');
    mkdirSync(nodePath.dirname(runtimeFile), { recursive: true });
    writeFileSync(runtimeFile, valid);
    expect(
      runOxlint(lintConfig, [runtimeFile], appRoot).diagnostics.filter(({ code }) => code === ruleCode),
    ).toHaveLength(1);
    const foreignImport = valid.replace("'../../api/closed-runtime.ts'", "'../../../other/api/closed-runtime.ts'");
    const other = nodePath.join(directory, 'app/verticals/other/api');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      nodePath.join(other, 'closed-runtime.ts'),
      'export const makePrivacyApiRuntime = (dependency: {readonly read:()=>string}) => dependency;',
    );
    expect(count(foreignImport)).toBe(1);
  }, testsDirectory);
});
