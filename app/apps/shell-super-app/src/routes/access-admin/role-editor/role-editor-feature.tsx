import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useEffect, useRef, useState } from 'react';

import type {
  GetAccessRoleResponse,
  ListAccessRoleTemplatesResponse,
  PreviewAccessRoleEditResponse,
} from '../../../../shared/access-admin-api.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import {
  addExactLevel,
  canSaveRolePreview,
  editRoleDraft,
  initialRoleDraft,
  parseAmountCeiling,
  roleCellSlot,
  toggleRoleCell,
} from './model.ts';
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
  const status = draft.invalidAmounts.length > 0 ? 'invalid' : draft.status;
  const payload = {
    catalogSnapshotId: catalog.catalogSnapshotId,
    cells: draft.cells,
    expectedRoleRevisionId: initialRole.revisionId,
    roleId: initialRole.id,
  };
  const describeEffect = (effect: PreviewAccessRoleEditResponse['dangerous'][number]) => {
    const entry = catalog.entries.find((candidate) => candidate.capabilityKey === effect.capabilityKey);
    return t('shell.accessAdmin.role.dangerousEffectDescription', {
      capability: effect.capabilityKey,
      kind: t(entry === undefined ? 'shell.accessAdmin.common.unknown' : `shell.accessAdmin.kind.${entry.kind}`),
      mode: t(`shell.accessAdmin.mode.${effect.mode}`),
      risk: t(`shell.accessAdmin.risk.${effect.risk}`),
    });
  };
  const edited = (cells: readonly RoleCellView[]) => {
    idempotencyKey.current = null;
    setDraft((current) => editRoleDraft(current, cells));
  };
  const previewSucceeded = ({
    key,
    result,
  }: {
    readonly key: string;
    readonly result: PreviewAccessRoleEditResponse;
  }) => {
    idempotencyKey.current = key;
    const preview = toRolePreviewView(result, describeEffect);
    setDraft((current) => ({ ...current, cells: result.cells, preview, status: 'idle' }));
  };
  const releaseOperation = () => {
    operation.current = null;
  };
  const runPreview = () => {
    if (operation.current !== null || draft.invalidAmounts.length > 0) {
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    idempotencyKey.current = null;
    setDraft((current) => ({ ...current, confirmations: [], preview: null, status: 'loading' }));
    browserRuntime.runFork(
      prepareRolePreview(payload, language).pipe(
        Effect.match({
          onFailure: (error) => setDraft((current) => ({ ...current, status: roleErrorStatus(error) })),
          onSuccess: previewSucceeded,
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
    setDraft((current) => ({
      ...current,
      confirmations: invalidate ? [] : current.confirmations,
      preview: invalidate ? null : current.preview,
      status: next,
    }));
  };
  const save = () => {
    if (
      operation.current !== null ||
      draft.preview === null ||
      idempotencyKey.current === null ||
      !canSaveRolePreview(draft.preview, draft.confirmations, status, writesAvailable)
    ) {
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setDraft((current) => ({ ...current, status: 'saving' }));
    browserRuntime.runFork(
      commitRolePreview(payload, draft.preview, idempotencyKey.current, language).pipe(
        Effect.match({
          onFailure: saveFailed,
          onSuccess: (result) => {
            idempotencyKey.current = null;
            setDraft((current) => ({
              ...initialRoleDraft(result.role.cells),
              editorVersion: current.editorVersion + 1,
              status: 'saved',
            }));
            onSaved(result.role);
          },
        }),
        Effect.ensuring(Effect.sync(releaseOperation)),
      ),
      { signal: controller.signal },
    );
  };
  const updateAmount = (cell: RoleCellView, amount: string, currency: string) => {
    idempotencyKey.current = null;
    const value = parseAmountCeiling(amount, currency);
    const slot = roleCellSlot(cell);
    setDraft((current) => {
      if (value === 'invalid') {
        return {
          ...current,
          confirmations: [],
          invalidAmounts: [...new Set([...current.invalidAmounts, slot])],
          preview: null,
        };
      }
      const { amountCeiling: previous, ...base } = cell;
      void previous;
      const next = value === undefined ? base : { ...base, amountCeiling: value };
      return {
        ...editRoleDraft(current, toggleRoleCell(current.cells, next, true)),
        invalidAmounts: current.invalidAmounts.filter((item) => item !== slot),
      };
    });
  };
  return (
    <RoleEditorView
      catalogSnapshotId={catalog.catalogSnapshotId}
      cells={draft.cells}
      confirmations={draft.confirmations}
      entries={entries}
      key={draft.editorVersion}
      onAmount={updateAmount}
      onConfirm={(id, checked) =>
        setDraft((current) => ({
          ...current,
          confirmations: checked
            ? [...new Set([...current.confirmations, id])]
            : current.confirmations.filter((item) => item !== id),
        }))
      }
      onLevel={(moduleKey, level) => edited(addExactLevel(draft.cells, entries, moduleKey, level))}
      onPreview={runPreview}
      onRefresh={onRefresh}
      onSave={save}
      onTemplate={(template) => {
        if (template.catalogSnapshotId !== catalog.catalogSnapshotId) {
          return;
        }
        idempotencyKey.current = null;
        setDraft((current) => ({
          ...editRoleDraft(current, template.cells),
          editorVersion: current.editorVersion + 1,
          invalidAmounts: [],
        }));
      }}
      onToggleCell={(cell, enabled) => {
        idempotencyKey.current = null;
        setDraft((current) => ({
          ...editRoleDraft(current, toggleRoleCell(current.cells, cell, enabled)),
          invalidAmounts: current.invalidAmounts.filter((item) => item !== roleCellSlot(cell)),
        }));
      }}
      preview={draft.preview}
      role={initialRole}
      status={status}
      templates={catalog.templates}
      writesAvailable={writesAvailable}
    />
  );
};
