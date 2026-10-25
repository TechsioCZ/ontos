/**
 * How the e-shop judges agent proposals for the platform approval queue (the agent review read): the product a
 * command changes, its before -> after lines, the undo plan, whether the change is still in place and whether the
 * person may carry the command out. Pure; the read handler supplies the records read as the person.
 */
import { agentDiffLine, agentEntryWithId, agentFieldLines, agentRecordHolds } from '@app/shared-contracts/agent-diff';
import type { AgentDiffValueOptions } from '@app/shared-contracts/agent-diff';
import type { AgentCommand, AgentDiffLine, AgentRevertPlan } from '@app/shared-contracts/agent-proposals';
import { AGENT_CREATED_ID_PLACEHOLDER, AGENT_REVERT_UNAVAILABLE } from '@app/shared-contracts/agent-proposals';
import type { AgentReviewItem, AgentReviewItemRequest } from '@app/shared-contracts/agent-review';
import { Match, Predicate } from 'effect';
import {
  AGENT_REVERT_MISSING_BEFORE,
  agentRestoredPatch,
  agentRevertCommands,
  agentRevertNone,
} from '@app/shared-contracts/agent-revert';

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

const PRODUCT_LABELS: Readonly<Record<string, string>> = {
  active: 'Aktivní v nabídce',
  category: 'Kategorie',
  description: 'Popis',
  lowStockThreshold: 'Hranice nízké zásoby',
  name: 'Název',
  priceMinor: 'Cena bez DPH',
  sku: 'Kód (SKU)',
  unit: 'Jednotka',
  vatRate: 'Sazba DPH',
};

/** Prices are amounts in haléře. */
const moneyOptions = (fields: Rec): AgentDiffValueOptions => ({
  moneyFields: new Set(Object.keys(fields).filter((key) => key === 'priceMinor' || key.endsWith('PriceMinor'))),
});

/** Commands that change the catalog or prices (records `canManageCatalog`). */
const CATALOG_COMMANDS: ReadonlySet<string> = new Set([
  'ArchiveDemoProduct',
  'BulkUpdateProducts',
  'ChangePrice',
  'CreateProduct',
  'UpdateCategory',
  'UpdateProduct',
]);

const isRevertible = (command: AgentCommand): boolean =>
  Predicate.isTagged(command, 'ChangePrice') ||
  Predicate.isTagged(command, 'UpdateProduct') ||
  Predicate.isTagged(command, 'CreateProduct');

/** Id of the product the command changes when it is one that is read live, undefined otherwise. */
export const targetProductId = (command: AgentCommand): string | undefined => {
  const id = command['id'];
  return Match.value(String(command['_tag'])).pipe(
    Match.whenOr('ChangePrice', 'UpdateProduct', () => (typeof id === 'string' ? id : undefined)),
    Match.orElse(() => undefined),
  );
};

export const productDiff = (command: AgentCommand, before: Rec | undefined): AgentDiffLine[] | undefined =>
  Match.value(command).pipe(
    Match.when({ _tag: 'ChangePrice' }, () => {
      const { variantId } = command;
      const money = { moneyFields: new Set(['priceMinor']) };
      if (typeof variantId === 'string') {
        const variant = agentEntryWithId(before?.['variants'], variantId);
        return [
          agentDiffLine('priceMinor', 'Cena varianty bez DPH', variant?.['priceMinor'], command['priceMinor'], money),
        ];
      }
      return [agentDiffLine('priceMinor', 'Cena bez DPH', before?.['currentPriceMinor'], command['priceMinor'], money)];
    }),
    Match.when({ _tag: 'UpdateProduct' }, () => {
      const { patch } = command;
      return isRecord(patch)
        ? agentFieldLines(patch, PRODUCT_LABELS, before, new Set(), moneyOptions(patch))
        : undefined;
    }),
    Match.when({ _tag: 'CreateProduct' }, () =>
      agentFieldLines(command, PRODUCT_LABELS, undefined, new Set(['id']), moneyOptions(command)),
    ),
    Match.orElse(() => undefined),
  );

export const productRevert = (command: AgentCommand, before: Rec | undefined): AgentRevertPlan =>
  Match.value(command).pipe(
    Match.when({ _tag: 'ChangePrice' }, () => {
      if (before === undefined) return agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
      const id = command['id'];
      const { variantId } = command;
      if (typeof variantId === 'string') {
        const variant = agentEntryWithId(before['variants'], variantId);
        return variant !== undefined && typeof variant['priceMinor'] === 'number'
          ? agentRevertCommands([{ _tag: 'ChangePrice', id, priceMinor: variant['priceMinor'], variantId }])
          : agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
      }
      const price = before['currentPriceMinor'];
      return typeof price === 'number'
        ? agentRevertCommands([{ _tag: 'ChangePrice', id, priceMinor: price }])
        : agentRevertNone(AGENT_REVERT_MISSING_BEFORE);
    }),
    Match.when({ _tag: 'UpdateProduct' }, () => {
      const restored = agentRestoredPatch(command['patch'], before);
      return restored === undefined
        ? agentRevertNone(AGENT_REVERT_MISSING_BEFORE)
        : agentRevertCommands([{ _tag: 'UpdateProduct', id: command['id'], patch: restored }]);
    }),
    Match.when({ _tag: 'CreateProduct' }, () =>
      agentRevertCommands(
        [{ _tag: 'UpdateProduct', id: AGENT_CREATED_ID_PLACEHOLDER, patch: { active: false } }],
        'entityIds.0',
      ),
    ),
    Match.orElse(() => agentRevertNone()),
  );

/** Does the product still hold what the approved command set? Undefined when there is nothing to compare. */
export const productStillInPlace = (command: AgentCommand, current: Rec | undefined): boolean | undefined =>
  Match.value(command).pipe(
    Match.when({ _tag: 'ChangePrice' }, () => {
      if (current === undefined) return false;
      const { variantId } = command;
      if (typeof variantId === 'string') {
        const variant = agentEntryWithId(current['variants'], variantId);
        return variant !== undefined && variant['priceMinor'] === command['priceMinor'];
      }
      return current['currentPriceMinor'] === command['priceMinor'];
    }),
    Match.when({ _tag: 'UpdateProduct' }, () => current !== undefined && agentRecordHolds(command['patch'], current)),
    Match.orElse(() => undefined),
  );

/** What the person's records read says they may change. */
export interface MerchandiseRights {
  readonly canEditOrders?: boolean | undefined;
  readonly canManageCatalog?: boolean | undefined;
  readonly canWrite: boolean;
}

/** Why this person cannot carry out the command (approval runs as them); undefined when they can. */
export const blockedReasonOf = (command: AgentCommand, rights: MerchandiseRights | undefined): string | undefined => {
  if (rights === undefined) {
    return undefined;
  }
  const tag = String(command['_tag']);
  if (!rights.canWrite) {
    return 'V tomto modulu nemáte oprávnění k zápisu.';
  }
  if (CATALOG_COMMANDS.has(tag) && rights.canManageCatalog === false) {
    return 'Změny katalogu a cen schvaluje jen člověk se správou katalogu.';
  }
  if (tag === 'EditOrder' && rights.canEditOrders === false) {
    return 'Úpravy objednávek schvaluje jen člověk s oprávněním k úpravám objednávek.';
  }
  return undefined;
};

/**
 * What the person reading may know about one proposal. `rights` and `product` come from their records read
 * (`rights` undefined: the read failed), `product` is the live product (wire JSON; undefined: not found for them).
 */
export interface ProductReviewInput {
  readonly product: Rec | undefined;
  readonly request: AgentReviewItemRequest;
  readonly rights: MerchandiseRights | undefined;
}

export const reviewProductProposal = ({ product, request, rights }: ProductReviewInput): AgentReviewItem => {
  const { command, key, stage } = request;
  const targeted = targetProductId(command) !== undefined;
  if (stage === 'history') {
    const lines = productDiff(command, undefined);
    return { key, visible: true, ...(lines === undefined ? {} : { diff: lines }) };
  }
  if (stage === 'undo') {
    // Undo only over a product read just now; a failed read leaves the change alone.
    const inPlace = productStillInPlace(command, product);
    return {
      key,
      visible: !targeted || product !== undefined,
      ...(inPlace === undefined ? {} : { stillInPlace: inPlace }),
    };
  }
  const missing = targeted && rights !== undefined && product === undefined;
  const lines = productDiff(command, product);
  const blockedReason = blockedReasonOf(command, rights);
  const name = product?.['name'] ?? product?.['title'];
  return {
    key,
    revert: productRevert(command, product),
    visible: !missing,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(lines === undefined ? {} : { diff: lines }),
    ...(isRevertible(command) ? {} : { revertUnavailableReason: AGENT_REVERT_UNAVAILABLE }),
    ...(typeof name === 'string' && name !== '' ? { targetName: name.slice(0, 300) } : {}),
  };
};
