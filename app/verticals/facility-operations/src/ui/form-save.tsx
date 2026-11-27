// Explicit save of one facility form that creates a record or runs a command with typed details: typing changes only
// the draft, the shared Save button ("Uložit", last in the footer) sends it once, and leaving with unsaved input asks
// Uložit / Zahodit změny / Zůstat. A form that was not touched closes without asking.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { DraftSave, SavableDraft, SaveLabels, SaveOutcome, UnsavedChangesGuard } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Equal, Predicate } from 'effect';
import { constTrue, constVoid } from 'effect/Function';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { CommandOutcome } from './use-agenda.ts';

/** A submit that went through, and what the form does next (toast, close, navigation, list refresh). */
export interface SubmitDone {
  readonly done: () => void;
}

/** How one submit of the form ended: done, or why nothing was saved (the form shows the specific reason itself). */
export type FormSubmitResult = SaveOutcome | SubmitDone;

/** The submit went through; `done` runs once the save bar reports it saved. */
export const submitDone = (done: () => void): FormSubmitResult => ({ done });

/**
 * A refused facility command as the save bar sees it; the form keeps its own text of the reason. A change parked for
 * approval saved nothing and is never sent again. A form that adds something new has no newer version of its draft to
 * load, so every other refusal keeps the draft for the next Uložit; an edit (`conflicts`) shows a conflict as one.
 */
export const refusedOutcome = (
  outcome: Extract<CommandOutcome, { readonly ok: false }>,
  conflicts = false,
): SaveOutcome => {
  if (outcome.reason === 'approval_required') {
    return 'proposed';
  }
  return conflicts && outcome.reason === 'conflict' ? 'conflict' : 'failed';
};

/** One facility command result: `onOk` runs after a confirmed save, `onFailed` keeps the reason for the form. */
export const commandResult = (
  outcome: CommandOutcome,
  onOk: (result: Extract<CommandOutcome, { readonly ok: true }>['result']) => void,
  onFailed: (reason: Extract<CommandOutcome, { readonly ok: false }>['reason']) => void,
  conflicts = false,
): FormSubmitResult => {
  if (outcome.ok) {
    return submitDone(() => {
      onOk(outcome.result);
    });
  }
  onFailed(outcome.reason);
  return refusedOutcome(outcome, conflicts);
};

/** The draft value before the form opened: a form whose opening values Uložit can send at once differs from it. */
const NOT_OPENED: unique symbol = Symbol('facility-form-not-opened');
type Drafted<V> = V | typeof NOT_OPENED;

export interface FormSaveOptions<V> {
  readonly equals?: ((left: V, right: V) => boolean) | undefined;
  /** Holds Uložit back while false; by default every draft can be sent and the submit says what is missing. */
  readonly isValid?: ((value: V) => boolean) | undefined;
  /** Zahodit změny: the form puts its opening values back. */
  readonly onDiscard?: (() => void) | undefined;
  /**
   * For a form that stays on screen after its save (an inline form): puts its empty values back once the save went
   * through and returns them, so the next entry starts clean and is not asked about until something is typed.
   */
  readonly onStartOver?: (() => V) | undefined;
  /** Whether the form is on screen, for a form that stays mounted while its panel is closed. */
  readonly open?: boolean | undefined;
  /**
   * The values the form opens with can be sent by Uložit at once (a command whose details are prefilled). They are
   * not typed input: leaving an untouched form does not ask.
   */
  readonly savableAtOnce?: boolean | undefined;
  /** Sends the draft once: the form's own checks, the command, and the reason of a refusal on screen. */
  readonly submit: (value: V) => Effect.Effect<FormSubmitResult>;
  readonly value: V;
}

export interface FormSave<V> {
  readonly draft: DraftSave<Drafted<V>>;
  readonly guard: UnsavedChangesGuard;
  readonly handleSave: () => void;
  readonly labels: SaveLabels;
}

/** Draft, save and unsaved-changes guard of one facility form; nothing is sent before Uložit. */
export const useFormSave = <V,>(options: FormSaveOptions<V>): FormSave<V> => {
  const { language } = useModernI18n();
  // The values the form opened with; a start-over after a save goes back to them.
  const [opening, setOpening] = useState(options.value);
  // What the form does after the save that is running now went through.
  const done = useRef<(() => void) | null>(null);
  // Set while the form leaves after its own save, so the navigation that leaves is not asked about.
  const leaving = useRef(false);
  const same = options.equals ?? Equal.equals;
  const valid = options.isValid ?? constTrue;
  const draft = useDraftSave<Drafted<V>, never>({
    equals: (left, right) => (left === NOT_OPENED || right === NOT_OPENED ? left === right : same(left, right)),
    initial: options.savableAtOnce === true ? NOT_OPENED : undefined,
    isValid: (value) => value !== NOT_OPENED && valid(value),
    open: options.open,
    opened: options.savableAtOnce === true ? opening : undefined,
    runtime: browserRuntime,
    save: (value) =>
      value === NOT_OPENED
        ? Effect.succeed<SaveOutcome>('failed')
        : options.submit(value).pipe(
            Effect.map((result): SaveOutcome => {
              if (Predicate.isString(result)) {
                return result;
              }
              done.current = result.done;
              return 'saved';
            }),
          ),
    value: options.value,
  });
  const handleSave = () => {
    draft.save();
    draft.afterSave((status) => {
      const feedback = done.current;
      done.current = null;
      if (status !== 'saved' || feedback === null) {
        return;
      }
      leaving.current = true;
      feedback();
      leaving.current = false;
      if (options.onStartOver !== undefined) {
        // The next entry opens with the values put back, and they are not typed input either.
        const next = options.onStartOver();
        setOpening(next);
        draft.adopt(options.savableAtOnce === true ? NOT_OPENED : next);
      }
    });
  };
  // Uložit in the leave question saves the same way as the button, with the same feedback.
  const savable: SavableDraft = { ...draft, save: handleSave };
  const navigation = useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: () => !leaving.current && draft.dirty,
    withResolver: true,
  });
  const guard = useUnsavedChangesGuard({ draft: savable, navigation, onDiscard: options.onDiscard ?? constVoid });
  return { draft, guard, handleSave, labels: saveLabelsFor(language) };
};

const FormCancelButton = ({ label, onCancel }: { readonly label: string; readonly onCancel: () => void }) => (
  <Button onClick={onCancel} theme="outlined" type="button" variant="secondary">
    {label}
  </Button>
);

/**
 * The footer of a facility form: its secondary actions, then the shared Save button last, and the one leave
 * question. `onCancel` leaves through the guard.
 */
export const FormSaveFooter = <V,>({
  cancelLabel,
  children,
  error,
  form,
  onCancel,
  onReloadLatest = constVoid,
}: {
  readonly cancelLabel?: string | undefined;
  readonly children?: ReactNode;
  readonly error?: string | undefined;
  readonly form: FormSave<V>;
  readonly onCancel?: (() => void) | undefined;
  /** An edit only: after a conflict, load the version someone else saved. */
  readonly onReloadLatest?: (() => void) | undefined;
}) => (
  <div className="flex flex-wrap items-center justify-end gap-100">
    {children}
    {onCancel !== undefined && cancelLabel !== undefined && (
      <FormCancelButton label={cancelLabel} onCancel={() => form.guard.request(onCancel)} />
    )}
    <SaveBar
      error={error}
      labels={form.labels}
      onReloadLatest={onReloadLatest}
      onSave={form.handleSave}
      status={form.draft.status}
    />
    <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
  </div>
);
