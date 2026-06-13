// @effect-diagnostics strictBooleanExpressions:off
import type { RuntimeContext, RuntimeModuleState, SerializableGateResult } from './types.ts';

const writableStates = new Set(['active']);
type ModuleWriteStateDecision =
  | Extract<SerializableGateResult, { ok: false }>
  | { ok: true; moduleState: RuntimeModuleState };

export const findRuntimeModuleState = (
  context: RuntimeContext,
  moduleKey: string,
): RuntimeModuleState | null =>
  context.moduleStates.find((moduleState) => moduleState.moduleKey === moduleKey) ?? null;

export const checkModuleWriteState = (
  context: RuntimeContext,
  moduleKey: string,
): ModuleWriteStateDecision => {
  const moduleState = findRuntimeModuleState(context, moduleKey);

  if (moduleState === null) {
    return {
      authorization: 'unavailable',
      code: 'module_not_writable',
      message: `Module '${moduleKey}' has no persisted tenant module state.`,
      moduleKey,
      ok: false,
      principalId: context.principal.principalId,
      tenantSlug: context.tenant.slug,
    };
  }

  if (!writableStates.has(moduleState.state)) {
    return {
      authorization: 'unavailable',
      code: 'module_not_writable',
      message: `Module '${moduleKey}' is '${moduleState.state}', so writes are blocked.`,
      moduleKey,
      moduleState: moduleState.state,
      ok: false,
      principalId: context.principal.principalId,
      tenantSlug: context.tenant.slug,
    };
  }

  return {
    moduleState,
    ok: true,
  };
};
