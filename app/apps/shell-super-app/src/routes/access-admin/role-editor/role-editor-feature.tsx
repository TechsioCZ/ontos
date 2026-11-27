import type { SaveState } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useEffect, useRef, useState } from 'react';

import type {
  GetAccessRoleResponse,
  ListAccessRoleTemplatesResponse,
  PreviewAccessRoleEditResponse,
} from '../../../../shared/access-admin-api.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { canSaveRolePreview, initialRoleDraft } from './model.ts';
import type { RoleCellView } from './model.ts';
import { commitRolePreview, prepareRolePreview, roleErrorStatus, toRolePreviewView } from './role-commands.ts';
import { RoleEditorView } from './role-editor-view.tsx';

export const RoleEditorFeature = ({
  catalog,
  initialRole,
  onRefresh,
  onSaved,
  writesAvailable,
}: {
  readonly catalog: ListAccessRoleTemplatesResponse;
  readonly initialRole: GetAccessRoleResponse['role'];
  readonly onRefresh: () => void;
  readonly onSaved: (role: GetAccessRoleResponse['role']) => void;
  readonly writesAvailable: boolean;
}) => {
  const { language, t } = useModernI18n();
  const [draft, setDraft] = useState(() => initialRoleDraft(initialRole.cells));
  const operation = useRef<AbortController | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const entries = catalog.entries.map((entry) => ({ ...entry, key: entry.capabilityKey }));
  const { status } = draft;
  const payloadOf = (cells: readonly RoleCellView[]) => ({
    catalogSnapshotId: catalog.catalogSnapshotId,
    cells,
    expectedRoleRevisionId: initialRole.revisionId,
    roleId: initialRole.id,
  });
  const describeEffect = (effect: PreviewAccessRoleEditResponse['dangerous'][number]) => {
    const entry = catalog.entries.find((candidate) => candidate.capabilityKey === effect.capabilityKey);
    return t('shell.accessAdmin.role.dangerousEffectDescription', {
      capability: effect.capabilityKey,
      kind: t(entry === undefined ? 'shell.accessAdmin.common.unknown' : `shell.accessAdmin.kind.${entry.kind}`),
      mode: t(`shell.accessAdmin.mode.${effect.mode}`),
      risk: t(`shell.accessAdmin.risk.${effect.risk}`),
    });
  };
  const previewSucceeded =
    (previewedCells: readonly RoleCellView[]) =>
    ({ key, result }: { readonly key: string; readonly result: PreviewAccessRoleEditResponse }) => {
      idempotencyKey.current = key;
      const preview = toRolePreviewView(result, describeEffect);
      setDraft((current) => ({ ...current, cells: result.cells, preview, previewedCells, status: 'idle' }));
    };
  const releaseOperation = () => {
    operation.current = null;
  };
  const runPreview = (cells: readonly RoleCellView[]) => {
    if (operation.current !== null) {
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    idempotencyKey.current = null;
    setDraft((current) => ({ ...current, preview: null, status: 'loading' }));
    browserRuntime.runFork(
      prepareRolePreview(payloadOf(cells), language).pipe(
        Effect.match({
          onFailure: (error) => setDraft((current) => ({ ...current, status: roleErrorStatus(error) })),
          onSuccess: previewSucceeded(cells),
        }),
        Effect.ensuring(Effect.sync(releaseOperation)),
      ),
      { signal: controller.signal },
    );
  };
  const saveFailed = (error: Parameters<typeof roleErrorStatus>[0]) => {
    const next = roleErrorStatus(error);
    const invalidate = next === 'conflict' || next === 'forbidden' || next === 'unauthenticated';
    if (invalidate) {
      idempotencyKey.current = null;
    }
    setDraft((current) => ({ ...current, preview: invalidate ? null : current.preview, status: next }));
  };
  /** Uložit: commits the previewed and confirmed change once; answers whether a commit started. */
  const save = (confirmations: readonly string[], settle: (end: SaveState) => void): boolean => {
    if (
      operation.current !== null ||
      draft.preview === null ||
      idempotencyKey.current === null ||
      !canSaveRolePreview(draft.preview, confirmations, status, writesAvailable)
    ) {
      return false;
    }
    const controller = new AbortController();
    operation.current = controller;
    setDraft((current) => ({ ...current, status: 'saving' }));
    browserRuntime.runFork(
      commitRolePreview(payloadOf(draft.cells), draft.preview, idempotencyKey.current, language).pipe(
        Effect.match({
          onFailure: (error) => {
            saveFailed(error);
            settle(roleErrorStatus(error) === 'conflict' ? 'conflict' : 'error');
          },
          onSuccess: (result) => {
            idempotencyKey.current = null;
            setDraft((current) => ({
              ...initialRoleDraft(result.role.cells),
              editorVersion: current.editorVersion + 1,
              status: 'saved',
            }));
            onSaved(result.role);
            settle('saved');
          },
        }),
        Effect.ensuring(Effect.sync(releaseOperation)),
      ),
      { signal: controller.signal },
    );
    return true;
  };
  /** Zahodit změny: the preview and its key are forgotten; the editor puts the saved cells back itself. */
  const discard = () => {
    idempotencyKey.current = null;
    setDraft((current) => ({ ...initialRoleDraft(initialRole.cells), editorVersion: current.editorVersion }));
  };
  return (
    <RoleEditorView
      catalogSnapshotId={catalog.catalogSnapshotId}
      cells={draft.cells}
      entries={entries}
      key={draft.editorVersion}
      onDiscard={discard}
      onPreview={runPreview}
      onRefresh={onRefresh}
      onSave={save}
      preview={draft.preview}
      previewedCells={draft.previewedCells}
      role={initialRole}
      status={status}
      templates={catalog.templates}
      writesAvailable={writesAvailable}
    />
  );
};
