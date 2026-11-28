/*
 * Kit classes of the tenant dossier, the stay documents and their forms: one tinted level inside a SectionCard,
 * hairline dividers between timeline entries, two field columns that stack below 600 px.
 */

/** The section a dossier card sits in; a link to `#tenant` keeps its heading clear of the top edge. */
export const dossierSectionClass = 'min-w-0 scroll-mt-6';
export const dossierTitleClass = 'text-[14px] font-semibold';
export const dossierMutedClass = 'text-[12px] leading-[1.7] text-fg-secondary wrap-anywhere';
export const dossierHeadingClass = 'flex flex-wrap items-center justify-between gap-3';
export const dossierStackClass = 'grid min-w-0 gap-3';
/** A tinted block inside the card: one contact, the case, a registration sheet, a directory entry. */
export const dossierTileClass = 'grid min-w-0 gap-3 rounded-md bg-surface p-4';
export const dossierFieldsClass = 'grid grid-cols-2 gap-3 max-[600px]:grid-cols-1';
export const dossierActionsClass = 'flex flex-wrap items-end gap-3';
export const dossierEventClass = 'grid gap-2 border-b border-border-primary/60 py-4 text-[13px] wrap-anywhere';
export const dossierSelectClass =
  'rounded-[6px] border border-border-primary bg-surface px-3 py-2 text-[13px] text-fg-primary';
export const noticeTextClass =
  'w-full min-w-0 resize-y rounded-[6px] border border-border-primary bg-surface px-2.5 py-2 text-[14px]';
export const noticeBodyClass = 'whitespace-pre-wrap text-[13px] wrap-anywhere';
/** A link that reads as the text around it: no underline, the surrounding colour. */
export const plainLinkClass = 'text-inherit no-underline';
