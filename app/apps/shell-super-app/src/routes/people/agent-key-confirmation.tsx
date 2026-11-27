// The typed confirmation of one managed API key command (issue, rotate, disable, enable, revoke) of an agent or an
// integration: the key name, the reason and, for an integration, an existing key value to register instead of a
// generated one are a draft; the shared Uložit runs the command once; Zrušit and leaving the page with typed input ask
// first.
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
import { FormInput, FormTextarea } from '@app/admin-ui/form-controls';
import { Effect, Redacted, Schema } from 'effect';
import { SuppliedApiKeyValueSchema } from '@app/shared-contracts/integrations/connector-partners';
import { constVoid } from 'effect/Function';
import { useState } from 'react';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';

const agentCopyKey = 'shell.agents.keys';

/** How a started key command ended for its form: committed, refused as a conflict, or failed before it committed. */
export type KeyCommandEnd = Extract<SaveOutcome, 'conflict' | 'failed' | 'saved'>;

interface KeyDraft {
  /** An existing key value typed by the administrator, redacted as it is typed; empty means generate one. */
  readonly existingValue: Redacted.Redacted;
  readonly name: string;
  readonly reason: string;
}

/** What one confirmed key command carries: its name and reason, and an existing key value to register, if any. */
export interface KeyCommandDraft {
  readonly name: string;
  readonly reason: string;
  readonly suppliedSecret?: Redacted.Redacted;
}
const isSuppliedValue = Schema.is(SuppliedApiKeyValueSchema);
/** Nothing typed means generate a key; a typed value that is no valid key is `null`. */
const suppliedSecretOf = (typed: Redacted.Redacted): Redacted.Redacted | null | undefined => {
  const value = Redacted.value(typed).trim();
  if (value.length === 0) {
    return undefined;
  }
  return isSuppliedValue(value) ? Redacted.make(value) : null;
};
/** Two drafts are the same input when every typed field is, the redacted value compared by what was typed. */
const sameDraft = (left: KeyDraft, right: KeyDraft): boolean =>
  left.name === right.name &&
  left.reason === right.reason &&
  Redacted.value(left.existingValue) === Redacted.value(right.existingValue);
const draftOf = (value: KeyDraft, acceptsSecret: boolean): KeyCommandDraft => {
  const draft = { name: value.name.trim(), reason: value.reason.trim() };
  const suppliedSecret = acceptsSecret ? suppliedSecretOf(value.existingValue) : undefined;
  return suppliedSecret === undefined || suppliedSecret === null ? draft : { ...draft, suppliedSecret };
};

export const KeyConfirmation = <C extends { readonly key?: { readonly name: string | null }; readonly kind: string }>({
  allowSuppliedSecret = false,
  busy,
  command,
  copyKey = agentCopyKey,
  failure,
  onClose,
  onConfirm,
}: {
  /** An issue or rotation may register an existing key value (tenant-managed integration keys only). */
  readonly allowSuppliedSecret?: boolean;
  readonly busy: boolean;
  readonly command: C;
  /** The copy namespace of the keys being managed (`shell.agents.keys`, `shell.integrations.keys`). */
  readonly copyKey?: string;
  readonly failure: string | null;
  readonly onClose: () => void;
  /** Runs the command once; answers false when it could not start, else reports how it ended through `onEnd`. */
  readonly onConfirm: (command: C, draft: KeyCommandDraft, onEnd: (end: KeyCommandEnd) => void) => boolean;
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const opening: KeyDraft = {
    existingValue: Redacted.make(''),
    name: command.kind === 'rotate' ? (command.key?.name ?? '') : '',
    reason: '',
  };
  const [draft, setDraft] = useState(opening);
  const namedCommand = command.kind === 'issue' || command.kind === 'rotate';
  const acceptsSecret = allowSuppliedSecret && namedCommand;
  const typedSecret = acceptsSecret ? suppliedSecretOf(draft.existingValue) : undefined;
  const record = useDraftSave<KeyDraft, never>({
    equals: sameDraft,
    initial: opening,
    isValid: (value) =>
      (command.kind === 'issue' || value.reason.trim().length > 0) &&
      (!namedCommand || value.name.trim().length > 0) &&
      (!acceptsSecret || suppliedSecretOf(value.existingValue) !== null),
    runtime: browserRuntime,
    save: (value) =>
      Effect.callback<KeyCommandEnd>((resume) => {
        const started = onConfirm(command, draftOf(value, acceptsSecret), (end) => resume(Effect.succeed(end)));
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
            <Button appearance="outline" disabled={busy} onClick={requestClose} severity="secondary" type="button">
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
          {acceptsSecret && (
            <FormInput
              autoComplete="off"
              helpText={t(`${copyKey}.suppliedSecretDescription`)}
              label={t(`${copyKey}.suppliedSecret`)}
              maxLength={256}
              name="suppliedSecret"
              onChange={(event) => {
                const typed = Redacted.make(event.target.value);
                setDraft((current) => ({ ...current, existingValue: typed }));
              }}
              type="password"
              value={Redacted.value(draft.existingValue)}
            />
          )}
          {typedSecret === null && (
            <StatusText showIcon status="error">
              {t(`${copyKey}.suppliedSecretInvalid`)}
            </StatusText>
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
