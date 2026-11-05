import { Effect } from 'effect';

import type {
  ListAccessRoleTemplatesResponse,
  ListAccessRolesResponse,
} from '../../../../../shared/access-admin-api.ts';
import { listAccessRoles, listAccessRoleTemplates } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { roleErrorStatus } from '../../../access-admin/role-editor/role-commands.ts';
import { shellAuthenticationClientOptionsFromRequest } from '../../../shell-authentication-client-options.ts';
import { loadHomePageModel } from '../../home-page-model.ts';
import type { HomePageModel } from '../../home-page-model.ts';

export type RolePageModel = { readonly shell: HomePageModel } & (
  | {
      readonly catalog: ListAccessRoleTemplatesResponse;
      readonly roles: ListAccessRolesResponse;
      readonly state: 'ready';
    }
  | { readonly state: ReturnType<typeof roleErrorStatus> | 'reload_required' }
);

/** Tenant authentication is sufficient to ask the governed BFF. No company-selection prerequisite. */
export const loadRolePageModel = (request: Request): Effect.Effect<RolePageModel> =>
  loadHomePageModel(request).pipe(
    Effect.flatMap((shell) => {
      if (shell.state !== 'authenticated') {
        return Effect.succeed<RolePageModel>({
          shell,
          state: shell.state === 'anonymous' ? 'unauthenticated' : shell.state,
        });
      }
      return shellAuthenticationClientOptionsFromRequest(request).pipe(
        Effect.flatMap((options) =>
          Effect.all(
            {
              catalog: listAccessRoleTemplates({ limit: 100 }, options),
              roles: listAccessRoles({ limit: 100 }, options),
            },
            { concurrency: 2 },
          ),
        ),
        Effect.match({
          onFailure: (error): RolePageModel => ({ shell, state: roleErrorStatus(error) }),
          onSuccess: ({ catalog, roles }): RolePageModel => ({ catalog, roles, shell, state: 'ready' }),
        }),
      );
    }),
  );
export const loader = ({ request }: { readonly request: Request }): Promise<RolePageModel> =>
  browserRuntime.runPromise(loadRolePageModel(request), { signal: request.signal });
