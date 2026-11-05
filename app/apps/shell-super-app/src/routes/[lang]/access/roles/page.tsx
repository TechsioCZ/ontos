import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData, useRouter } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Match } from 'effect';
import type { Cause } from 'effect';
import { useState } from 'react';

import type { ListAccessRolesResponse } from '../../../../../shared/access-admin-api.ts';
import { listAccessRoles } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { CreateRoleFeature } from '../../../access-admin/role-editor/create-role-feature.tsx';
import { RoleEditorFeature } from '../../../access-admin/role-editor/role-editor-feature.tsx';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import { roleErrorStatus } from '../../../access-admin/role-editor/role-commands.ts';
import type { RolePageModel } from './role-page-model.ts';

/** Re-reads the route loader instead of reloading the page; both failures leave the scope unavailable. */
const invalidateRoles = (router: ReturnType<typeof useRouter>) =>
  Effect.tryPromise(() => router.invalidate({ sync: true })).pipe(Effect.timeout('30 seconds'));

const refreshFailureStatus = (error: Cause.UnknownError | Cause.TimeoutError) =>
  Match.value(error).pipe(
    Match.tag('UnknownError', 'TimeoutError', () => 'unavailable' as const),
    Match.exhaustive,
  );

const mergeRoles = (
  current: ListAccessRolesResponse['items'],
  incoming: ListAccessRolesResponse['items'],
): ListAccessRolesResponse['items'] => {
  const roles = new Map(current.map((role) => [role.id, role]));
  for (const role of incoming) {
    roles.set(role.id, role);
  }
  return [...roles.values()];
};

const ReadyRoles = ({ model }: { readonly model: Extract<RolePageModel, { readonly state: 'ready' }> }) => {
  const { language, t } = useModernI18n();
  const router = useRouter();
  const [extraRoles, setExtraRoles] = useState<ListAccessRolesResponse['items']>([]);
  const [cursor, setCursor] = useState<string | null>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped on every refresh, so the editor remounts against the revision the loader re-read.
  const [generation, setGeneration] = useState(0);
  const roles = {
    items: mergeRoles(model.roles.items, extraRoles),
    nextCursor: cursor === undefined ? model.roles.nextCursor : cursor,
  };
  const selected = roles.items.find((role) => role.id === selectedId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const acceptRole = (role: ListAccessRolesResponse['items'][number]) => {
    setExtraRoles((current) => mergeRoles(current, [role]));
    setSelectedId(role.id);
  };
  const acceptPage = (page: ListAccessRolesResponse) => {
    setExtraRoles((current) => mergeRoles(current, page.items));
    setCursor(page.nextCursor);
  };
  // A role another administrator replaced is re-read through the route loader, not a page reload. The
  // roles cached from saves and later pages are dropped, so they cannot shadow the re-read revisions.
  const refresh = () => {
    setError(undefined);
    void browserRuntime.runPromise(
      invalidateRoles(router).pipe(
        Effect.match({
          onFailure: (failure) => setError(refreshFailureStatus(failure)),
          onSuccess: () => {
            setExtraRoles([]);
            setCursor(undefined);
            setGeneration((current) => current + 1);
            setError(undefined);
          },
        }),
      ),
    );
  };
  const loadMore = () => {
    if (pending || roles.nextCursor === null) {
      return;
    }
    setPending(true);
    setError(undefined);
    void browserRuntime.runPromise(
      listAccessRoles({ cursor: roles.nextCursor, limit: 100 }, { locale: language }).pipe(
        Effect.match({
          onFailure: (failure) => setError(roleErrorStatus(failure)),
          onSuccess: acceptPage,
        }),
        Effect.ensuring(Effect.sync(() => setPending(false))),
      ),
    );
  };
  return (
    <div className="shell:grid shell:gap-6">
      <p>{t('shell.accessAdmin.role.description')}</p>
      <CreateRoleFeature
        catalog={model.catalog}
        onCreated={acceptRole}
        writesAvailable={model.catalog.createAvailable}
      />
      <nav aria-label={t('shell.accessAdmin.accessible.roleList')} className="shell:flex shell:flex-wrap shell:gap-2">
        {roles.items.map((role) => (
          <Button
            aria-pressed={selected?.id === role.id}
            key={role.id}
            onClick={() => setSelectedId(role.id)}
            type="button"
            variant="secondary"
          >
            {role.name}
          </Button>
        ))}
      </nav>
      {roles.items.length === 0 ? <StatusText>{t('shell.accessAdmin.role.empty')}</StatusText> : null}
      {error === undefined ? null : (
        <StatusText aria-live="polite" status="error">
          {t(`shell.accessAdmin.common.${error === 'invalid' ? 'failed' : error}`)}
        </StatusText>
      )}
      {roles.nextCursor === null ? null : (
        <Button disabled={pending} isLoading={pending} onClick={loadMore} type="button">
          {t('shell.accessAdmin.role.loadMore')}
        </Button>
      )}
      {selected === undefined ? (
        <p>{t('shell.accessAdmin.role.chooseRole')}</p>
      ) : (
        <RoleEditorFeature
          catalog={model.catalog}
          initialRole={selected}
          key={`${selected.id}:${generation}`}
          onRefresh={refresh}
          onSaved={acceptRole}
          writesAvailable={model.catalog.saveAvailable}
        />
      )}
    </div>
  );
};

const RolePage = () => {
  const { t } = useModernI18n();
  const router = useRouter();
  const [retryStatus, setRetryStatus] = useState<'unavailable'>();
  const retry = () => {
    void browserRuntime.runPromise(
      invalidateRoles(router).pipe(
        Effect.match({
          onFailure: (failure) => setRetryStatus(refreshFailureStatus(failure)),
          onSuccess: () => setRetryStatus(undefined),
        }),
      ),
    );
  };
  const model = useLoaderData({ from: '/$lang/access/roles' });
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  if (model.shell.state !== 'authenticated' || model.state === 'reload_required' || controls.reloadRequired) {
    return (
      <main className="shell:mx-auto shell:grid shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <h1 className="shell:text-title-lg">{t('shell.accessAdmin.role.title')}</h1>
        <StatusText aria-live="polite" status="error">
          {t(
            model.state === 'reload_required' || controls.reloadRequired
              ? 'shell.moduleTarget.reload_required'
              : `shell.accessAdmin.common.${model.state === 'unauthenticated' ? 'unauthenticated' : 'unavailable'}`,
          )}
        </StatusText>
      </main>
    );
  }
  return (
    <ShellContentLayout
      controls={controls}
      currentAccessPage="roles"
      shell={model.shell}
      title={t('shell.accessAdmin.role.title')}
    >
      {model.state === 'ready' ? (
        <ReadyRoles key={model.catalog.catalogSnapshotId} model={model} />
      ) : (
        <div className="shell:grid shell:gap-4">
          <StatusText aria-live="polite" status="error">
            {t(`shell.accessAdmin.common.${model.state === 'invalid' ? 'failed' : model.state}`)}
          </StatusText>
          {retryStatus === undefined ? null : (
            <StatusText aria-live="polite" status="error">
              {t(`shell.accessAdmin.common.${retryStatus}`)}
            </StatusText>
          )}
          <Button onClick={retry} type="button">
            {t('shell.accessAdmin.common.retry')}
          </Button>
        </div>
      )}
    </ShellContentLayout>
  );
};

export default RolePage;
