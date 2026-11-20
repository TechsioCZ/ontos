import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { registeredSystemWorkloadKeys, systemWorkloadRegistrationIssues } from '../system-workload-registrations.mts';

const appRoot = path.resolve(import.meta.dirname, '../..');
const symmyIdentity = 'src/services/symmy-worker-identity.service.ts';
const jobKey = 'integration.symmy.execute-symmy-job';
const otherJob = 'integration.symmy.job';
const importsRegistration = "import { registerSystemWorkload } from '@app/core-runtime';\n";
const importsNamespace = "import * as core from '@app/core-runtime';\n";
const notACall = 'other than by a direct call';
const unreadKey = 'whose jobKey is not';
const issuesOf = (declared: readonly string[], ...contents: readonly string[]) =>
  systemWorkloadRegistrationIssues({
    appId: 'symmy-integration',
    declared,
    files: contents.map((content, index) => ({ content, path: `src/file-${String(index)}.ts` })),
  });
const reports = (issues: readonly string[], fragment: string) => issues.some((issue) => issue.includes(fragment));
const unregistered = (key: string) =>
  `symmy-integration manifest declares system workload ${key}, which no source of the module registers`;

it.layer(NodeServices.layer)('the system workload registration reading', (suite) => {
  suite.effect('reads the system workload the Symmy worker registers, which its manifest declares', () =>
    Effect.gen(function* readsSymmy() {
      const fileSystem = yield* FileSystem.FileSystem;
      const content = yield* fileSystem.readFileString(
        path.join(appRoot, 'verticals/symmy-integration', symmyIdentity),
      );
      expect(registeredSystemWorkloadKeys({ content, path: symmyIdentity })).toEqual({ issues: [], keys: [jobKey] });
      expect(
        systemWorkloadRegistrationIssues({
          appId: 'symmy-integration',
          declared: [jobKey],
          files: [{ content, path: symmyIdentity }],
        }),
      ).toEqual([]);
    }),
  );
});

it('compares both ways: an undeclared registration and a declared key no source registers', () => {
  const registers = `${importsRegistration}export const registration = registerSystemWorkload({ jobKey: '${jobKey}' });`;
  expect(issuesOf([jobKey], registers)).toEqual([]);
  expect(issuesOf([], registers)).toEqual([
    `symmy-integration src/file-0.ts registers system workload ${jobKey}, which its manifest does not declare in systemWorkloads`,
  ]);
  expect(issuesOf([jobKey])).toEqual([unregistered(jobKey)]);
  // A file that only names the function in a comment registers nothing.
  expect(issuesOf([jobKey], '// registerSystemWorkload is called by the worker identity')).toEqual([
    unregistered(jobKey),
  ]);
});

it('follows the import binding: an aliased import and a namespace import register like the plain one', () => {
  const aliased = `import { registerSystemWorkload as register } from '@app/core-runtime';
const key = 'integration.symmy.aliased-job';
export const registration = register({ jobKey: key });`;
  expect(issuesOf(['integration.symmy.aliased-job'], aliased)).toEqual([]);
  expect(issuesOf([], aliased)).toEqual([
    'symmy-integration src/file-0.ts registers system workload integration.symmy.aliased-job, which its manifest does not declare in systemWorkloads',
  ]);
  const namespaced = `${importsNamespace}export const make = () => core.registerSystemWorkload({ jobKey: \`integration.symmy.nested-job\` });`;
  expect(issuesOf(['integration.symmy.nested-job'], namespaced)).toEqual([]);
  expect(issuesOf([], namespaced)).toHaveLength(1);
});

it('fails closed on every use whose key it cannot read', () => {
  for (const [source, issue] of [
    [`let key = "${otherJob}";\nregisterSystemWorkload({ jobKey: key });`, unreadKey],
    [`const key = "${otherJob}";\nconst read = (key: string) => registerSystemWorkload({ jobKey: key });`, unreadKey],
    ['registerSystemWorkload({ jobKey: makeKey() });', unreadKey],
    [`registerSystemWorkload({ ...base, jobKey: "${otherJob}" });`, unreadKey],
    ['registerSystemWorkload(options);', unreadKey],
    [`const register = registerSystemWorkload;\nregister({ jobKey: "${otherJob}" });`, notACall],
    ['export { registerSystemWorkload };', notACall],
  ] as const) {
    expect(reports(issuesOf([otherJob], importsRegistration + source), issue)).toBe(true);
  }
  expect(
    reports(issuesOf([], "export { registerSystemWorkload as register } from '@app/core-runtime';"), notACall),
  ).toBe(true);
  expect(reports(issuesOf([], `${importsNamespace}const { registerSystemWorkload: register } = core;`), notACall)).toBe(
    true,
  );
  expect(
    reports(issuesOf([], `${importsNamespace}core['registerSystemWorkload']({ jobKey: "${otherJob}" });`), notACall),
  ).toBe(true);
});
