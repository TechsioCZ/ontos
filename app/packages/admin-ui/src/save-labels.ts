/**
 * The one wording of explicit save: the Save button, the status next to it and the question asked before unsaved
 * changes are left. Every form shows the same words, so they live here and not in each module's catalogue.
 */
export interface SaveLabels {
  /** Conflict status. */
  readonly conflict: string;
  /** Confirmation button that drops the draft and leaves. */
  readonly discard: string;
  /** Status after a failed save, unless the form supplies its own failure text. */
  readonly failed: string;
  /** Status of a changed draft the form's validation holds back. */
  readonly invalid: string;
  /** Body of the confirmation. */
  readonly leaveDescription: string;
  /** Title of the confirmation. */
  readonly leaveTitle: string;
  /** Status of a draft handed over for approval. */
  readonly proposed: string;
  /** Reload-required only: the button that reloads the page and puts the unsaved drafts back. */
  readonly reloadKeepingDrafts: string;
  /** Status of a draft a deploy left behind: the new release refuses this tab until the page reloads. */
  readonly reloadRequired: string;
  /** Conflict only: the action that loads the version someone else saved. */
  readonly reloadLatest: string;
  /** The Save button, here and in the confirmation. */
  readonly save: string;
  readonly saved: string;
  /** The Save button while its save runs. */
  readonly saving: string;
  /** Confirmation button that keeps the form open. */
  readonly stay: string;
  /** Status of a changed draft. */
  readonly unsaved: string;
}

const cs: SaveLabels = {
  conflict: 'Záznam mezitím změnil někdo jiný.',
  discard: 'Zahodit změny',
  failed: 'Uložení se nezdařilo. Zkuste to znovu.',
  invalid: 'Neuložené změny – opravte zvýrazněná pole',
  leaveDescription: 'Máte neuložené změny. Chcete je před odchodem uložit?',
  leaveTitle: 'Neuložené změny',
  proposed: 'Odesláno ke schválení – změna zatím nebyla provedena',
  reloadKeepingDrafts: 'Načíst novou verzi a obnovit úpravy',
  reloadLatest: 'Načíst aktuální verzi',
  reloadRequired: 'Mezitím byla nasazena nová verze aplikace. Načtěte stránku, vaše úpravy se obnoví.',
  save: 'Uložit',
  saved: 'Uloženo',
  saving: 'Ukládám…',
  stay: 'Zůstat',
  unsaved: 'Neuložené změny',
};

const sk: SaveLabels = {
  conflict: 'Záznam medzitým zmenil niekto iný.',
  discard: 'Zahodiť zmeny',
  failed: 'Uloženie sa nepodarilo. Skúste to znova.',
  invalid: 'Neuložené zmeny – opravte zvýraznené polia',
  leaveDescription: 'Máte neuložené zmeny. Chcete ich pred odchodom uložiť?',
  leaveTitle: 'Neuložené zmeny',
  proposed: 'Odoslané na schválenie – zmena zatiaľ nebola vykonaná',
  reloadKeepingDrafts: 'Načítať novú verziu a obnoviť úpravy',
  reloadLatest: 'Načítať aktuálnu verziu',
  reloadRequired: 'Medzitým bola nasadená nová verzia aplikácie. Načítajte stránku, vaše úpravy sa obnovia.',
  save: 'Uložiť',
  saved: 'Uložené',
  saving: 'Ukladám…',
  stay: 'Zostať',
  unsaved: 'Neuložené zmeny',
};

const en: SaveLabels = {
  conflict: 'Someone else changed this record in the meantime.',
  discard: 'Discard changes',
  failed: 'Saving failed. Try again.',
  invalid: 'Unsaved changes – fix the highlighted fields',
  leaveDescription: 'You have unsaved changes. Do you want to save them before you leave?',
  leaveTitle: 'Unsaved changes',
  proposed: 'Sent for approval – the change has not been applied yet',
  reloadKeepingDrafts: 'Load the new version and restore changes',
  reloadLatest: 'Load the latest version',
  reloadRequired: 'A new version of the app was deployed in the meantime. Reload the page; your changes will be restored.',
  save: 'Save',
  saved: 'Saved',
  saving: 'Saving…',
  stay: 'Stay',
  unsaved: 'Unsaved changes',
};

const byLanguage: ReadonlyMap<string, SaveLabels> = new Map([
  ['cs', cs],
  ['en', en],
  ['sk', sk],
]);

/** Czech wording: the default of `SaveBar` and `UnsavedChangesDialog`. */
export const saveLabels: SaveLabels = cs;

/**
 * The wording for the language the i18n runtime reports (`useModernI18n().language`); Czech for any other.
 * Pass the result as `labels` to `SaveBar` and `UnsavedChangesDialog`.
 */
export const saveLabelsFor = (language: string | undefined): SaveLabels =>
  byLanguage.get((language ?? 'cs').slice(0, 2).toLowerCase()) ?? cs;
