// The typed confirmation of one agent API key command (issue, rotate, disable, enable, revoke): the key name and the
// reason are a draft; the shared Uložit runs the command once; Zrušit and leaving the page with typed input ask first.
import {
  SaveBar,
  UnsavedChangesDialog,
  dialogCloseLabel,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Effect } from 'effect';
import { constVoid } from 'effect/Function';
import { useState } from 'react';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';

const copyKey = 'shell.agents.keys';

/** How a started key command ended for its form: committed, refused as a conflict, or failed before it committed. */
export type KeyCommandEnd = Extract<SaveOutcome, 'conflict' | 'failed' | 'saved'>;

interface KeyDraft {
  readonly name: string;
  readonly reason: string;
}

export const KeyConfirmation = <C extends { readonly key?: { readonly name: string | null }; readonly kind: string }>({
  busy,
  command,
  failure,
  onClose,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly command: C;
  readonly failure: string | null;
  readonly onClose: () => void;
  /** Runs the command once; answers false when it could not start, else reports how it ended through `onEnd`. */
  readonly onConfirm: (command: C, name: string, reason: string, onEnd: (end: KeyCommandEnd) => void) => boolean;
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const opening: KeyDraft = { name: command.kind === 'rotate' ? (command.key?.name ?? '') : '', reason: '' };
  const [draft, setDraft] = useState(opening);
  const namedCommand = command.kind === 'issue' || command.kind === 'rotate';
  const record = useDraftSave<KeyDraft, never>({
    initial: opening,
    isValid: (value) =>
      (command.kind === 'issue' || value.reason.trim().length > 0) && (!namedCommand || value.name.trim().length > 0),
    runtime: browserRuntime,
    save: (value) =>
      Effect.callback<KeyCommandEnd>((resume) => {
        const started = onConfirm(command, value.name.trim(), value.reason.trim(), (end) =>
          resume(Effect.succeed(end)),
        );
        if (!started) {
          resume(Effect.succeed('failed'));
        }
      }),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: () => setDraft(opening) });
  const requestClose = () => {
    if (!busy) {
      guard.request(onClose);
    }
  };
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        onClose();
      }
    });
  };
  return (
    <>
      <Dialog
        actions={
          <>
            <Button disabled={busy} onClick={requestClose} theme="outlined" type="button" variant="secondary">
              {t(`${copyKey}.cancel`)}
            </Button>
            <SaveBar
              error={failure === null ? null : t(`${copyKey}.${failure}`)}
              labels={labels}
              onReloadLatest={constVoid}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        closeLabel={dialogCloseLabel}
        closeOnInteractOutside={false}
        description={t(`${copyKey}.confirmDescription`)}
        onOpenChange={(details) => {
          if (!details.open) {
            requestClose();
          }
        }}
        open
        title={t(`${copyKey}.${command.kind}`)}
      >
        <div className="flex flex-col gap-200">
          {namedCommand && (
            <FormInput
              autoComplete="off"
              label={t(`${copyKey}.name`)}
              maxLength={32}
              name="keyName"
              onChange={(event) => {
                const { value } = event.target;
                setDraft((current) => ({ ...current, name: value }));
              }}
              required
              value={draft.name}
            />
          )}
          {command.kind !== 'issue' && (
            <FormTextarea
              label={t(`${copyKey}.reason`)}
              maxLength={500}
              name="keyReason"
              onChange={(event) => {
                const { value } = event.target;
                setDraft((current) => ({ ...current, reason: value }));
              }}
              required
              rows={2}
              value={draft.reason}
            />
          )}
          {failure !== null && record.status !== 'error' && (
            <StatusText showIcon status="error">
              {t(`${copyKey}.${failure}`)}
            </StatusText>
          )}
        </div>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
