// What an ERP dialog shows when a deploy left the tab behind: one button reloads into the new release and puts the
// dialogs' unsaved values back (reloadKeepingDrafts).
import { releaseGone, reloadKeepingDrafts } from '@app/shared-contracts';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

/** The failure text of a step the new release refused after a deploy; the dialog then offers the reload. */
export const RELOAD_REQUIRED = 'Mezitím byla nasazena nová verze aplikace. Načtěte stránku, vaše úpravy se obnoví.';

/** The text of a failed step: the owner's problem tag (and detail), or the reload notice once the release is gone. */
export const stepFailure = (step: string, problem: { readonly _tag: string }, detail = ''): string =>
  releaseGone(problem) ? RELOAD_REQUIRED : `${step}: ${problem._tag}${detail}`;

export const ReloadRequiredNotice = () => (
  <div className="flex flex-wrap items-center gap-100" data-save-state="reload-required">
    <StatusText showIcon status="warning">
      {RELOAD_REQUIRED}
    </StatusText>
    <Button appearance="outline" onClick={reloadKeepingDrafts} severity="secondary" size="sm" type="button">
      Načíst novou verzi a obnovit úpravy
    </Button>
  </div>
);
