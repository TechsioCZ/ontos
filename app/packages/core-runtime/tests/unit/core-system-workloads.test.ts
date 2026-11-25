import { expect, it } from 'effect-rstest';

import { systemWorkloadKeyIssue } from '../../src/auth/system-workload-registration.ts';
import {
  CoreSystemModulesInvalidError,
  coreSystemModuleDeclarations,
  coreSystemModulesIssue,
  coreSystemWorkloadTargetOf,
  declaresCoreSystemWorkload,
  defineCoreSystemModules,
  isCoreSystemModule,
} from '../../src/modules/core-system-workloads.ts';

const refusedDefinition = () => {
  try {
    return defineCoreSystemModules([{ moduleId: 'core.media', systemWorkloads: ['other.integrity'] }]);
  } catch (error) {
    return error;
  }
};

/*
 * The core-owned system workloads: the system modules Core itself runs, which have no installed module contract and no
 * Tenant module state, so a Tenant administrator enrolls their system Principal against this declaration alone.
 */
it('declares core.media with the one system workload its integrity recorder runs as', () => {
  expect(coreSystemModuleDeclarations).toEqual([{ moduleId: 'core.media', systemWorkloads: ['core.media.integrity'] }]);
  expect(Object.isFrozen(coreSystemModuleDeclarations)).toBe(true);
  for (const declaration of coreSystemModuleDeclarations) {
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.systemWorkloads)).toBe(true);
    // The same rule an app manifest's keys are held to: the key starts with the module's own id and a dot.
    for (const key of declaration.systemWorkloads) {
      expect(systemWorkloadKeyIssue(key, declaration.moduleId)).toBeUndefined();
    }
  }
  expect(coreSystemModulesIssue(coreSystemModuleDeclarations)).toBeUndefined();
});

it('refuses a declaration that breaks the key rule, repeats a key or a module, or names an invalid id or key', () => {
  const media = { moduleId: 'core.media', systemWorkloads: ['core.media.integrity'] };
  expect(coreSystemModulesIssue([media])).toBeUndefined();
  expect(coreSystemModulesIssue([{ moduleId: 'core.media', systemWorkloads: ['core.other.integrity'] }])).toMatch(
    /must start with core\.media\./u,
  );
  expect(coreSystemModulesIssue([{ moduleId: 'core.media', systemWorkloads: ['core.media-integrity'] }])).toMatch(
    /must start with core\.media\./u,
  );
  expect(
    coreSystemModulesIssue([
      { moduleId: 'core.media', systemWorkloads: ['core.media.integrity', 'core.media.integrity'] },
    ]),
  ).toMatch(/more than once/u);
  expect(coreSystemModulesIssue([media, { moduleId: 'core.media', systemWorkloads: ['core.media.other'] }])).toMatch(
    /more than once/u,
  );
  // Nested ids can both pass the prefix rule for one key; the key still has one owner.
  expect(
    coreSystemModulesIssue([
      media,
      { moduleId: 'core.media.archive', systemWorkloads: ['core.media.archive.run'] },
      { moduleId: 'core.media.archive.run', systemWorkloads: ['core.media.archive.run.x'] },
    ]),
  ).toBeUndefined();
  expect(coreSystemModulesIssue([{ moduleId: 'Core Media', systemWorkloads: [] }])).toMatch(/module id/u);
  expect(coreSystemModulesIssue([{ moduleId: 'core.media', systemWorkloads: ['core.media.Not Valid'] }])).toMatch(
    /workload key/u,
  );
  const refused = refusedDefinition();
  expect(refused).toBeInstanceOf(CoreSystemModulesInvalidError);
  expect(refused).toMatchObject({ reason: 'system workload other.integrity must start with core.media.' });
  const defined = defineCoreSystemModules([media]);
  expect(defined).toEqual([media]);
  expect(Object.isFrozen(defined)).toBe(true);
});

it('names the core modules and the keys they declare, and nothing else', () => {
  expect(isCoreSystemModule('core.media')).toBe(true);
  expect(isCoreSystemModule('core.identity')).toBe(false);
  expect(isCoreSystemModule('integration.symmy')).toBe(false);
  expect(declaresCoreSystemWorkload('core.media', 'core.media.integrity')).toBe(true);
  expect(declaresCoreSystemWorkload('core.media', 'core.media.other')).toBe(false);
  expect(declaresCoreSystemWorkload('integration.symmy', 'core.media.integrity')).toBe(false);
});

it('resolves an enrollment target: a declared core key, an unlisted key under a core module, and a foreign module', () => {
  expect(coreSystemWorkloadTargetOf('core.media', 'core.media.integrity')).toBe('declared');
  // A key under a core module the declaration does not list is refused, like a foreign key.
  expect(coreSystemWorkloadTargetOf('core.media', 'core.media.other')).toBe('undeclared');
  // A module that is not a core module is resolved from the installed catalog, never from this declaration.
  expect(coreSystemWorkloadTargetOf('integration.symmy', 'integration.symmy.execute-symmy-job')).toBe('not-core');
  expect(coreSystemWorkloadTargetOf('integration.symmy', 'core.media.integrity')).toBe('not-core');
});
