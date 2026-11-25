import { Result, Schema } from 'effect';

import { WorkloadKeySchema } from '../authorization/access-declaration.ts';
import { systemWorkloadKeyIssue } from '../auth/system-workload-registration.ts';
import { OntosModuleIdSchema } from './manifest.ts';

/*
 * The system modules Core itself runs and the system workloads each runs as. An app module declares its system
 * workloads in its published manifest (`systemWorkloads`) and is enrolled against its installed contract; a core module
 * has no installed contract and no Tenant module state, because it is part of Core and always active. This declaration
 * is the one place Core says which keys such a module may be enrolled for
 * (`core.identity.change-system-workload-enrollment`), and the module-contract check holds every `registerSystemWorkload`
 * in the Shell's own source to it. A core module's worker identity is its workload key alone: it declares no registered
 * workload calls.
 *
 * One owner per key and per module id: the installed module catalog refuses a deployment whose module id is a core
 * module's, or that declares a key listed here.
 */

/** The declaration of Core's own system modules is not valid: it never loads, so no enrollment reads a broken one. */
export class CoreSystemModulesInvalidError extends Schema.TaggedError<CoreSystemModulesInvalidError>()(
  'CoreSystemModulesInvalidError',
  { code: Schema.Literal('core_system_modules_invalid'), reason: Schema.String },
) {}

export interface CoreSystemModuleDeclaration {
  readonly moduleId: string;
  readonly systemWorkloads: readonly string[];
}

// Both schemas decode to a plain string, so the pattern is checked by decoding, never by `Schema.is`.
const isModuleId = (value: string) => Result.isSuccess(Schema.decodeUnknownResult(OntosModuleIdSchema)(value));
const isWorkloadKey = (value: string) => Result.isSuccess(Schema.decodeUnknownResult(WorkloadKeySchema)(value));

/** The first reason a declaration is not valid, or none: ids and keys are well formed, owned once, and rule-abiding. */
export const coreSystemModulesIssue = (declarations: readonly CoreSystemModuleDeclaration[]): string | undefined => {
  const moduleIds = new Set<string>();
  const keys = new Set<string>();
  for (const { moduleId, systemWorkloads } of declarations) {
    if (!isModuleId(moduleId)) {
      return `core system module id ${moduleId} is not a valid module id`;
    }
    if (moduleIds.has(moduleId)) {
      return `core system module ${moduleId} is declared more than once`;
    }
    moduleIds.add(moduleId);
    for (const key of systemWorkloads) {
      if (!isWorkloadKey(key)) {
        return `core system workload key ${key} is not a valid workload key`;
      }
      const issue = systemWorkloadKeyIssue(key, moduleId);
      if (issue !== undefined) {
        return issue;
      }
      if (keys.has(key)) {
        return `core system workload ${key} is declared more than once`;
      }
      keys.add(key);
    }
  }
  return undefined;
};

/** The declaration, validated and deeply frozen; an invalid one never loads. */
export const defineCoreSystemModules = (
  declarations: readonly CoreSystemModuleDeclaration[],
): readonly CoreSystemModuleDeclaration[] => {
  const issue = coreSystemModulesIssue(declarations);
  if (issue !== undefined) {
    throw new CoreSystemModulesInvalidError({ code: 'core_system_modules_invalid', reason: issue });
  }
  return Object.freeze(
    declarations.map(({ moduleId, systemWorkloads }) =>
      Object.freeze({ moduleId, systemWorkloads: Object.freeze([...systemWorkloads]) }),
    ),
  );
};

export const coreSystemModuleDeclarations = defineCoreSystemModules([
  { moduleId: 'core.media', systemWorkloads: ['core.media.integrity'] },
]);

export const isCoreSystemModule = (moduleId: string): boolean =>
  coreSystemModuleDeclarations.some((declaration) => declaration.moduleId === moduleId);

export const declaresCoreSystemWorkload = (moduleId: string, workloadKey: string): boolean =>
  coreSystemModuleDeclarations.some(
    (declaration) => declaration.moduleId === moduleId && declaration.systemWorkloads.includes(workloadKey),
  );

/** Every key some core module declares: no installed module may declare one of them. */
export const coreSystemWorkloadKeys: ReadonlySet<string> = new Set(
  coreSystemModuleDeclarations.flatMap((declaration) => declaration.systemWorkloads),
);

/**
 * How an enrollment names its module: a key a core module declares (`declared`), a key under a core module that the
 * declaration does not list (`undeclared`, refused), or a module that is not a core one (`not-core`, resolved from the
 * installed catalog).
 */
export const coreSystemWorkloadTargetOf = (
  moduleId: string,
  workloadKey: string,
): 'declared' | 'not-core' | 'undeclared' => {
  if (!isCoreSystemModule(moduleId)) {
    return 'not-core';
  }
  return declaresCoreSystemWorkload(moduleId, workloadKey) ? 'declared' : 'undeclared';
};
