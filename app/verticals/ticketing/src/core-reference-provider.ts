// @effect-diagnostics asyncFunction:off
import {
  createTenantScopedSpiceDbPermissionCheck,
  registerCoreReferenceProvider,
  spiceDbAuthorizationChecker,
} from '@app/core-runtime';
import type {
  CoreReferenceProvider,
  CoreReferenceProviderCandidate,
  CoreReferenceProviderTarget,
  CoreReferenceSource,
} from '@app/core-runtime';
import { sqlClient } from '@app/core-runtime/db/client';

interface TaskReferenceRow {
  readonly collection_id: string;
  readonly core_reference_token: string;
  readonly task_id: string;
  readonly tenant_id: string;
  readonly title: string;
}

interface TicketingOpenRequest {
  readonly collectionId: string;
  readonly taskId: string;
  readonly tenantId: string;
}

const labelForTask = (row: TaskReferenceRow): string => row.title.trim() || 'Untitled task';

const candidateForTask = (row: TaskReferenceRow): CoreReferenceProviderCandidate => ({
  entityId: row.task_id,
  entityType: 'task',
  label: labelForTask(row),
  targetTenantId: row.tenant_id,
  token: row.core_reference_token,
});

const targetForTask = (row: TaskReferenceRow): CoreReferenceProviderTarget => ({
  ...candidateForTask(row),
  openRequest: {
    collectionId: row.collection_id,
    taskId: row.task_id,
    tenantId: row.tenant_id,
  } satisfies TicketingOpenRequest,
});

const tokenFromSource = (source: CoreReferenceSource): string | undefined => {
  if (source.type === 'opaqueToken') {
    return source.value;
  }
  let pathname: string;
  try {
    ({ pathname } = new URL(source.value, 'https://ontos.invalid'));
  } catch {
    return undefined;
  }
  const match = /^\/ticketing\/core-references\/(?<token>[^/]+)$/u.exec(pathname);
  return match?.groups?.['token'];
};

const taskByToken = async (token: string): Promise<TaskReferenceRow | undefined> => {
  const [row] = await sqlClient<TaskReferenceRow[]>`
    select
      task.collection_id,
      task.core_reference_token,
      task.task_id,
      task.tenant_id,
      task.title
    from ticketing.tasks as task
    inner join core.tenant_module_states as module_state
      on module_state.tenant_id = task.tenant_id
      and module_state.module_key = 'ticketing'
      and module_state.state = 'active'
    where task.core_reference_token = ${token}
      and task.retention_state <> 'soft_deleted'
  `;
  return row;
};

const isTicketingOpenRequest = (value: unknown): value is TicketingOpenRequest =>
  typeof value === 'object' &&
  value !== null &&
  'collectionId' in value &&
  typeof value.collectionId === 'string' &&
  'taskId' in value &&
  typeof value.taskId === 'string' &&
  'tenantId' in value &&
  typeof value.tenantId === 'string';

export const ticketingCoreReferenceProvider: CoreReferenceProvider = {
  authorizeOpen: async ({ context, openRequest }) => {
    if (!isTicketingOpenRequest(openRequest)) {
      return false;
    }
    const decision = await spiceDbAuthorizationChecker(
      createTenantScopedSpiceDbPermissionCheck({
        permission: 'view_task_properties',
        principalId: context.principalId,
        resourceObjectId: openRequest.collectionId,
        resourceObjectType: 'task_collection',
        tenantId: openRequest.tenantId,
      }),
    );
    return decision._tag === 'Allowed';
  },
  discover: async ({ context, query }) => {
    const normalizedQuery = `%${query.trim()}%`;
    const rows = await sqlClient<TaskReferenceRow[]>`
      select
        task.collection_id,
        task.core_reference_token,
        task.task_id,
        task.tenant_id,
        task.title
      from ticketing.tasks as task
      inner join core.tenant_module_states as module_state
        on module_state.tenant_id = task.tenant_id
        and module_state.module_key = 'ticketing'
        and module_state.state = 'active'
      where task.tenant_id = ${context.tenantId}
        and task.retention_state <> 'soft_deleted'
        and task.title ilike ${normalizedQuery}
      order by task.title, task.task_id
      limit 20
    `;
    return rows.map(candidateForTask);
  },
  moduleKey: 'ticketing',
  open: ({ openRequest }) =>
    isTicketingOpenRequest(openRequest)
      ? {
          href: `/ticketing?collectionId=${encodeURIComponent(openRequest.collectionId)}&taskId=${encodeURIComponent(openRequest.taskId)}`,
        }
      : undefined,
  recognize: async ({ source }) => {
    const token = tokenFromSource(source);
    if (token === undefined) {
      return null;
    }
    const row = await taskByToken(token);
    return row === undefined ? null : candidateForTask(row);
  },
  resolve: async ({ reference }) => {
    const row = await taskByToken(reference.token);
    return row === undefined ||
      row.task_id !== reference.entityId ||
      row.tenant_id !== reference.targetTenantId ||
      reference.entityType !== 'task'
      ? null
      : targetForTask(row);
  },
};

let unregisterTicketingProvider: (() => void) | undefined;

export const ensureTicketingCoreReferenceProviderRegistered = (): void => {
  unregisterTicketingProvider ??= registerCoreReferenceProvider(ticketingCoreReferenceProvider);
};
