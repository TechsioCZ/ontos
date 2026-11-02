import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Match } from 'effect';
import type { AutosaveState } from './autosave.ts';

export interface AutosaveStatusProps {
  /** Conflict only: discard the local draft and load the version someone else saved. */
  onReloadLatest: () => void;
  /** Error only: send the draft again. */
  onRetry: () => void;
  status: AutosaveState;
}

const AutosaveStatusContent = ({ onReloadLatest, onRetry, status }: AutosaveStatusProps) =>
  Match.value(status).pipe(
    Match.whenOr('idle', 'dirty', () => null),
    Match.when('saving', () => <StatusText size="sm">Ukládám…</StatusText>),
    Match.when('saved', () => (
      <StatusText showIcon size="sm" status="success">
        Uloženo
      </StatusText>
    )),
    Match.when('invalid', () => (
      <StatusText showIcon size="sm" status="warning">
        Neuloženo – opravte zvýrazněná pole
      </StatusText>
    )),
    Match.when('error', () => (
      <>
        <StatusText showIcon size="sm" status="error">
          Chyba –
        </StatusText>
        <Button onClick={onRetry} size="sm" theme="borderless" variant="secondary">
          zkusit znovu
        </Button>
      </>
    )),
    Match.when('conflict', () => (
      <>
        <StatusText showIcon size="sm" status="warning">
          Záznam mezitím změnil někdo jiný.
        </StatusText>
        <Button onClick={onReloadLatest} size="sm" theme="outlined" variant="secondary">
          Načíst aktuální verzi
        </Button>
      </>
    )),
    Match.exhaustive,
  );

/** Inline autosave state of an edit form. Quiet while nothing is pending; offers a button only on error or conflict. */
export const AutosaveStatus = (props: AutosaveStatusProps) => (
  <div aria-live="polite" className="flex flex-wrap items-center gap-100" data-autosave-state={props.status}>
    <AutosaveStatusContent {...props} />
  </div>
);
