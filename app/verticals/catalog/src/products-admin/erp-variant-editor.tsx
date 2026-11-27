// Staff dialog for one ERP Variant on Novinky z ERP: its Price and each customer Price Group's Price (Pricing
// revise-price, value only, or define-price for a group without one, under the staff source authority) and its stock on
// hand (Inventory). Each figure goes to its owner; the list reloads afterwards.
import { executeCatalogVariantOnHandPage } from '@app/inventory/api/catalog-variant-on-hand-page-client';
import { GrantStaffStockSourceAuthorityPayloadSchema } from '@app/inventory/api/grant-staff-stock-source-authority';
import { executeGrantStaffStockSourceAuthority } from '@app/inventory/api/grant-staff-stock-source-authority-action-client';
import { executeImportSourceAssertion } from '@app/inventory/api/import-source-assertion-action-client';
import { ImportSourceAssertionPayloadSchema } from '@app/inventory/source-import';
import { executeStockIssue } from '@app/inventory/api/stock-issue-action-client';
import { executeStockReceipt } from '@app/inventory/api/stock-receipt-action-client';
import { CatalogVariantOnHandPageRequestSchema } from '@app/inventory/api/catalog-variant-on-hand-page';
import { executeCatalogPagePrices } from '@app/pricing-contracts/catalog-page-prices/client';
import { CatalogPagePricesRequestSchema } from '@app/pricing-contracts/catalog-page-prices';
import { GrantExternalPriceSourceAuthorityPayloadSchema } from '@app/pricing-contracts/grant-external-price-source-authority';
import { executeGrantExternalPriceSourceAuthority } from '@app/pricing-contracts/grant-external-price-source-authority/client';
import { DefinePricePayloadSchema } from '@app/pricing-contracts/define-price';
import { executeDefinePrice } from '@app/pricing-contracts/define-price/client';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { executePriceSchedule } from '@app/pricing-contracts/price-schedule/client';
import { RevisePricePayloadSchema } from '@app/pricing-contracts/revise-price';
import { executeRevisePrice } from '@app/pricing-contracts/revise-price/client';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { keepDraftOnReload, keptDraft } from '@app/shared-contracts';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';

import type { ProductPageItem } from '../../shared/apis/product-page.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { freshUuid as newUuid, requestId as newRequestId } from './browser-crypto.ts';
import type { ErpOffer } from './erp-offer.ts';
import { readErpPriceGroups } from './erp-price-groups.ts';
import type { ErpPriceGroup } from './erp-price-groups.ts';
import { variantFiguresData } from './page-data.ts';
import { onHandRequestOf, pricesRequestOf } from './products-model.ts';
import { RELOAD_REQUIRED, ReloadRequiredNotice, stepFailure } from './reload-required-notice.tsx';

const freshUuid = newUuid.pipe(Effect.mapError((failure) => `Nelze vytvořit identifikátor (${failure._tag})`));
const requestId = newRequestId.pipe(Effect.mapError((failure) => `Nelze vytvořit identifikátor (${failure._tag})`));

const staffSource = 'ontos-staff-erp-editor';
const staffAuthority = { sourceAuthorityRef: staffSource, sourceAuthorityVersion: '1' } as const;
const staffMapping = { mappingContractRef: staffSource, mappingContractVersion: '1' } as const;
/** A fixed grant start, so a repeated grant for the same key is the same grant. */
const grantFrom = '2020-01-01T00:00:00.000Z';

interface Problem {
  readonly _tag: string;
}
/** Inventory's Physical Stock Effect id: a UUID the caller mints, so a retried effect stays one effect. */
const PhysicalStockEffectIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PhysicalStockEffectId'));

/** Inventory's exact Stock Quantity amount; Inventory checks its canonical form when it decodes the payload. */
const StockAmountSchema = Schema.String.pipe(Schema.brand('ExactStockQuantityAmount'));

const ProblemCodeSchema = Schema.Struct({ code: Schema.String });

/** The owner's problem tag and, when it names one, its code. */
const describe = (step: string, problem: Problem): string => {
  const code = Schema.decodeUnknownOption(ProblemCodeSchema)(problem);
  const detail = Option.isSome(code) ? ` (${code.value.code})` : '';
  return stepFailure(step, problem, detail);
};

type Variant = ProductPageItem['variants'][number];

/** One product holding only this Variant: the owner page reads then answer for it alone. */
const single = (item: ProductPageItem, variant: Variant) => ({ ...item, variants: [variant] });

type PageAnswer = Effect.Success<ReturnType<typeof executeCatalogPagePrices>>;
type PageAnswerPrice = Extract<PageAnswer, { readonly _tag: 'CATALOG_PAGE_PRICED' }>['prices'][number];

const foundOf = (price: PageAnswerPrice) =>
  Match.valueTags(price, {
    NO_APPLICABLE_PRICE: () => [],
    PRICE_FOUND: (found) => [found],
    PRICING_CONFIGURATION_ERROR: () => [],
    PRICING_CONFLICT: () => [],
    PRICING_INDETERMINATE: () => [],
  });

const foundPrices = (answer: PageAnswer) =>
  Match.valueTags(answer, {
    CATALOG_PAGE_PRICED: ({ prices }) => prices.flatMap(foundOf),
    CURRENCY_SUPPORT_NOT_CURRENT: () => [],
  });

/** Pricing's answer for the Variant's Price, or with a group for that Price Group's own key (no fallback). */
const readPriceAnswer = (item: ProductPageItem, variant: Variant, offer: ErpOffer, group?: ErpPriceGroup) =>
  Schema.decodeUnknownEffect(CatalogPagePricesRequestSchema)({
    ...pricesRequestOf(offer, single(item, variant)),
    ...(group === undefined ? {} : { priceGroupRef: group.priceGroupRef }),
  }).pipe(
    Effect.mapError((problem) => describe('Čtení ceny', problem)),
    Effect.flatMap((request) =>
      requestId.pipe(
        Effect.flatMap((id) =>
          executeCatalogPagePrices(request, id).pipe(Effect.mapError((problem) => describe('Čtení ceny', problem))),
        ),
      ),
    ),
  );

const readPrice = (item: ProductPageItem, variant: Variant, offer: ErpOffer) =>
  readPriceAnswer(item, variant, offer).pipe(
    Effect.map((answer) => {
      const [found] = foundPrices(answer);
      return found;
    }),
  );

const readStock = (item: ProductPageItem, variant: Variant, offer: ErpOffer) =>
  Schema.decodeUnknownEffect(CatalogVariantOnHandPageRequestSchema)(onHandRequestOf(offer, single(item, variant))).pipe(
    Effect.mapError((problem) => describe('Čtení skladu', problem)),
    Effect.flatMap((request) =>
      requestId.pipe(
        Effect.flatMap((id) =>
          executeCatalogVariantOnHandPage(request, id).pipe(
            Effect.mapError((problem) => describe('Čtení skladu', problem)),
          ),
        ),
      ),
    ),
  );

type PriceFound = NonNullable<Effect.Success<ReturnType<typeof readPrice>>>;

interface GroupPrice {
  readonly group: ErpPriceGroup;
  /** The group's own Price of the Variant; none when Pricing has no Price under the group's key yet. */
  readonly price: PriceFound | undefined;
  /** Why the group's Price could not be read: the row is shown, and never offered a new Price. */
  readonly problem?: string;
}

const groupPriceOf = (group: ErpPriceGroup, answer: PageAnswer): GroupPrice => {
  const unreadable = (problem: string): GroupPrice => ({ group, price: undefined, problem });
  return Match.valueTags(answer, {
    CATALOG_PAGE_PRICED: ({ prices }) => {
      const [price] = prices;
      return price === undefined
        ? unreadable('bez odpovědi')
        : Match.valueTags(price, {
            NO_APPLICABLE_PRICE: (): GroupPrice => ({ group, price: undefined }),
            PRICE_FOUND: (found): GroupPrice => ({ group, price: found }),
            PRICING_CONFIGURATION_ERROR: ({ _tag }) => unreadable(_tag),
            PRICING_CONFLICT: ({ _tag }) => unreadable(_tag),
            PRICING_INDETERMINATE: ({ _tag }) => unreadable(_tag),
          });
    },
    CURRENCY_SUPPORT_NOT_CURRENT: ({ _tag }) => unreadable(_tag),
  });
};

/**
 * The Variant's Price in each of the company's Price Groups (the group's own key, whichever source wrote it last). The
 * group list itself must load: a company whose groups cannot be read fails the dialog instead of hiding them.
 */
const readGroupPrices = (item: ProductPageItem, variant: Variant, offer: ErpOffer) =>
  requestId.pipe(
    Effect.flatMap((id) => readErpPriceGroups(offer, id)),
    Effect.flatMap((groups) =>
      Effect.forEach(
        groups,
        (group) =>
          readPriceAnswer(item, variant, offer, group).pipe(
            Effect.map((answer) => groupPriceOf(group, answer)),
            Effect.catch((error: string) => Effect.succeed<GroupPrice>({ group, price: undefined, problem: error })),
          ),
        { concurrency: 4 },
      ),
    ),
  );
type StockPage = Effect.Success<ReturnType<typeof readStock>>;

/**
 * The staff source's authority for one exact Price key, from a fixed start. Pricing answers a repeated grant of the same
 * key and terms as the grant it already holds, so every save may ask again.
 */
const grantStaffSource = Effect.fn('ErpVariantEditor.grantStaffSource')(function* grant(
  identityKey: PriceIdentityKey,
  reason: string,
) {
  const [id, grantKey] = yield* Effect.all([requestId, freshUuid], { concurrency: 1 });
  return yield* Schema.decodeEffect(GrantExternalPriceSourceAuthorityPayloadSchema)({
    authority: staffAuthority,
    effectivePeriod: { effectiveFrom: grantFrom },
    exactIdentityKey: identityKey,
    mapping: staffMapping,
    reason,
    verificationRef: staffSource,
  }).pipe(
    Effect.flatMap((payload) => executeGrantExternalPriceSourceAuthority(payload, id, { idempotencyKey: grantKey })),
    Effect.mapError((problem) => describe('Oprávnění zdroje ceny', problem)),
  );
});

/** The staff source's assertion of one amount at one instant (Pricing requires all three timings to be that instant). */
const staffAssertion = Effect.fn('ErpVariantEditor.staffAssertion')(function* assertion(
  sourceRecordRef: string,
  monetaryAmount: { readonly amount: string; readonly currencyCode: string },
  unitBasis: PriceIdentityKey['unitBasis'],
  at: string,
) {
  const [sourceAssertionId, version] = yield* Effect.all([freshUuid, freshUuid], { concurrency: 1 });
  return {
    lineage: { kind: 'INITIAL' as const },
    mapping: staffMapping,
    originalAssertion: { monetaryAmount, monetaryBoundary: 'PRE_TAX' as const, unitBasis },
    sourceAssertionId,
    sourceAuthority: staffAuthority,
    sourceRecord: {
      sourceChangeCorrelation: `ontos-admin:${version}`,
      sourceRecordRef,
      sourceRecordVersion: version,
      sourceSystem: { ownerModuleId: 'commerce.catalog', sourceSystemRef: staffSource },
    },
    timing: { importedAt: at, ownerBusinessEffectiveAt: at, sourceEffectiveAt: at },
  };
});

/** Pricing's Current Revision of the Price, revised value-only under the staff source authority. */
const revisePrice = Effect.fn('ErpVariantEditor.revisePrice')(function* revise(
  found: PriceFound,
  amount: string,
  reason: string,
) {
  const id = yield* requestId;
  const schedule = yield* executePriceSchedule({ priceRef: found.priceRef }, id).pipe(
    Effect.mapError((problem) => describe('Rozvrh ceny', problem)),
  );
  if (schedule.outcome !== 'PRICE_SCHEDULE_CURRENT' || schedule.schedule.current === undefined) {
    return yield* Effect.fail(`Cena nemá platnou aktuální revizi (${schedule.outcome})`);
  }
  const { current } = schedule.schedule;
  const { identityKey } = current.definition;
  yield* grantStaffSource(identityKey, reason);
  // Pricing takes a value-only change at the stated effectiveFrom and requires the assertion's business time to be
  // that same instant. It must not be after the server's operation time (a few seconds back absorbs clock skew) and
  // not before the Current Revision it replaces.
  const skewed = DateTime.subtract(yield* DateTime.now, { seconds: 5 });
  const currentFrom = DateTime.make(current.effectivePeriod.effectiveFrom);
  const now = DateTime.formatIso(
    Option.isSome(currentFrom) && DateTime.isLessThanOrEqualTo(skewed, currentFrom.value)
      ? DateTime.add(currentFrom.value, { milliseconds: 1 })
      : skewed,
  );
  const revisionKey = yield* freshUuid;
  const monetaryAmount = { amount, currencyCode: identityKey.currencyCode };
  const sourceAssertion = yield* staffAssertion(found.priceRef.resourceId, monetaryAmount, identityKey.unitBasis, now);
  const reviseId = yield* requestId;
  const result = yield* Schema.decodeEffect(RevisePricePayloadSchema)({
    effectiveFrom: now,
    expectedCurrent: {
      effectivePeriod: current.effectivePeriod,
      priceRef: found.priceRef,
      revision: current.definition.revision.revision,
      revisionId: current.definition.revision.revisionId,
      scheduleRevision: schedule.schedule.scheduleRevision,
    },
    intent: 'VALUE_ONLY_CURRENT',
    monetaryAmount,
    priceRef: found.priceRef,
    reason,
    sourceAssertion,
  }).pipe(
    Effect.flatMap((payload) => executeRevisePrice(payload, reviseId, { idempotencyKey: revisionKey })),
    Effect.mapError((problem) => describe('Změna ceny', problem)),
  );
  return result;
});

/**
 * A first Price for a customer Price Group the Variant has none in: the key of a Price the Variant has, with the group's
 * selector, under the staff source authority, effective a few seconds back to absorb clock skew. A later ERP price for
 * the same key supersedes it, and a later staff edit revises it.
 */
const defineGroupPrice = Effect.fn('ErpVariantEditor.defineGroupPrice')(function* define(
  keyPrice: PriceFound,
  group: ErpPriceGroup,
  amount: string,
  reason: string,
) {
  const id = yield* requestId;
  const schedule = yield* executePriceSchedule({ priceRef: keyPrice.priceRef }, id).pipe(
    Effect.mapError((problem) => describe('Rozvrh ceny', problem)),
  );
  if (schedule.outcome !== 'PRICE_SCHEDULE_CURRENT' || schedule.schedule.current === undefined) {
    return yield* Effect.fail(`Cena nemá platnou aktuální revizi (${schedule.outcome})`);
  }
  const identityKey: PriceIdentityKey = {
    ...schedule.schedule.current.definition.identityKey,
    priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: group.priceGroupRef },
  };
  yield* grantStaffSource(identityKey, reason);
  const now = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { seconds: 5 }));
  const [priceId, defineKey] = yield* Effect.all([freshUuid, freshUuid], { concurrency: 1 });
  const monetaryAmount = { amount, currencyCode: identityKey.currencyCode };
  const sourceAssertion = yield* staffAssertion(priceId, monetaryAmount, identityKey.unitBasis, now);
  const defineId = yield* requestId;
  const step = `Nová cena skupiny ${group.label}`;
  const result = yield* Schema.decodeEffect(DefinePricePayloadSchema)({
    effectiveFrom: now,
    identityKey,
    monetaryAmount,
    priceRef: { ...keyPrice.priceRef, resourceId: priceId },
    reason,
    sourceAssertion,
  }).pipe(
    Effect.flatMap((payload) => executeDefinePrice(payload, defineId, { idempotencyKey: defineKey })),
    Effect.mapError((problem) => describe(step, problem)),
  );
  if (!('outcome' in result)) {
    return yield* Effect.fail(`${step} čeká na schválení`);
  }
  if (result.outcome !== 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED') {
    return yield* Effect.fail(`${step}: Ceny ji nepřijaly (${'reason' in result ? result.reason : result.dependency})`);
  }
  return result;
});

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
/** A canonical decimal text: no leading zeros, no trailing fractional zeros; null when it is no decimal. */
const canonical = (value: string): string | null => {
  const trimmed = value.trim().replace(',', '.');
  if (!decimalPattern.test(trimmed)) {
    return null;
  }
  return trimmed.includes('.') ? trimmed.replace(/0+$/u, '').replace(/\.$/u, '') : trimmed;
};

type StockAnswer = Extract<StockPage['items'][number], { readonly outcome: 'ON_HAND' | 'ON_HAND_UNKNOWN' }>;

/**
 * An ERP-held Position: Inventory grants the staff source authority for exactly this Position (the ERP keys, the next
 * ordering evidence and the effects to cover), then the typed figure is imported as the source-reported on-hand.
 * The business observation and the receipt are one instant, a few seconds back to absorb clock skew.
 */
const writeSourceStock = Effect.fn('ErpVariantEditor.writeSourceStock')(function* sourceStock(
  positionRef: StockAnswer['positions'][number]['positionRef'],
  unitRef: StockAnswer['stockItem']['unitRef'],
  target: string,
  offer: ErpOffer,
  reason: string,
) {
  const [grantKey, importKey, assertionId, evidence] = yield* Effect.all([freshUuid, freshUuid, freshUuid, freshUuid], {
    concurrency: 1,
  });
  const grantId = yield* requestId;
  const grant = yield* Schema.decodeEffect(GrantStaffStockSourceAuthorityPayloadSchema)({
    customerConfigurationId: offer.customerConfigurationId,
    positionRef,
    reason: reason.slice(0, 300).trim(),
  }).pipe(
    Effect.mapError((problem) => describe('Oprávnění zdroje skladu', problem)),
    Effect.flatMap((payload) =>
      executeGrantStaffStockSourceAuthority(payload, grantId, { idempotencyKey: grantKey }).pipe(
        Effect.mapError((problem) => describe('Oprávnění zdroje skladu', problem)),
      ),
    ),
  );
  if (!('issuer' in grant)) {
    return yield* Effect.fail('Oprávnění zdroje skladu čeká na schválení');
  }
  const now = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { seconds: 5 }));
  const at = now < grant.selectedAt ? grant.selectedAt : now;
  const importId = yield* requestId;
  const imported = yield* Schema.decodeEffect(ImportSourceAssertionPayloadSchema)({
    authorizationTargetRef: positionRef,
    items: [
      {
        assertionId,
        businessObservedAt: at,
        coverage: grant.coverageEffectIds.map((effectId) => ({
          assertionId,
          effectId,
          ownerEvidenceRef: `ontos-staff:${evidence}`,
          relation: 'INCLUDES',
        })),
        customerConfigurationId: offer.customerConfigurationId,
        factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
        issuer: grant.issuer,
        itemExternalKey: grant.itemExternalKey,
        locationExternalKey: grant.locationExternalKey,
        orderingEvidence: grant.orderingEvidence,
        ownerEvidenceRef: `ontos-staff:${evidence}`,
        positionRef,
        quantity: { amount: target, unitRef },
        receivedAt: at,
        sourceReference: `ontos-staff:${assertionId}`,
      },
    ],
  }).pipe(
    Effect.mapError((problem) => describe('Zápis skladu', problem)),
    Effect.flatMap((payload) =>
      executeImportSourceAssertion(payload, importId, { idempotencyKey: importKey }).pipe(
        Effect.mapError((problem) => describe('Zápis skladu', problem)),
      ),
    ),
  );
  if (!('items' in imported)) {
    return yield* Effect.fail('Zápis skladu čeká na schválení');
  }
  const [outcome] = imported.items;
  if (outcome === undefined || outcome.status !== 'ACCEPTED') {
    return yield* Effect.fail(`Sklad nepřijal nový stav (${outcome?.status ?? 'bez odpovědi'})`);
  }
  return outcome;
});

/** Sets the on-hand figure of the Variant's one Position: a receipt or an issue of the difference (OntOS WMS). */
const writeStock = Effect.fn('ErpVariantEditor.writeStock')(function* stock(
  page: StockPage,
  target: string,
  offer: ErpOffer,
  reason: string,
) {
  const [answer] = page.items;
  if (answer === undefined || (answer.outcome !== 'ON_HAND' && answer.outcome !== 'ON_HAND_UNKNOWN')) {
    return yield* Effect.fail(`Varianta nemá skladovou pozici (${answer?.outcome ?? 'bez odpovědi'})`);
  }
  const [position] = answer.positions;
  if (page.backend.kind === 'external_business_system') {
    return yield* writeSourceStock(position.positionRef, answer.stockItem.unitRef, target, offer, reason);
  }
  const current = Match.valueTags(position.onHand, {
    NOT_ESTABLISHED: () => 0,
    OWNER_RECORDED: ({ quantity }) => Number(quantity.amount),
    SOURCE_REPORTED: ({ quantity }) => Number(quantity.amount),
  });
  const delta = Number(target) - current;
  if (delta === 0) {
    return yield* Effect.void;
  }
  const amount = canonical(String(Math.abs(Math.round(delta * 1000) / 1000)));
  const [effectId, key] = yield* Effect.all([freshUuid, freshUuid], { concurrency: 1 });
  const [brandedEffectId, brandedAmount] = yield* Effect.all(
    [Schema.decodeEffect(PhysicalStockEffectIdSchema)(effectId), Schema.decodeEffect(StockAmountSchema)(amount ?? '0')],
    { concurrency: 1 },
  ).pipe(Effect.mapError((problem) => describe('Změna skladu', problem)));
  const decoded = {
    customerConfigurationId: offer.customerConfigurationId,
    effectId: brandedEffectId,
    positionRef: position.positionRef,
    quantity: { amount: brandedAmount, unitRef: answer.stockItem.unitRef },
    reason: { code: delta > 0 ? 'STAFF_RECEIPT' : 'STAFF_ISSUE', reference: reason.slice(0, 300) },
    stockItemRef: answer.stockItem.stockItemRef,
  };
  const id = yield* requestId;
  return yield* delta > 0
    ? executeStockReceipt(decoded, id, { idempotencyKey: key }).pipe(
        Effect.mapError((problem) => describe('Příjem na sklad', problem)),
      )
    : executeStockIssue(decoded, id, { idempotencyKey: key }).pipe(
        Effect.mapError((problem) => describe('Výdej ze skladu', problem)),
      );
});

/** The name a reload that keeps drafts gives this Variant's dialog; the list reopens the dialog when one was kept. */
export const erpVariantKeepKey = (variantId: string) => `catalog:erp-variant:${variantId}`;

const DEFAULT_REASON = 'Úprava ceny a skladu v administraci';

/** The figures the user changed in the dialog, kept across a reload; the others come from the owners again. */
interface KeptFigures {
  readonly amount?: string;
  readonly groupAmounts?: Readonly<Record<string, string>>;
  readonly reason?: string;
  readonly stock?: string;
}

/** The Price whose key a group without a Price takes its new one under: the Variant's own, else any group's. */
const keyPriceOf = (loaded: Loaded): PriceFound | undefined =>
  loaded.price ?? loaded.groups.find(({ price }) => price !== undefined)?.price;

interface ErpVariantEditorProps {
  readonly item: ProductPageItem;
  readonly offer: ErpOffer;
  readonly onClose: () => void;
  readonly variantId: string;
}

interface Loaded {
  readonly groups: readonly GroupPrice[];
  readonly price: PriceFound | undefined;
  readonly stock: StockPage;
}

/** The figures the dialog opens with: what the owners answered for the price, each group price and the stock. */
const loadedFigures = (value: Loaded) => {
  const [answer] = value.stock.items;
  return {
    amount: value.price?.priceRevision.monetaryAmount.amount ?? '',
    groupAmounts: Object.fromEntries(
      value.groups.flatMap(({ group, price }) =>
        price === undefined
          ? []
          : [[group.priceGroupRef.resourceId, price.priceRevision.monetaryAmount.amount] as const],
      ),
    ),
    stock: answer?.outcome === 'ON_HAND' ? answer.total.amount : '',
  };
};

/** The figures the user typed that differ from what the owners answered. */
const editedFigures = (
  value: Loaded,
  typed: { readonly amount: string; readonly groupAmounts: Readonly<Record<string, string>>; readonly stock: string },
): KeptFigures => {
  const figures = loadedFigures(value);
  const changedGroups = Object.fromEntries(
    Object.entries(typed.groupAmounts).filter(([id, amount]) => figures.groupAmounts[id] !== amount),
  );
  return {
    ...(typed.amount === figures.amount ? {} : { amount: typed.amount }),
    ...(Object.keys(changedGroups).length === 0 ? {} : { groupAmounts: changedGroups }),
    ...(typed.stock === figures.stock ? {} : { stock: typed.stock }),
  };
};

export const ErpVariantEditor = ({ item, offer, onClose, variantId }: ErpVariantEditorProps) => {
  const variant = item.variants.find(({ variantRef }) => variantRef.resourceId === variantId);
  const keepKey = erpVariantKeepKey(variantId);
  const [kept] = useState(() => keptDraft<KeptFigures>(keepKey));
  // Figures a reload kept go over the first figures the owners answer with, once.
  const keptFigures = useRef(kept);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [amount, setAmount] = useState('');
  const [stock, setStock] = useState('');
  const [groupAmounts, setGroupAmounts] = useState<Readonly<Record<string, string>>>({});
  const [reason, setReason] = useState(() => kept?.reason ?? DEFAULT_REASON);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // What the dialog last loaded and what the user has typed, so a re-read (the list reloads after every save,
  // failed or not) refreshes the owners' figures without wiping the figures the user changed.
  const loadedRef = useRef<Loaded | null>(null);
  const typedRef = useRef({ amount, groupAmounts, stock });
  typedRef.current = { amount, groupAmounts, stock };
  useEffect(() => {
    if (variant === undefined) {
      return;
    }
    browserRuntime.runFork(
      Effect.all(
        {
          groups: readGroupPrices(item, variant, offer),
          price: readPrice(item, variant, offer),
          stock: readStock(item, variant, offer),
        },
        { concurrency: 3 },
      ).pipe(
        Effect.match({
          onFailure: (text: string) => setFailure(text),
          onSuccess: (value) => {
            const figures = loadedFigures(value);
            const previous = loadedRef.current;
            const restored = previous === null ? keptFigures.current : editedFigures(previous, typedRef.current);
            keptFigures.current = undefined;
            loadedRef.current = value;
            setLoaded(value);
            setAmount(restored?.amount ?? figures.amount);
            setGroupAmounts({ ...figures.groupAmounts, ...restored?.groupAmounts });
            setStock(restored?.stock ?? figures.stock);
          },
        }),
      ),
    );
  }, [item, offer, variant]);
  useEffect(
    () =>
      keepDraftOnReload(keepKey, () => {
        if (loaded === null) {
          return undefined;
        }
        const changed: KeptFigures = {
          ...editedFigures(loaded, { amount, groupAmounts, stock }),
          ...(reason === DEFAULT_REASON ? {} : { reason }),
        };
        return Object.keys(changed).length === 0 ? undefined : changed;
      }),
    [amount, groupAmounts, keepKey, loaded, reason, stock],
  );
  const save = () => {
    if (loaded === null || variant === undefined) {
      return;
    }
    const why = reason.trim();
    if (why === '') {
      setFailure('Vyplňte důvod změny.');
      return;
    }
    const nextAmount = canonical(amount);
    const nextStock = canonical(stock);
    const priceChanged =
      loaded.price !== undefined &&
      nextAmount !== null &&
      nextAmount !== canonical(loaded.price.priceRevision.monetaryAmount.amount);
    const [first] = loaded.stock.items;
    const stockChanged =
      nextStock !== null && !(first?.outcome === 'ON_HAND' && canonical(first.total.amount) === nextStock);
    const keyPrice = keyPriceOf(loaded);
    const groupChanges = loaded.groups.flatMap(({ group, price, problem }) => {
      const next = canonical(groupAmounts[group.priceGroupRef.resourceId] ?? '');
      if (next === null || problem !== undefined) {
        return [];
      }
      if (price !== undefined) {
        // Owners answer amounts with trailing zeros ("4.690000000"); only a different value is a change.
        return next === canonical(price.priceRevision.monetaryAmount.amount)
          ? []
          : [Effect.asVoid(revisePrice(price, next, why))];
      }
      return keyPrice === undefined ? [] : [Effect.asVoid(defineGroupPrice(keyPrice, group, next, why))];
    });
    const badGroup = loaded.groups.some(({ group }) => {
      const typed = groupAmounts[group.priceGroupRef.resourceId] ?? '';
      return typed.trim() !== '' && canonical(typed) === null;
    });
    if (badGroup || (amount.trim() !== '' && nextAmount === null) || (stock.trim() !== '' && nextStock === null)) {
      setFailure('Cena i sklad musí být nezáporná čísla.');
      return;
    }
    setBusy(true);
    setFailure(null);
    const steps = [
      ...(priceChanged && loaded.price !== undefined && nextAmount !== null
        ? [Effect.asVoid(revisePrice(loaded.price, nextAmount, why))]
        : []),
      ...groupChanges,
      ...(stockChanged ? [Effect.asVoid(writeStock(loaded.stock, nextStock, offer, why))] : []),
    ];
    browserRuntime.runFork(
      Effect.forEach(steps, (step) => step, { concurrency: 1, discard: true }).pipe(
        Effect.match({
          onFailure: (text: string) => {
            setBusy(false);
            setFailure(text === RELOAD_REQUIRED ? text : `Uložení se nezdařilo – ${text}.`);
            variantFiguresData.invalidate();
          },
          onSuccess: () => {
            setBusy(false);
            variantFiguresData.invalidate();
            onClose();
          },
        }),
      ),
    );
  };
  const currency = loaded?.price?.priceRevision.monetaryAmount.currencyCode ?? offer.currencyCode;
  const keyPrice = loaded === null ? undefined : keyPriceOf(loaded);
  return (
    <Dialog
      actions={
        <div className="flex w-full flex-wrap justify-end gap-100">
          <Button disabled={busy} onClick={onClose} theme="outlined" type="button" variant="secondary">
            Zrušit
          </Button>
          <Button
            disabled={loaded === null}
            isLoading={busy}
            loadingText="Ukládám…"
            onClick={save}
            type="button"
            variant="primary"
          >
            Uložit
          </Button>
        </div>
      }
      closeLabel="Zavřít"
      customTrigger
      onOpenChange={({ open }) => {
        if (!open && !busy) {
          onClose();
        }
      }}
      open
      size="md"
      title={`Cena a sklad: ${variant?.sku ?? variantId.slice(0, 8)}`}
    >
      <div className="flex flex-col gap-200">
        {loaded === null && failure === null && <StatusText status="default">Načítám cenu a sklad…</StatusText>}
        {loaded !== null && (
          <>
            {loaded.price === undefined ? (
              <span className="text-fg-secondary text-sm">Varianta nemá v Cenách cenu pro tuto nabídku.</span>
            ) : (
              <label className="flex flex-col gap-50 text-sm" htmlFor="erp-variant-price">
                <span className="font-medium">Cena bez DPH ({currency})</span>
                <Input
                  id="erp-variant-price"
                  inputMode="decimal"
                  onChange={(event) => setAmount(event.target.value)}
                  size="sm"
                  value={amount}
                />
              </label>
            )}
            {loaded.groups.length > 0 && (
              <div className="flex flex-col gap-100 text-sm" data-testid="erp-variant-group-prices">
                <span className="font-medium">Ceny cenových skupin bez DPH ({currency})</span>
                {loaded.groups.map(({ group, price, problem }) => {
                  const inputId = `erp-group-price-${group.priceGroupRef.resourceId}`;
                  // A group without a Price gets an empty field: a typed amount becomes its new Price.
                  return problem === undefined && (price !== undefined || keyPrice !== undefined) ? (
                    <label className="flex items-center justify-between gap-100" htmlFor={inputId} key={inputId}>
                      <span>{group.label}</span>
                      <Input
                        aria-label={`Cena skupiny ${group.label}`}
                        id={inputId}
                        inputMode="decimal"
                        onChange={(event) => {
                          const { value } = event.target;
                          setGroupAmounts((current) => ({ ...current, [group.priceGroupRef.resourceId]: value }));
                        }}
                        {...(price === undefined ? { placeholder: 'Bez ceny' } : {})}
                        size="sm"
                        value={groupAmounts[group.priceGroupRef.resourceId] ?? ''}
                      />
                    </label>
                  ) : (
                    <div className="flex items-center justify-between gap-100" key={inputId}>
                      <span>{group.label}</span>
                      <span className="text-fg-secondary">
                        {problem === undefined ? 'Bez ceny' : `Cenu nelze načíst (${problem})`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <label className="flex flex-col gap-50 text-sm" htmlFor="erp-variant-stock">
              <span className="font-medium">Skladem (ks)</span>
              <Input
                id="erp-variant-stock"
                inputMode="decimal"
                onChange={(event) => setStock(event.target.value)}
                size="sm"
                value={stock}
              />
            </label>
            <label className="flex flex-col gap-50 text-sm" htmlFor="erp-variant-reason">
              <span className="font-medium">Důvod změny</span>
              <Input
                id="erp-variant-reason"
                maxLength={300}
                onChange={(event) => setReason(event.target.value)}
                size="sm"
                value={reason}
              />
            </label>
          </>
        )}
        {failure === RELOAD_REQUIRED && <ReloadRequiredNotice />}
        {failure !== null && failure !== RELOAD_REQUIRED && (
          <StatusText showIcon status="error">
            {failure}
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};
