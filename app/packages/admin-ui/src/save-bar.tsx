import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Match } from 'effect';
import { draftSavable } from './draft-save.ts';
import type { SaveState } from './draft-save.ts';
import { saveLabels } from './save-labels.ts';
import type { SaveLabels } from './save-labels.ts';

export interface SaveBarProps {
  /**
   * Error only: the form's own failure text (for example why the server refused the change) instead of the general
   * one.
   */
  readonly error?: string | null | undefined;
  /** Wording for the current language (`saveLabelsFor(language)`); Czech by default. */
  readonly labels?: SaveLabels;
  /** Conflict only: discard the local draft and load the version someone else saved. */
  readonly onReloadLatest: () => void;
  /** The one click that sends the whole draft (`DraftSave.save`). */
  readonly onSave: () => void;
  /** Matches the buttons next to it; `md` by default. */
  readonly size?: 'md' | 'sm';
  readonly status: SaveState;
}

type SaveStatusProps = Pick<SaveBarProps, 'error' | 'onReloadLatest' | 'size' | 'status'> & {
  readonly labels: SaveLabels;
};

const SaveStatus = ({ error, labels, onReloadLatest, size = 'md', status }: SaveStatusProps) =>
  Match.value(status).pipe(
    // The button itself shows a running save. Values a form opened with are not unsaved input: nothing to say.
    Match.whenOr('idle', 'ready', 'saving', () => null),
    Match.when('dirty', () => <StatusText size="sm">{labels.unsaved}</StatusText>),
    Match.when('saved', () => (
      <StatusText showIcon size="sm" status="success">
        {labels.saved}
      </StatusText>
    )),
    Match.when('invalid', () => (
      <StatusText showIcon size="sm" status="warning">
        {labels.invalid}
      </StatusText>
    )),
    // Informational, not a failure: the change waits for approval.
    Match.when('proposed', () => <StatusText size="sm">{labels.proposed}</StatusText>),
    Match.when('error', () => (
      <StatusText showIcon size="sm" status="error">
        {error ?? labels.failed}
      </StatusText>
    )),
    Match.when('conflict', () => (
      <>
        <StatusText showIcon size="sm" status="warning">
          {labels.conflict}
        </StatusText>
        <Button onClick={onReloadLatest} size={size} theme="outlined" type="button" variant="secondary">
          {labels.reloadLatest}
        </Button>
      </>
    )),
    Match.exhaustive,
  );

/**
 * The save control of an edit form: one primary Save button with the status of the draft next to it. Put it last in
 * the form's footer (in a side panel, last in the panel's `actions`).
 *
 * The button is enabled only for a changed, valid draft (`ready` included) and after a failed save, shows the loading state while the
 * save runs, and one click sends one save. Nothing else in a form may save.
 */
export const SaveBar = ({ error, labels = saveLabels, onReloadLatest, onSave, size = 'md', status }: SaveBarProps) => (
  <div className="flex flex-wrap items-center justify-end gap-150" data-save-state={status}>
    <div aria-live="polite" className="flex flex-wrap items-center gap-100">
      <SaveStatus error={error} labels={labels} onReloadLatest={onReloadLatest} size={size} status={status} />
    </div>
    <Button
      className="shrink-0 whitespace-nowrap"
      disabled={!(draftSavable(status) || status === 'saving')}
      isLoading={status === 'saving'}
      loadingText={labels.saving}
      onClick={onSave}
      size={size}
      type="button"
      variant="primary"
    >
      {labels.save}
    </Button>
  </div>
);
