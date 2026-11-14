// Explicit save of one CRM side-panel form that sends a single command: typing changes only the draft, the shared
// Save button ("Uložit", last in the footer) sends it, and leaving with unsaved input asks Uložit / Zahodit změny /
// Zůstat.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { DraftSave, SaveLabels, SaveOutcome, UnsavedChangesGuard } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Option } from 'effect';
import { constVoid } from 'effect/Function';
import { useRef, useState } from 'react';
import type { CrmCommandInput } from '../../shared/actions/apply-command.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { CrmCommandSubmit } from './records.ts';

export interface CrmFormSaveOptions<V> {
  /** The command that sends `value`; none while the draft is incomplete, which keeps Uložit disabled. */
  readonly command: (value: V) => Option.Option<CrmCommandInput>;
  /** Text of a refused save, from the server's message when it gave one. */
  readonly failureText: (message: string | undefined) => string;
  /**
   * For a create form whose opening values are already complete: `empty` is the version the draft is compared with,
   * so Uložit can send at once, and `opened` the values it opened with, which leaving does not ask about.
   */
  readonly fromEmpty?: { readonly empty: V; readonly opened: V } | undefined;
  /** The command went through with `value`: the panel shows its toast and closes. */
  readonly onSaved: (value: V, entityIds: readonly string[]) => void;
  readonly submit: CrmCommandSubmit;
  readonly value: V;
}

export interface CrmFormSave<V> {
  readonly error: string | undefined;
  readonly guard: UnsavedChangesGuard;
  readonly handleSave: () => void;
  readonly labels: SaveLabels;
  readonly record: DraftSave<V>;
}

/** Draft, save and unsaved-changes guard of one CRM form; nothing is sent before Uložit. */
export const useCrmFormSave = <V,>(options: CrmFormSaveOptions<V>): CrmFormSave<V> => {
  const { language } = useModernI18n();
  const [error, setError] = useState<string | undefined>();
  // What the last save sent and what it created, for `onSaved` once the save bar reports it saved.
  const saved = useRef<{ readonly entityIds: readonly string[]; readonly value: V } | null>(null);
  const record = useDraftSave<V, never>({
    initial: options.fromEmpty?.empty,
    isValid: (value) => Option.isSome(options.command(value)),
    // Only what the user typed asks before leaving: values the form opened with are not lost input.
    opened: options.fromEmpty?.opened,
    runtime: browserRuntime,
    save: (value) =>
      Option.match(options.command(value), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) =>
          options.submit(command).pipe(
            Effect.map((outcome): SaveOutcome => {
              if (outcome.ok) {
                setError(undefined);
                saved.current = { entityIds: outcome.entityIds, value };
                return 'saved';
              }
              setError(options.failureText(outcome.message));
              return 'failed';
            }),
          ),
      }),
    value: options.value,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: constVoid });
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      const sent = saved.current;
      if (status === 'saved' && sent !== null) {
        saved.current = null;
        options.onSaved(sent.value, sent.entityIds);
      }
    });
  };
  return { error, guard, handleSave, labels: saveLabelsFor(language), record };
};

/** Zrušit and the shared Save button, last in the panel's footer. `onCancel` leaves through the guard. */
export const CrmFormSaveActions = <V,>({
  form,
  onCancel,
}: {
  readonly form: CrmFormSave<V>;
  readonly onCancel: () => void;
}) => (
  <>
    <Button onClick={() => form.guard.request(onCancel)} theme="outlined" variant="secondary">
      Zrušit
    </Button>
    <SaveBar
      error={form.error}
      labels={form.labels}
      onReloadLatest={constVoid}
      onSave={form.handleSave}
      status={form.record.status}
    />
    <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
  </>
);
