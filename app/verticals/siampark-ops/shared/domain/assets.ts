// Siampark provoz — agenda `assets` (S02 majetek, revize a inventura + S03 odpisové plány).
// OWNED BY THE `assets` LANE (ops-assets). Keeps exporting AssetsStateSchema and emptyAssetsState.
// Old JSONB rows must still decode: new top-level collections are `Schema.optionalKey(...)`.
// Depreciation here is EVIDENCE of approved values, never a legal or tax calculation (S03 „Nedělat“).
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import {
  AuditFieldsSchema,
  IsoDateSchema,
  MinorAmountSchema,
  NoteSchema,
  PropertyRefSchema,
  TextSchema,
  opsIdOf,
} from './common.ts';

export const AssetIdSchema = opsIdOf('SiamparkAssetId');
export type AssetId = typeof AssetIdSchema.Type;

/** budova / technologie / vybavení */
export const AssetKindSchema = Schema.Literals(['building', 'technology', 'equipment']);
export type AssetKind = typeof AssetKindSchema.Type;
export const assetKinds: readonly AssetKind[] = ['building', 'technology', 'equipment'];

export const AssetStatusSchema = Schema.Literals(['active', 'disposed']);
export type AssetStatus = typeof AssetStatusSchema.Type;

export const AcquisitionMethodSchema = Schema.Literals(['purchase', 'construction', 'transfer', 'donation', 'leasing']);
export type AcquisitionMethod = typeof AcquisitionMethodSchema.Type;
export const acquisitionMethods: readonly AcquisitionMethod[] = [
  'purchase',
  'construction',
  'transfer',
  'donation',
  'leasing',
];

export const DisposalKindSchema = Schema.Literals(['sale', 'retirement', 'liquidation']);
export type DisposalKind = typeof DisposalKindSchema.Type;
export const disposalKinds: readonly DisposalKind[] = ['sale', 'retirement', 'liquidation'];

/** Manually kept timeline entry (pořízení, zařazení, změna hodnoty, stavební a vlastnické události, vyřazení). */
export const AssetEventKindSchema = Schema.Literals([
  'acquisition',
  'placed_in_service',
  'value_change',
  'construction',
  'ownership',
  'note',
  'sale',
  'retirement',
  'liquidation',
]);
export type AssetEventKind = typeof AssetEventKindSchema.Type;
/** Event kinds a user may record directly (the rest come from dedicated commands). */
export const manualEventKinds = ['placed_in_service', 'construction', 'ownership', 'note'] as const;
export const ManualEventKindSchema = Schema.Literals(manualEventKinds);

export const AssetEventSchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  date: IsoDateSchema,
  documentRef: Schema.optionalKey(TextSchema(300)),
  id: TextSchema(300),
  kind: AssetEventKindSchema,
  newValueMinor: Schema.optionalKey(MinorAmountSchema),
  note: NoteSchema,
  previousValueMinor: Schema.optionalKey(MinorAmountSchema),
});
export type AssetEvent = typeof AssetEventSchema.Type;

/** revize / servisní zásah / kontrola / řízení či povolení */
export const ServiceKindSchema = Schema.Literals(['revision', 'service', 'inspection', 'permit']);
export type ServiceKind = typeof ServiceKindSchema.Type;
export const serviceKinds: readonly ServiceKind[] = ['revision', 'service', 'inspection', 'permit'];
export const ServiceResultSchema = Schema.Literals(['ok', 'defects', 'failed']);
export type ServiceResult = typeof ServiceResultSchema.Type;
export const PermitStateSchema = Schema.Literals(['requested', 'in_progress', 'granted', 'rejected', 'expired']);
export type PermitState = typeof PermitStateSchema.Type;

export const ServiceRecordSchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  documentRef: Schema.optionalKey(TextSchema(300)),
  id: TextSchema(300),
  kind: ServiceKindSchema,
  /** Next revision / check / permit deadline. Feeds the operations calendar. */
  nextDueOn: Schema.optionalKey(IsoDateSchema),
  note: Schema.optionalKey(NoteSchema),
  performedOn: Schema.optionalKey(IsoDateSchema),
  permitState: Schema.optionalKey(PermitStateSchema),
  responsible: Schema.optionalKey(TextSchema(200)),
  result: Schema.optionalKey(ServiceResultSchema),
  supplier: Schema.optionalKey(TextSchema(200)),
  title: TextSchema(200),
});
export type ServiceRecord = typeof ServiceRecordSchema.Type;

export const DepreciationTypeSchema = Schema.Literals(['accounting', 'tax']);
export type DepreciationType = typeof DepreciationTypeSchema.Type;
export const DepreciationIntervalSchema = Schema.Literals(['monthly', 'yearly']);
export type DepreciationInterval = typeof DepreciationIntervalSchema.Type;
export const PlanStatusSchema = Schema.Literals(['draft', 'confirmed']);
export type PlanStatus = typeof PlanStatusSchema.Type;
export const YearsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100));
/** `YYYY` (yearly) or `YYYY-MM` (monthly). */
export const PeriodSchema = Schema.String.check(Schema.isPattern(/^\d{4}(-(0[1-9]|1[0-2]))?$/));

/** One manually approved depreciation amount (S03: „ručně potvrzené částky“). */
export const DepreciationEntrySchema = Schema.Struct({
  amountMinor: MinorAmountSchema,
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  documentRef: Schema.optionalKey(TextSchema(300)),
  id: TextSchema(300),
  note: Schema.optionalKey(NoteSchema),
  /** Odpis části hodnoty (e.g. partial write-off after damage). */
  partial: Schema.optionalKey(Schema.Boolean),
  period: PeriodSchema,
});
export type DepreciationEntry = typeof DepreciationEntrySchema.Type;

export const PlanHistoryEntrySchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  change: Schema.Literals(['created', 'confirmed', 'entry_recorded']),
  note: Schema.optionalKey(NoteSchema),
});
export type PlanHistoryEntry = typeof PlanHistoryEntrySchema.Type;

export const DepreciationPlanSchema = Schema.Struct({
  baseMinor: MinorAmountSchema,
  createdAt: Schema.DateTimeUtcFromString,
  createdBy: PrincipalRefSchema,
  entries: Schema.Array(DepreciationEntrySchema),
  history: Schema.Array(PlanHistoryEntrySchema),
  id: TextSchema(300),
  interval: DepreciationIntervalSchema,
  /** Free text or a catalogue choice, e.g. „rovnoměrný“, „zrychlený“, „komponentní“. */
  method: TextSchema(120),
  note: Schema.optionalKey(NoteSchema),
  startDate: IsoDateSchema,
  status: PlanStatusSchema,
  taxGroup: Schema.optionalKey(TextSchema(40)),
  templateId: Schema.optionalKey(TextSchema(300)),
  type: DepreciationTypeSchema,
  years: YearsSchema,
});
export type DepreciationPlan = typeof DepreciationPlanSchema.Type;

export const DisposalSchema = Schema.Struct({
  date: IsoDateSchema,
  documentRef: Schema.optionalKey(TextSchema(300)),
  kind: DisposalKindSchema,
  proceedsMinor: Schema.optionalKey(MinorAmountSchema),
  reason: TextSchema(2000),
});
export type Disposal = typeof DisposalSchema.Type;

export const AssetSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  acquisitionDate: Schema.optionalKey(IsoDateSchema),
  acquisitionMethod: Schema.optionalKey(AcquisitionMethodSchema),
  acquisitionValueMinor: Schema.optionalKey(MinorAmountSchema),
  /** Identifier of the external accounting product card; absent = „nenapojeno“. */
  accountingProduct: Schema.optionalKey(TextSchema(200)),
  category: TextSchema(120),
  /** Last confirmed current value (S02-02); history in `events` (value_change). */
  currentValueMinor: Schema.optionalKey(MinorAmountSchema),
  currentValueDate: Schema.optionalKey(IsoDateSchema),
  depreciationPlans: Schema.optionalKey(Schema.Array(DepreciationPlanSchema)),
  disposal: Schema.optionalKey(DisposalSchema),
  events: Schema.optionalKey(Schema.Array(AssetEventSchema)),
  id: AssetIdSchema,
  inventoryNumber: TextSchema(64),
  kind: Schema.optionalKey(AssetKindSchema),
  location: Schema.optionalKey(PropertyRefSchema),
  name: TextSchema(200),
  note: Schema.optionalKey(NoteSchema),
  placedInServiceDate: Schema.optionalKey(IsoDateSchema),
  /** siampark-property property id the asset belongs to (also when `location` is a unit). */
  propertyId: Schema.optionalKey(TextSchema(300)),
  responsible: Schema.optionalKey(TextSchema(200)),
  serialNumber: Schema.optionalKey(TextSchema(120)),
  services: Schema.optionalKey(Schema.Array(ServiceRecordSchema)),
  status: Schema.optionalKey(AssetStatusSchema),
});
export type Asset = typeof AssetSchema.Type;

export const InventoryResultSchema = Schema.Literals(['pending', 'found', 'missing', 'difference']);
export type InventoryResult = typeof InventoryResultSchema.Type;

export const FollowUpSchema = Schema.Struct({
  assignee: Schema.optionalKey(TextSchema(200)),
  createdAt: Schema.DateTimeUtcFromString,
  createdBy: PrincipalRefSchema,
  dueDate: IsoDateSchema,
  id: TextSchema(300),
  resolvedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  resolvedBy: Schema.optionalKey(PrincipalRefSchema),
  resolution: Schema.optionalKey(NoteSchema),
  status: Schema.Literals(['open', 'done']),
  title: TextSchema(200),
});
export type FollowUp = typeof FollowUpSchema.Type;

export const InventoryItemSchema = Schema.Struct({
  assetId: AssetIdSchema,
  checkedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  checkedBy: Schema.optionalKey(PrincipalRefSchema),
  followUp: Schema.optionalKey(FollowUpSchema),
  /** Snapshot taken when the inventory list was created. */
  inventoryNumber: TextSchema(64),
  name: TextSchema(200),
  note: Schema.optionalKey(NoteSchema),
  result: InventoryResultSchema,
});
export type InventoryItem = typeof InventoryItemSchema.Type;

export const InventorySchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  closedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  date: IsoDateSchema,
  id: TextSchema(300),
  items: Schema.Array(InventoryItemSchema),
  note: Schema.optionalKey(NoteSchema),
  scope: Schema.optionalKey(PropertyRefSchema),
  status: Schema.Literals(['open', 'closed']),
  title: TextSchema(200),
});
export type Inventory = typeof InventorySchema.Type;

/** Reusable input parameters of a depreciation plan (S03 „šablona“). */
export const DepreciationTemplateSchema = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  createdBy: PrincipalRefSchema,
  id: TextSchema(300),
  interval: DepreciationIntervalSchema,
  method: TextSchema(120),
  name: TextSchema(200),
  note: Schema.optionalKey(NoteSchema),
  taxGroup: Schema.optionalKey(TextSchema(40)),
  type: DepreciationTypeSchema,
  years: YearsSchema,
});
export type DepreciationTemplate = typeof DepreciationTemplateSchema.Type;

/** S15 plán budoucích investic: planned item with priority; the actual amount is recorded later (difference shown). */
export const InvestmentPrioritySchema = Schema.Literals(['high', 'medium', 'low']);
export type InvestmentPriority = typeof InvestmentPrioritySchema.Type;
export const investmentPriorities: readonly InvestmentPriority[] = ['high', 'medium', 'low'];
export const InvestmentStatusSchema = Schema.Literals(['planned', 'approved', 'in_progress', 'done', 'cancelled']);
export type InvestmentStatus = typeof InvestmentStatusSchema.Type;
export const investmentStatuses: readonly InvestmentStatus[] = ['planned', 'approved', 'in_progress', 'done', 'cancelled'];

export const InvestmentSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: TextSchema(300),
  title: TextSchema(200),
  description: Schema.optionalKey(NoteSchema),
  plannedAmountMinor: MinorAmountSchema,
  plannedDate: IsoDateSchema,
  priority: InvestmentPrioritySchema,
  status: InvestmentStatusSchema,
  actualAmountMinor: Schema.optionalKey(MinorAmountSchema),
  actualDate: Schema.optionalKey(IsoDateSchema),
  location: Schema.optionalKey(PropertyRefSchema),
  /** siampark-property property id (also when `location` is a unit), for filtering and summaries. */
  propertyId: Schema.optionalKey(TextSchema(300)),
  /** Optional asset the investment improves or replaces. */
  assetId: Schema.optionalKey(AssetIdSchema),
  responsible: Schema.optionalKey(TextSchema(200)),
});
export type Investment = typeof InvestmentSchema.Type;

/** Actual − planned (positive = over plan); `undefined` until the actual amount is recorded. */
export const investmentDifference = (investment: Investment): number | undefined =>
  investment.actualAmountMinor === undefined ? undefined : investment.actualAmountMinor - investment.plannedAmountMinor;

export const AssetsStateSchema = Schema.Struct({
  assets: Schema.Array(AssetSchema),
  inventories: Schema.optionalKey(Schema.Array(InventorySchema)),
  templates: Schema.optionalKey(Schema.Array(DepreciationTemplateSchema)),
  investments: Schema.optionalKey(Schema.Array(InvestmentSchema)),
});
export type AssetsState = typeof AssetsStateSchema.Type;
export type AssetsStateEncoded = typeof AssetsStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with AssetsStateSchema. */
export const emptyAssetsState: AssetsStateEncoded = { assets: [], inventories: [], templates: [] };

// ── Read helpers (pure; shared by UI, other lanes and tests) ─────────────────────────────────────────────

export const assetStatusOf = (asset: Asset): AssetStatus => asset.status ?? 'active';
export const isActiveAsset = (asset: Asset): boolean => assetStatusOf(asset) === 'active';

/**
 * Current revision / check / permit deadlines: for each asset, the newest record per (kind, title) that carries a
 * `nextDueOn`. Calendar and „Moje agenda“ may read this from the assets agenda state.
 */
export interface ServiceDue {
  readonly assetId: AssetId;
  readonly assetName: string;
  readonly inventoryNumber: string;
  readonly kind: ServiceKind;
  readonly location?: Asset['location'];
  readonly nextDueOn: string;
  readonly recordId: string;
  readonly responsible?: string;
  readonly title: string;
}

export const currentServiceRecords = (asset: Asset): readonly ServiceRecord[] => {
  const newest = new Map<string, ServiceRecord>();
  for (const record of asset.services ?? []) {
    const key = `${record.kind}:${record.title.toLowerCase()}`;
    const previous = newest.get(key);
    const rank = (entry: ServiceRecord) => entry.performedOn ?? entry.nextDueOn ?? '';
    if (previous === undefined || rank(record) >= rank(previous)) {
      newest.set(key, record);
    }
  }
  return [...newest.values()];
};

export const upcomingServiceDue = (state: AssetsState): readonly ServiceDue[] =>
  state.assets
    .filter(isActiveAsset)
    .flatMap((asset) =>
      currentServiceRecords(asset).flatMap((record): ServiceDue[] =>
        record.nextDueOn === undefined
          ? []
          : [
              {
                assetId: asset.id,
                assetName: asset.name,
                inventoryNumber: asset.inventoryNumber,
                kind: record.kind,
                nextDueOn: record.nextDueOn,
                recordId: record.id,
                title: record.title,
                ...(asset.location === undefined ? {} : { location: asset.location }),
                ...(record.responsible === undefined ? {} : { responsible: record.responsible }),
              },
            ],
      ),
    )
    .toSorted((left, right) => left.nextDueOn.localeCompare(right.nextDueOn));

/** Sum of approved depreciation amounts of one plan. */
export const approvedTotal = (plan: DepreciationPlan): number =>
  plan.entries.reduce((sum, entry) => sum + entry.amountMinor, 0);

/**
 * Indicative straight-line split of the base over the plan's periods. Shown only as an orientation next to the
 * approved values and labelled „nikoli právní výpočet“; it is never stored or used as an approved amount.
 */
export const indicativeSchedule = (
  plan: Pick<DepreciationPlan, 'baseMinor' | 'interval' | 'startDate' | 'years'>,
): readonly { readonly amountMinor: number; readonly period: string }[] => {
  const startYear = Number(plan.startDate.slice(0, 4));
  const startMonth = Number(plan.startDate.slice(5, 7));
  const count = plan.interval === 'yearly' ? plan.years : plan.years * 12;
  const share = Math.floor(plan.baseMinor / count / 100) * 100;
  return Array.from({ length: count }, (_, index) => {
    const amountMinor = index === count - 1 ? plan.baseMinor - share * (count - 1) : share;
    if (plan.interval === 'yearly') {
      return { amountMinor, period: String(startYear + index) };
    }
    const monthIndex = startMonth - 1 + index;
    const year = startYear + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    return { amountMinor, period: `${year}-${String(month).padStart(2, '0')}` };
  });
};
