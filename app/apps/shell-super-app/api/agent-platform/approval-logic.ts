/**
 * Pure helpers of the platform approval layer: what a module's review means for showing and deciding a proposal,
 * key parsing and Czech texts.
 */
import type { AgentRevertResponse } from '@app/shared-contracts/agent-proposals';
import type { AgentReviewItem } from '@app/shared-contracts/agent-review';

import type { ModuleReview } from './module-review.ts';

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `core:<uuid>` -> `<uuid>`; anything else (including malformed ids) -> undefined. */
export const parseCoreKey = (key: string): string | undefined => {
  if (!key.startsWith('core:')) {
    return undefined;
  }
  const id = key.slice('core:'.length);
  return UUID.test(id) ? id.toLowerCase() : undefined;
};

export interface RevertCounts {
  /** Changes left alone because someone changed the record after the approval. */
  readonly changed: number;
  readonly failed: number;
  readonly reverted: number;
  readonly unavailable: number;
}

/** Czech summary of one „Vrátit vše“ run. */
export const revertResultMessage = ({ changed, failed, reverted, unavailable }: RevertCounts): AgentRevertResponse => {
  if (reverted === 0 && failed === 0 && unavailable === 0 && changed === 0) {
    return { message: 'V dávce není žádná provedená změna k vrácení.', outcome: 'failed' };
  }
  const parts = [`Vráceno změn: ${reverted}.`];
  if (changed > 0) {
    parts.push(`Záznam se mezitím změnil, ponecháno beze změny: ${changed}.`);
  }
  if (unavailable > 0) {
    parts.push(`Nelze automaticky vrátit: ${unavailable}.`);
  }
  if (failed > 0) {
    parts.push(`Vrácení se nepodařilo: ${failed}.`);
  }
  const outcome =
    reverted === 0 ? 'failed' : failed === 0 && unavailable === 0 && changed === 0 ? 'reverted' : 'partial';
  return { message: parts.join(' '), outcome };
};

export type ApproverCheck =
  | { readonly ok: true }
  /** `hidden`: the person may not even see the record, so the proposal is not shown to them at all. */
  | { readonly hidden: boolean; readonly ok: false; readonly reason: string };

const ALLOWED: ApproverCheck = { ok: true };
const blocked = (reason: string, hidden = false): ApproverCheck => ({ hidden, ok: false, reason });

/**
 * Is a proposal hidden from the person? The module's review says so, or the module keeps private records and its
 * review cannot answer now (history and pending proposals about records the person cannot see stay hidden).
 */
export const hiddenByReview = (review: ModuleReview | undefined, item: AgentReviewItem | undefined): boolean => {
  if (review === undefined || review.state === 'none') {
    return false;
  }
  if (review.state === 'ok' && item !== undefined) {
    return !item.visible;
  }
  return review.privateRecords;
};

/**
 * Can this person carry out the stored command? Approval runs as the approver, so a person who cannot see the
 * record, cannot write or cannot run this command must not get the approve button (the proposal would only fail and
 * be used up). The module's review answers that; for modules without one (or when it is down) the platform only
 * honours `canWrite: false` of the person's records read (`moduleBody`, undefined when it could not be read).
 */
export const approverCheck = (
  review: ModuleReview | undefined,
  item: AgentReviewItem | undefined,
  moduleBody: unknown,
): ApproverCheck => {
  if (hiddenByReview(review, item)) {
    return blocked('Záznam, který návrh mění, nevidíte nebo už neexistuje.', true);
  }
  if (item !== undefined) {
    return item.blockedReason === undefined ? ALLOWED : blocked(item.blockedReason);
  }
  if (isRecord(moduleBody) && moduleBody['canWrite'] === false) {
    return blocked('V tomto modulu nemáte oprávnění k zápisu.');
  }
  return ALLOWED;
};

/** Czech text for an English framework problem detail (also used for failures stored before this mapping). */
export const czechModuleFailure = (detail: string, status?: number): string => {
  if (status === 409 || /revision|conflict|changed/iu.test(detail)) {
    return 'Záznam se od návrhu změnil nebo už byl vyřízen. Obnovte seznam; zastaralý návrh zamítněte.';
  }
  if (status === 403 || /forbidden|denied|not allowed|permission/iu.test(detail)) {
    return 'K této změně nemáte v modulu oprávnění.';
  }
  if (status === 404 || /not found/iu.test(detail)) {
    return 'Záznam, který návrh mění, nebyl nalezen, nebo k němu nemáte přístup.';
  }
  if (status === 400 || status === 422 || /invalid|malformed/iu.test(detail)) {
    return 'Modul návrh odmítl jako neplatný (údaje neodpovídají jeho pravidlům). Návrh zamítněte a požádejte o nový.';
  }
  if (status !== undefined && status >= 500) {
    return 'Modul teď neodpovídá. Zkuste to prosím za chvíli znovu.';
  }
  return 'Modul změnu odmítl. Návrh zamítněte nebo to zkuste později.';
};

/** English (plain ASCII) problem texts come from the framework; Czech module texts are shown as they are. */
export const isGenericProblemText = (text: string): boolean => /^[\u0020-\u007E]*$/u.test(text);
