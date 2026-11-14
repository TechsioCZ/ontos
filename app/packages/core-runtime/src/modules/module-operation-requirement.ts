/** Check the current real operation's owner-authored requirement; never returns a grant or fact. */
export { requireExecutingModuleOperation as requireModuleOperation } from './module-operation-execution.ts';

export { readModuleOperationRequirement } from './module-operation-execution.ts';
export type { ModuleOperationRequirementFact } from './module-operation-execution.ts';

export { readWorkerModuleOperationRequirement } from './module-operation-execution.ts';
export type { WorkerModuleOperationRequirementFact } from './module-operation-execution.ts';
