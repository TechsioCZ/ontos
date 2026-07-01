// @effect-diagnostics asyncFunction:off globalDate:off nodeBuiltinImport:off globalConsole:off
import { and, eq } from 'drizzle-orm';
import {
  installedModuleKeys,
  isInstalledModuleKey,
  isModuleActivationState,
  isModuleStateAccessAllowed,
} from '@mvp2/shared-contracts';
import type {
  InstalledModuleKey,
  ModuleActivationState,
  ModuleStateAccessKind,
  TenantModuleState,
} from '@mvp2/shared-contracts';
import { db } from './db/client.ts';
import { auditEvents, tenantModuleStateChanges, tenantModuleStates } from './db/schema.ts';
import type { CoreDbExecutor } from './db/types.ts';
import {
  createTenantScopedSpiceDbPermissionCheck,
  type SpiceDbAuthorizationChecker,
  type SpiceDbPermissionCheckInput,
  spiceDbAuthorizationChecker,
} from './spicedb-authorization.ts';

export const coreModulesResourceObjectType = 'core_modules';
export const coreModulesResourceObjectId = 'core.modules';

export type ModuleStateAdminPermission = 'view' | 'change';

export type ModuleStateAccessDecision =
  | {
      readonly _tag: 'Allowed';
      readonly accessKind: ModuleStateAccessKind;
      readonly moduleKey: InstalledModuleKey;
      readonly state: ModuleActivationState;
    }
  | {
      readonly _tag: 'Denied';
      readonly accessKind: ModuleStateAccessKind;
      readonly moduleKey: InstalledModuleKey;
      readonly outcomeCode:
        | 'module_state_load_blocked'
        | 'module_state_read_blocked'
        | 'module_state_mutate_blocked';
      readonly state: ModuleActivationState;
    };

export interface TenantModuleStateChange {
  readonly actionInvocationId?: string;
  readonly changeSource?: 'user' | 'support' | 'system';
  readonly changedByPrincipalId?: string;
  readonly moduleKey: InstalledModuleKey;
  readonly newState: ModuleActivationState;
  readonly reason?: string;
  readonly tenantId: string;
}

const moduleStateRowsToMap = (
  rows: readonly {
    readonly moduleKey: string;
    readonly state: string;
  }[],
) => {
  const map = new Map<InstalledModuleKey, ModuleActivationState>();

  for (const row of rows) {
    if (isInstalledModuleKey(row.moduleKey) && isModuleActivationState(row.state)) {
      map.set(row.moduleKey, row.state);
    }
  }

  return map;
};

export const listTenantModuleStates = async (
  tenantId: string,
  executor: CoreDbExecutor = db,
): Promise<readonly TenantModuleState[]> => {
  const rows = await executor
    .select({
      moduleKey: tenantModuleStates.moduleKey,
      state: tenantModuleStates.state,
    })
    .from(tenantModuleStates)
    .where(eq(tenantModuleStates.tenantId, tenantId));
  const persisted = moduleStateRowsToMap(rows);

  return installedModuleKeys.map((moduleKey) => ({
    moduleKey,
    state: persisted.get(moduleKey) ?? 'inactive',
  }));
};

export const resolveTenantModuleState = async ({
  executor = db,
  moduleKey,
  tenantId,
}: {
  readonly executor?: CoreDbExecutor;
  readonly moduleKey: InstalledModuleKey;
  readonly tenantId: string;
}): Promise<ModuleActivationState> => {
  const [row] = await executor
    .select({
      state: tenantModuleStates.state,
    })
    .from(tenantModuleStates)
    .where(
      and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.moduleKey, moduleKey)),
    )
    .limit(1);

  return row !== undefined && isModuleActivationState(row.state) ? row.state : 'inactive';
};

export const checkModuleStateAccess = async ({
  accessKind,
  moduleKey,
  tenantId,
}: {
  readonly accessKind: ModuleStateAccessKind;
  readonly moduleKey: InstalledModuleKey;
  readonly tenantId: string;
}): Promise<ModuleStateAccessDecision> => {
  const state = await resolveTenantModuleState({ moduleKey, tenantId });

  if (isModuleStateAccessAllowed({ accessKind, state })) {
    return {
      _tag: 'Allowed',
      accessKind,
      moduleKey,
      state,
    };
  }

  return {
    _tag: 'Denied',
    accessKind,
    moduleKey,
    outcomeCode: `module_state_${accessKind}_blocked`,
    state,
  };
};

export const toCoreModulesSpiceDbPermissionCheck = ({
  permission,
  principalId,
  tenantId,
}: {
  readonly permission: ModuleStateAdminPermission;
  readonly principalId: string;
  readonly tenantId: string;
}): SpiceDbPermissionCheckInput =>
  createTenantScopedSpiceDbPermissionCheck({
    permission,
    principalId,
    resourceObjectId: coreModulesResourceObjectId,
    resourceObjectType: coreModulesResourceObjectType,
    tenantId,
  });

export const checkModuleStateAdminCapability = async ({
  authorizationChecker = spiceDbAuthorizationChecker,
  permission,
  principalId,
  tenantId,
}: {
  readonly authorizationChecker?: SpiceDbAuthorizationChecker;
  readonly permission: ModuleStateAdminPermission;
  readonly principalId: string;
  readonly tenantId: string;
}) => {
  const decision = await authorizationChecker(
    toCoreModulesSpiceDbPermissionCheck({
      permission,
      principalId,
      tenantId,
    }),
  );

  return decision._tag === 'Allowed';
};

export const setTenantModuleState = ({
  changeSource = 'user',
  changedByPrincipalId,
  actionInvocationId,
  moduleKey,
  newState,
  reason,
  tenantId,
}: TenantModuleStateChange) =>
  db.transaction(async (tx) => {
    const previousState = await resolveTenantModuleState({
      executor: tx,
      moduleKey,
      tenantId,
    });
    const [change] = await tx
      .insert(tenantModuleStateChanges)
      .values({
        ...(actionInvocationId === undefined ? {} : { actionInvocationId }),
        changeSource,
        ...(changedByPrincipalId === undefined ? {} : { changedByPrincipalId }),
        moduleKey,
        newState,
        previousState,
        ...(reason === undefined ? {} : { reason }),
        tenantId,
      })
      .returning({
        moduleStateChangeId: tenantModuleStateChanges.moduleStateChangeId,
      });

    if (change === undefined) {
      throw new Error('Could not persist tenant module state change.');
    }

    const now = new Date();

    await tx
      .insert(tenantModuleStates)
      .values({
        createdAt: now,
        lastChangeId: change.moduleStateChangeId,
        moduleKey,
        state: newState,
        tenantId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          lastChangeId: change.moduleStateChangeId,
          state: newState,
          updatedAt: now,
        },
        target: [tenantModuleStates.tenantId, tenantModuleStates.moduleKey],
      });

    await tx.insert(auditEvents).values({
      ...(actionInvocationId === undefined ? {} : { actionInvocationId }),
      auditProfile: 'sensitive',
      authMethod: changeSource === 'system' ? 'system' : 'session',
      eventType: 'core.modules.state.changed',
      evidenceJson: {
        changeId: change.moduleStateChangeId,
        moduleKey,
        newState,
        previousState,
        ...(reason === undefined ? {} : { reason }),
      },
      outcome: 'succeeded',
      outcomeCode: 'module_state_changed',
      outcomeStage: 'execution',
      ...(changedByPrincipalId === undefined ? {} : { principalId: changedByPrincipalId }),
      targetModuleKey: moduleKey,
      tenantId,
    });

    console.info(
      JSON.stringify({
        changeSource,
        changedByPrincipalId,
        moduleKey,
        newState,
        previousState,
        reason,
        tenantId,
        type: 'module_state.changed',
      }),
    );

    return {
      changeId: change.moduleStateChangeId,
      moduleKey,
      previousState,
      state: newState,
    };
  });
