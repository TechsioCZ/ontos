// Siampark provoz — commands of agenda `assets` (S02 majetek, revize a inventura + S03 odpisové plány).
// OWNED BY THE `assets` LANE (ops-assets). Tags are globally unique (`Asset…`). The central dispatcher
// (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
// Depreciation commands only RECORD approved values; nothing here computes legal/tax depreciation (S03).
import { DateTime, Effect, Match, Schema } from 'effect';
import {
  IsoDateSchema,
  MinorAmountSchema,
  NoteSchema,
  PropertyRefSchema,
  TextSchema,
  auditCreated,
  auditUpdated,
  defineAgenda,
  entityIdOf,
  mintId,
  opsConflict,
  opsNotFound,
} from '../domain/common.ts';
import type { EntityId, OpsCommandInput } from '../domain/common.ts';
import {
  AcquisitionMethodSchema,
  AssetIdSchema,
  AssetKindSchema,
  AssetsStateSchema,
  DepreciationIntervalSchema,
  DepreciationTypeSchema,
  DisposalKindSchema,
  InventoryResultSchema,
  InvestmentPrioritySchema,
  InvestmentStatusSchema,
  ManualEventKindSchema,
  PeriodSchema,
  PermitStateSchema,
  ServiceKindSchema,
  ServiceResultSchema,
  YearsSchema,
  approvedTotal,
  emptyAssetsState,
  isActiveAsset,
} from '../domain/assets.ts';
import type {
  Asset,
  AssetEvent,
  AssetsState,
  DepreciationEntry,
  DepreciationPlan,
  DepreciationTemplate,
  Inventory,
  InventoryItem,
  Investment,
  ServiceRecord,
} from '../domain/assets.ts';

const RefTextSchema = TextSchema(300);
const optionalText = (maximum: number) => Schema.optionalKey(TextSchema(maximum));

/** Fields shared by create and update (identity, classification, placement, responsibility). */
const assetCardFields = {
  accountingProduct: optionalText(200),
  category: TextSchema(120),
  kind: AssetKindSchema,
  location: Schema.optionalKey(PropertyRefSchema),
  name: TextSchema(200),
  note: Schema.optionalKey(NoteSchema),
  propertyId: optionalText(300),
  responsible: optionalText(200),
  serialNumber: optionalText(120),
};

const investmentFields = {
  actualAmountMinor: Schema.optionalKey(MinorAmountSchema),
  actualDate: Schema.optionalKey(IsoDateSchema),
  assetId: Schema.optionalKey(AssetIdSchema),
  description: Schema.optionalKey(NoteSchema),
  location: Schema.optionalKey(PropertyRefSchema),
  plannedAmountMinor: MinorAmountSchema,
  plannedDate: IsoDateSchema,
  priority: InvestmentPrioritySchema,
  propertyId: optionalText(300),
  responsible: optionalText(200),
  status: InvestmentStatusSchema,
  title: TextSchema(200),
};

export const assetsCommandSchemas = [
  Schema.TaggedStruct('AssetCreate', {
    ...assetCardFields,
    acquisitionDate: Schema.optionalKey(IsoDateSchema),
    acquisitionMethod: Schema.optionalKey(AcquisitionMethodSchema),
    acquisitionValueMinor: Schema.optionalKey(MinorAmountSchema),
    currentValueMinor: Schema.optionalKey(MinorAmountSchema),
    inventoryNumber: TextSchema(64),
    placedInServiceDate: Schema.optionalKey(IsoDateSchema),
  }),
  /** Replaces the card fields; absent optional fields are cleared. Values change only via AssetValueChange. */
  Schema.TaggedStruct('AssetUpdate', { ...assetCardFields, assetId: AssetIdSchema }),
  /** S02-02: evidovaná hodnota se mění s důvodem; původní hodnota zůstává v historii. */
  Schema.TaggedStruct('AssetValueChange', {
    assetId: AssetIdSchema,
    date: IsoDateSchema,
    documentRef: optionalText(300),
    newValueMinor: MinorAmountSchema,
    reason: TextSchema(2000),
  }),
  Schema.TaggedStruct('AssetEventRecord', {
    assetId: AssetIdSchema,
    date: IsoDateSchema,
    documentRef: optionalText(300),
    kind: ManualEventKindSchema,
    note: TextSchema(4000),
  }),
  /** S02-04: prodej / vyřazení / likvidace. History is kept, the asset leaves the active list. */
  Schema.TaggedStruct('AssetDispose', {
    assetId: AssetIdSchema,
    date: IsoDateSchema,
    documentRef: optionalText(300),
    kind: DisposalKindSchema,
    proceedsMinor: Schema.optionalKey(MinorAmountSchema),
    reason: TextSchema(2000),
  }),
  /** Staff-only: a disposed asset (typically a test record) leaves the register; data and history stay. */
  Schema.TaggedStruct('AssetArchive', { assetId: AssetIdSchema, reason: TextSchema(2000) }),
  Schema.TaggedStruct('AssetArchiveRestore', { assetId: AssetIdSchema }),
  Schema.TaggedStruct('AssetServiceRecord', {
    assetId: AssetIdSchema,
    documentRef: optionalText(300),
    kind: ServiceKindSchema,
    nextDueOn: Schema.optionalKey(IsoDateSchema),
    note: Schema.optionalKey(NoteSchema),
    performedOn: Schema.optionalKey(IsoDateSchema),
    permitState: Schema.optionalKey(PermitStateSchema),
    responsible: optionalText(200),
    result: Schema.optionalKey(ServiceResultSchema),
    supplier: optionalText(200),
    title: TextSchema(200),
  }),
  Schema.TaggedStruct('AssetDepreciationPlanCreate', {
    assetId: AssetIdSchema,
    baseMinor: MinorAmountSchema,
    interval: DepreciationIntervalSchema,
    method: TextSchema(120),
    note: Schema.optionalKey(NoteSchema),
    startDate: IsoDateSchema,
    taxGroup: optionalText(40),
    templateId: optionalText(300),
    type: DepreciationTypeSchema,
    years: YearsSchema,
  }),
  Schema.TaggedStruct('AssetDepreciationPlanConfirm', {
    assetId: AssetIdSchema,
    note: Schema.optionalKey(NoteSchema),
    planId: RefTextSchema,
  }),
  /** S03-01: ručně potvrzená částka jednoho období (účetní a daňová zvlášť, každá ve svém plánu). */
  Schema.TaggedStruct('AssetDepreciationEntryRecord', {
    amountMinor: MinorAmountSchema,
    assetId: AssetIdSchema,
    documentRef: optionalText(300),
    note: Schema.optionalKey(NoteSchema),
    partial: Schema.optionalKey(Schema.Boolean),
    period: PeriodSchema,
    planId: RefTextSchema,
  }),
  Schema.TaggedStruct('AssetDepreciationTemplateCreate', {
    interval: DepreciationIntervalSchema,
    method: TextSchema(120),
    name: TextSchema(200),
    note: Schema.optionalKey(NoteSchema),
    taxGroup: optionalText(40),
    type: DepreciationTypeSchema,
    years: YearsSchema,
  }),
  /** S02 inventura: list of assets to check (typically every active asset of one property). */
  Schema.TaggedStruct('AssetInventoryCreate', {
    assetIds: Schema.Array(AssetIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    date: IsoDateSchema,
    note: Schema.optionalKey(NoteSchema),
    scope: Schema.optionalKey(PropertyRefSchema),
    title: TextSchema(200),
  }),
  Schema.TaggedStruct('AssetInventoryMark', {
    assetId: AssetIdSchema,
    inventoryId: RefTextSchema,
    note: Schema.optionalKey(NoteSchema),
    result: InventoryResultSchema,
  }),
  /** S02-03: navázaný úkol k inventurnímu rozdílu. */
  Schema.TaggedStruct('AssetInventoryFollowUp', {
    assetId: AssetIdSchema,
    assignee: optionalText(200),
    dueDate: IsoDateSchema,
    inventoryId: RefTextSchema,
    title: TextSchema(200),
  }),
  Schema.TaggedStruct('AssetInventoryFollowUpResolve', {
    assetId: AssetIdSchema,
    inventoryId: RefTextSchema,
    resolution: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('AssetInventoryClose', { inventoryId: RefTextSchema }),
  /** S15 plán investic: new planned investment. */
  Schema.TaggedStruct('AssetInvestmentCreate', investmentFields),
  /** Replaces the investment fields (absent optional fields are cleared), e.g. to record the actual amount. */
  Schema.TaggedStruct('AssetInvestmentUpdate', { ...investmentFields, investmentId: RefTextSchema }),
] as const;

export const AssetsCommandSchema = Schema.Union(assetsCommandSchemas);
export type AssetsCommand = typeof AssetsCommandSchema.Type;
type CommandOf<Tag extends AssetsCommand['_tag']> = Extract<AssetsCommand, { readonly _tag: Tag }>;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────

const findAsset = (state: AssetsState, assetId: string) =>
  Effect.gen(function* findAssetEffect() {
    const asset = state.assets.find((entry) => entry.id === assetId);
    if (asset === undefined) {
      return yield* opsNotFound('Asset not found');
    }
    return asset;
  });

const requireActive = (asset: Asset) =>
  isActiveAsset(asset) ? Effect.void : opsConflict('The asset is disposed; its history is read-only');

const replaceAsset = (state: AssetsState, next: Asset): AssetsState => ({
  ...state,
  assets: state.assets.map((entry) => (entry.id === next.id ? next : entry)),
});

const changed = (state: AssetsState, entityId: string) =>
  Effect.map(entityIdOf(entityId), (entity): { entityIds: readonly EntityId[]; state: AssetsState } => ({
    entityIds: [entity],
    state,
  }));

const makeEvent = (
  input: OpsCommandInput,
  suffix: string,
  fields: Omit<AssetEvent, 'at' | 'by' | 'id'>,
): AssetEvent => ({ ...fields, at: input.now, by: input.actor, id: `${input.resourceId}:${suffix}` });

/** Optional card fields copied from a command; absent ones stay absent (exactOptionalPropertyTypes). */
const cardOf = (value: CommandOf<'AssetCreate'> | CommandOf<'AssetUpdate'>) => ({
  category: value.category,
  kind: value.kind,
  name: value.name,
  ...(value.accountingProduct === undefined ? {} : { accountingProduct: value.accountingProduct }),
  ...(value.location === undefined ? {} : { location: value.location }),
  ...(value.note === undefined || value.note === '' ? {} : { note: value.note }),
  ...(value.propertyId === undefined ? {} : { propertyId: value.propertyId }),
  ...(value.responsible === undefined ? {} : { responsible: value.responsible }),
  ...(value.serialNumber === undefined ? {} : { serialNumber: value.serialNumber }),
});

const withoutCard = (asset: Asset) => {
  const {
    accountingProduct: _accountingProduct,
    location: _location,
    note: _note,
    propertyId: _propertyId,
    responsible: _responsible,
    serialNumber: _serialNumber,
    ...rest
  } = asset;
  return rest;
};

const findInventory = (state: AssetsState, inventoryId: string) =>
  Effect.gen(function* findInventoryEffect() {
    const inventory = (state.inventories ?? []).find((entry) => entry.id === inventoryId);
    if (inventory === undefined) {
      return yield* opsNotFound('Inventory not found');
    }
    return inventory;
  });

const findItem = (inventory: Inventory, assetId: string) =>
  Effect.gen(function* findItemEffect() {
    const item = inventory.items.find((entry) => entry.assetId === assetId);
    if (item === undefined) {
      return yield* opsNotFound('The asset is not on this inventory list');
    }
    return item;
  });

const replaceItem = (
  state: AssetsState,
  inventory: Inventory,
  next: InventoryItem,
  input: OpsCommandInput,
): AssetsState => ({
  ...state,
  inventories: (state.inventories ?? []).map((entry) =>
    entry.id === inventory.id
      ? auditUpdated(
          { ...entry, items: entry.items.map((item) => (item.assetId === next.assetId ? next : item)) },
          input,
        )
      : entry,
  ),
});

const findPlan = (asset: Asset, planId: string) =>
  Effect.gen(function* findPlanEffect() {
    const plan = (asset.depreciationPlans ?? []).find((entry) => entry.id === planId);
    if (plan === undefined) {
      return yield* opsNotFound('Depreciation plan not found');
    }
    return plan;
  });

const replacePlan = (asset: Asset, next: DepreciationPlan): DepreciationPlan[] =>
  (asset.depreciationPlans ?? []).map((entry) => (entry.id === next.id ? next : entry));

// ── reducers ─────────────────────────────────────────────────────────────────────────────────────────────

const createAsset = Effect.fn('SiamparkOps.Assets.create')(function* createAsset(
  state: AssetsState,
  value: CommandOf<'AssetCreate'>,
  input: OpsCommandInput,
) {
  if (state.assets.some((entry) => entry.inventoryNumber.toLowerCase() === value.inventoryNumber.toLowerCase())) {
    return yield* opsConflict('An asset with this inventory number already exists');
  }
  const id = yield* mintId(AssetIdSchema, input.resourceId);
  const events: AssetEvent[] = [];
  if (value.acquisitionDate !== undefined) {
    events.push(
      makeEvent(input, 'acquisition', {
        date: value.acquisitionDate,
        kind: 'acquisition',
        note: '',
        ...(value.acquisitionValueMinor === undefined ? {} : { newValueMinor: value.acquisitionValueMinor }),
      }),
    );
  }
  if (value.placedInServiceDate !== undefined) {
    events.push(makeEvent(input, 'service', { date: value.placedInServiceDate, kind: 'placed_in_service', note: '' }));
  }
  const currentValue = value.currentValueMinor ?? value.acquisitionValueMinor;
  const record: Asset = {
    ...auditCreated(input),
    ...cardOf(value),
    depreciationPlans: [],
    events,
    id,
    inventoryNumber: value.inventoryNumber,
    services: [],
    status: 'active',
    ...(value.acquisitionDate === undefined ? {} : { acquisitionDate: value.acquisitionDate }),
    ...(value.acquisitionMethod === undefined ? {} : { acquisitionMethod: value.acquisitionMethod }),
    ...(value.acquisitionValueMinor === undefined ? {} : { acquisitionValueMinor: value.acquisitionValueMinor }),
    ...(currentValue === undefined
      ? {}
      : {
          currentValueDate: value.acquisitionDate ?? DateTime.formatIso(input.now).slice(0, 10),
          currentValueMinor: currentValue,
        }),
    ...(value.placedInServiceDate === undefined ? {} : { placedInServiceDate: value.placedInServiceDate }),
  };
  return yield* changed({ ...state, assets: [...state.assets, record] }, id);
});

const updateAsset = Effect.fn('SiamparkOps.Assets.update')(function* updateAsset(
  state: AssetsState,
  value: CommandOf<'AssetUpdate'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  yield* requireActive(asset);
  const next: Asset = auditUpdated({ ...withoutCard(asset), ...cardOf(value) }, input);
  return yield* changed(replaceAsset(state, next), asset.id);
});

const changeValue = Effect.fn('SiamparkOps.Assets.changeValue')(function* changeValue(
  state: AssetsState,
  value: CommandOf<'AssetValueChange'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  yield* requireActive(asset);
  if (asset.currentValueMinor === value.newValueMinor) {
    return yield* opsConflict('The new value equals the current value');
  }
  const event = makeEvent(input, 'value', {
    date: value.date,
    kind: 'value_change',
    newValueMinor: value.newValueMinor,
    note: value.reason,
    ...(asset.currentValueMinor === undefined ? {} : { previousValueMinor: asset.currentValueMinor }),
    ...(value.documentRef === undefined ? {} : { documentRef: value.documentRef }),
  });
  const next: Asset = auditUpdated(
    {
      ...asset,
      currentValueDate: value.date,
      currentValueMinor: value.newValueMinor,
      events: [...(asset.events ?? []), event],
    },
    input,
  );
  return yield* changed(replaceAsset(state, next), asset.id);
});

const recordEvent = Effect.fn('SiamparkOps.Assets.recordEvent')(function* recordEvent(
  state: AssetsState,
  value: CommandOf<'AssetEventRecord'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  const event = makeEvent(input, 'event', {
    date: value.date,
    kind: value.kind,
    note: value.note,
    ...(value.documentRef === undefined ? {} : { documentRef: value.documentRef }),
  });
  const next: Asset = auditUpdated(
    {
      ...asset,
      events: [...(asset.events ?? []), event],
      ...(value.kind === 'placed_in_service' ? { placedInServiceDate: value.date } : {}),
    },
    input,
  );
  return yield* changed(replaceAsset(state, next), asset.id);
});

const disposeAsset = Effect.fn('SiamparkOps.Assets.dispose')(function* disposeAsset(
  state: AssetsState,
  value: CommandOf<'AssetDispose'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  yield* requireActive(asset);
  const event = makeEvent(input, 'disposal', {
    date: value.date,
    kind: value.kind,
    note: value.reason,
    ...(value.proceedsMinor === undefined ? {} : { newValueMinor: value.proceedsMinor }),
    ...(asset.currentValueMinor === undefined ? {} : { previousValueMinor: asset.currentValueMinor }),
    ...(value.documentRef === undefined ? {} : { documentRef: value.documentRef }),
  });
  const next: Asset = auditUpdated(
    {
      ...asset,
      disposal: {
        date: value.date,
        kind: value.kind,
        reason: value.reason,
        ...(value.proceedsMinor === undefined ? {} : { proceedsMinor: value.proceedsMinor }),
        ...(value.documentRef === undefined ? {} : { documentRef: value.documentRef }),
      },
      events: [...(asset.events ?? []), event],
      status: 'disposed',
    },
    input,
  );
  return yield* changed(replaceAsset(state, next), asset.id);
});

const archiveAsset = Effect.fn('SiamparkOps.Assets.archive')(function* archiveAsset(
  state: AssetsState,
  value: CommandOf<'AssetArchive'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  if (isActiveAsset(asset)) {
    return yield* opsConflict('Only a disposed asset can be archived');
  }
  if (asset.archive !== undefined) {
    return yield* opsConflict('The asset is already archived');
  }
  const event = makeEvent(input, 'archive', {
    date: DateTime.formatIso(input.now).slice(0, 10),
    kind: 'note',
    note: `Archivováno: ${value.reason}`,
  });
  const next: Asset = auditUpdated(
    {
      ...asset,
      archive: { at: input.now, by: input.actor, reason: value.reason },
      events: [...(asset.events ?? []), event],
    },
    input,
  );
  return yield* changed(replaceAsset(state, next), asset.id);
});

const restoreArchivedAsset = Effect.fn('SiamparkOps.Assets.restoreArchived')(function* restoreArchivedAsset(
  state: AssetsState,
  value: CommandOf<'AssetArchiveRestore'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  if (asset.archive === undefined) {
    return yield* opsConflict('The asset is not archived');
  }
  const { archive: _archive, ...rest } = asset;
  void _archive;
  const event = makeEvent(input, 'archive-restore', {
    date: DateTime.formatIso(input.now).slice(0, 10),
    kind: 'note',
    note: 'Obnoveno z archivu.',
  });
  const next: Asset = auditUpdated({ ...rest, events: [...(asset.events ?? []), event] }, input);
  return yield* changed(replaceAsset(state, next), asset.id);
});

const recordService = Effect.fn('SiamparkOps.Assets.recordService')(function* recordService(
  state: AssetsState,
  value: CommandOf<'AssetServiceRecord'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  yield* requireActive(asset);
  if (value.performedOn === undefined && value.nextDueOn === undefined && value.kind !== 'permit') {
    return yield* opsConflict('A service record needs the performed date or the next due date');
  }
  const { _tag, assetId: _assetId, ...fields } = value;
  void _tag;
  const record: ServiceRecord = { ...fields, at: input.now, by: input.actor, id: `${input.resourceId}:service` };
  const next: Asset = auditUpdated({ ...asset, services: [...(asset.services ?? []), record] }, input);
  return yield* changed(replaceAsset(state, next), record.id);
});

const createPlan = Effect.fn('SiamparkOps.Assets.createPlan')(function* createPlan(
  state: AssetsState,
  value: CommandOf<'AssetDepreciationPlanCreate'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  yield* requireActive(asset);
  if ((asset.depreciationPlans ?? []).some((plan) => plan.type === value.type)) {
    return yield* opsConflict('The asset already has a depreciation plan of this type');
  }
  if (value.templateId !== undefined && !(state.templates ?? []).some((entry) => entry.id === value.templateId)) {
    return yield* opsNotFound('Depreciation template not found');
  }
  const { _tag, assetId: _assetId, ...fields } = value;
  void _tag;
  const plan: DepreciationPlan = {
    ...fields,
    createdAt: input.now,
    createdBy: input.actor,
    entries: [],
    history: [{ at: input.now, by: input.actor, change: 'created' }],
    id: `${input.resourceId}:plan`,
    status: 'draft',
  };
  const next: Asset = auditUpdated({ ...asset, depreciationPlans: [...(asset.depreciationPlans ?? []), plan] }, input);
  return yield* changed(replaceAsset(state, next), plan.id);
});

const confirmPlan = Effect.fn('SiamparkOps.Assets.confirmPlan')(function* confirmPlan(
  state: AssetsState,
  value: CommandOf<'AssetDepreciationPlanConfirm'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  yield* requireActive(asset);
  const plan = yield* findPlan(asset, value.planId);
  if (plan.status === 'confirmed') {
    return yield* opsConflict('The plan is already confirmed');
  }
  const confirmed: DepreciationPlan = {
    ...plan,
    history: [
      ...plan.history,
      {
        at: input.now,
        by: input.actor,
        change: 'confirmed',
        ...(value.note === undefined ? {} : { note: value.note }),
      },
    ],
    status: 'confirmed',
  };
  const next: Asset = auditUpdated({ ...asset, depreciationPlans: replacePlan(asset, confirmed) }, input);
  return yield* changed(replaceAsset(state, next), plan.id);
});

const recordEntry = Effect.fn('SiamparkOps.Assets.recordEntry')(function* recordEntry(
  state: AssetsState,
  value: CommandOf<'AssetDepreciationEntryRecord'>,
  input: OpsCommandInput,
) {
  const asset = yield* findAsset(state, value.assetId);
  yield* requireActive(asset);
  const plan = yield* findPlan(asset, value.planId);
  const monthly = /^\d{4}-\d{2}$/.test(value.period);
  if (monthly !== (plan.interval === 'monthly')) {
    return yield* opsConflict('The period does not match the plan interval');
  }
  if (plan.entries.some((entry) => entry.period === value.period)) {
    return yield* opsConflict('An approved amount for this period already exists');
  }
  if (approvedTotal(plan) + value.amountMinor > plan.baseMinor) {
    return yield* opsConflict('Approved amounts would exceed the depreciation base');
  }
  const entry: DepreciationEntry = {
    amountMinor: value.amountMinor,
    at: input.now,
    by: input.actor,
    id: `${input.resourceId}:entry`,
    period: value.period,
    ...(value.documentRef === undefined ? {} : { documentRef: value.documentRef }),
    ...(value.note === undefined || value.note === '' ? {} : { note: value.note }),
    ...(value.partial === true ? { partial: true } : {}),
  };
  const updated: DepreciationPlan = {
    ...plan,
    entries: [...plan.entries, entry].toSorted((left, right) => left.period.localeCompare(right.period)),
    history: [...plan.history, { at: input.now, by: input.actor, change: 'entry_recorded', note: value.period }],
  };
  const next: Asset = auditUpdated({ ...asset, depreciationPlans: replacePlan(asset, updated) }, input);
  return yield* changed(replaceAsset(state, next), entry.id);
});

const createTemplate = Effect.fn('SiamparkOps.Assets.createTemplate')(function* createTemplate(
  state: AssetsState,
  value: CommandOf<'AssetDepreciationTemplateCreate'>,
  input: OpsCommandInput,
) {
  if ((state.templates ?? []).some((entry) => entry.name.toLowerCase() === value.name.toLowerCase())) {
    return yield* opsConflict('A template with this name already exists');
  }
  const { _tag, ...fields } = value;
  void _tag;
  const template: DepreciationTemplate = {
    ...fields,
    createdAt: input.now,
    createdBy: input.actor,
    id: `${input.resourceId}:template`,
  };
  return yield* changed({ ...state, templates: [...(state.templates ?? []), template] }, template.id);
});

const createInventory = Effect.fn('SiamparkOps.Assets.createInventory')(function* createInventory(
  state: AssetsState,
  value: CommandOf<'AssetInventoryCreate'>,
  input: OpsCommandInput,
) {
  const unique = [...new Set(value.assetIds)];
  const items: InventoryItem[] = [];
  for (const assetId of unique) {
    const asset = yield* findAsset(state, assetId);
    yield* requireActive(asset);
    items.push({ assetId: asset.id, inventoryNumber: asset.inventoryNumber, name: asset.name, result: 'pending' });
  }
  const inventory: Inventory = {
    ...auditCreated(input),
    date: value.date,
    id: `${input.resourceId}:inventory`,
    items,
    status: 'open',
    title: value.title,
    ...(value.note === undefined || value.note === '' ? {} : { note: value.note }),
    ...(value.scope === undefined ? {} : { scope: value.scope }),
  };
  return yield* changed({ ...state, inventories: [...(state.inventories ?? []), inventory] }, inventory.id);
});

const requireOpen = (inventory: Inventory) =>
  inventory.status === 'open' ? Effect.void : opsConflict('The inventory is closed');

const markInventory = Effect.fn('SiamparkOps.Assets.markInventory')(function* markInventory(
  state: AssetsState,
  value: CommandOf<'AssetInventoryMark'>,
  input: OpsCommandInput,
) {
  const inventory = yield* findInventory(state, value.inventoryId);
  yield* requireOpen(inventory);
  const item = yield* findItem(inventory, value.assetId);
  if (item.followUp !== undefined && (value.result === 'found' || value.result === 'pending')) {
    return yield* opsConflict('The difference already has a follow-up task; resolve the task instead');
  }
  const { note: _note, ...rest } = item;
  const next: InventoryItem = {
    ...rest,
    checkedAt: input.now,
    checkedBy: input.actor,
    result: value.result,
    ...(value.note === undefined || value.note === '' ? {} : { note: value.note }),
  };
  return yield* changed(replaceItem(state, inventory, next, input), inventory.id);
});

const followUp = Effect.fn('SiamparkOps.Assets.followUp')(function* followUp(
  state: AssetsState,
  value: CommandOf<'AssetInventoryFollowUp'>,
  input: OpsCommandInput,
) {
  const inventory = yield* findInventory(state, value.inventoryId);
  const item = yield* findItem(inventory, value.assetId);
  if (item.result !== 'missing' && item.result !== 'difference') {
    return yield* opsConflict('Only a missing item or a difference can get a follow-up task');
  }
  if (item.followUp !== undefined) {
    return yield* opsConflict('This difference already has a follow-up task');
  }
  const task = {
    createdAt: input.now,
    createdBy: input.actor,
    dueDate: value.dueDate,
    id: `${input.resourceId}:task`,
    status: 'open' as const,
    title: value.title,
    ...(value.assignee === undefined ? {} : { assignee: value.assignee }),
  };
  return yield* changed(replaceItem(state, inventory, { ...item, followUp: task }, input), task.id);
});

const resolveFollowUp = Effect.fn('SiamparkOps.Assets.resolveFollowUp')(function* resolveFollowUp(
  state: AssetsState,
  value: CommandOf<'AssetInventoryFollowUpResolve'>,
  input: OpsCommandInput,
) {
  const inventory = yield* findInventory(state, value.inventoryId);
  const item = yield* findItem(inventory, value.assetId);
  if (item.followUp === undefined) {
    return yield* opsNotFound('No follow-up task for this item');
  }
  if (item.followUp.status === 'done') {
    return yield* opsConflict('The follow-up task is already done');
  }
  const done = {
    ...item.followUp,
    resolvedAt: input.now,
    resolvedBy: input.actor,
    status: 'done' as const,
    ...(value.resolution === undefined || value.resolution === '' ? {} : { resolution: value.resolution }),
  };
  return yield* changed(replaceItem(state, inventory, { ...item, followUp: done }, input), done.id);
});

const closeInventory = Effect.fn('SiamparkOps.Assets.closeInventory')(function* closeInventory(
  state: AssetsState,
  value: CommandOf<'AssetInventoryClose'>,
  input: OpsCommandInput,
) {
  const inventory = yield* findInventory(state, value.inventoryId);
  yield* requireOpen(inventory);
  if (inventory.items.some((item) => item.result === 'pending')) {
    return yield* opsConflict('Every item must be checked before closing the inventory');
  }
  const closed: Inventory = auditUpdated({ ...inventory, closedAt: input.now, status: 'closed' }, input);
  return yield* changed(
    { ...state, inventories: (state.inventories ?? []).map((entry) => (entry.id === closed.id ? closed : entry)) },
    closed.id,
  );
});

const investmentOf = (value: CommandOf<'AssetInvestmentCreate'> | CommandOf<'AssetInvestmentUpdate'>) => {
  const fields = Object.entries(value).filter(
    ([key, entry]) => key !== '_tag' && key !== 'investmentId' && entry !== undefined,
  );
  return Object.fromEntries(fields) as Omit<
    Investment,
    'createdAt' | 'createdBy' | 'id' | 'updatedAt' | 'updatedBy'
  >;
};

const requireInvestmentRules = (fields: ReturnType<typeof investmentOf>, state: AssetsState) =>
  Effect.gen(function* requireInvestmentRulesEffect() {
    if (fields.status === 'done' && fields.actualAmountMinor === undefined) {
      return yield* opsConflict('A completed investment needs its actual amount');
    }
    if (fields.assetId !== undefined && !state.assets.some((asset) => asset.id === fields.assetId)) {
      return yield* opsNotFound('Asset not found');
    }
  });

const createInvestment = Effect.fn('SiamparkOps.Assets.createInvestment')(function* createInvestment(
  state: AssetsState,
  value: CommandOf<'AssetInvestmentCreate'>,
  input: OpsCommandInput,
) {
  const fields = investmentOf(value);
  yield* requireInvestmentRules(fields, state);
  const record: Investment = { ...auditCreated(input), ...fields, id: input.resourceId };
  return yield* changed({ ...state, investments: [...(state.investments ?? []), record] }, record.id);
});

const updateInvestment = Effect.fn('SiamparkOps.Assets.updateInvestment')(function* updateInvestment(
  state: AssetsState,
  value: CommandOf<'AssetInvestmentUpdate'>,
  input: OpsCommandInput,
) {
  const current = (state.investments ?? []).find((entry) => entry.id === value.investmentId);
  if (current === undefined) {
    return yield* opsNotFound('Investment not found');
  }
  const fields = investmentOf(value);
  yield* requireInvestmentRules(fields, state);
  const next: Investment = auditUpdated(
    {
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      id: current.id,
      updatedAt: current.updatedAt,
      updatedBy: current.updatedBy,
      ...fields,
    },
    input,
  );
  return yield* changed(
    { ...state, investments: (state.investments ?? []).map((entry) => (entry.id === next.id ? next : entry)) },
    next.id,
  );
});

/** Pure reducer: applies one command to the `assets` state. Persistence decides when it is saved. */
export const evolveAssets = (state: AssetsState, command: AssetsCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('AssetCreate', (value) => createAsset(state, value, input)),
    Match.tag('AssetUpdate', (value) => updateAsset(state, value, input)),
    Match.tag('AssetValueChange', (value) => changeValue(state, value, input)),
    Match.tag('AssetEventRecord', (value) => recordEvent(state, value, input)),
    Match.tag('AssetDispose', (value) => disposeAsset(state, value, input)),
    Match.tag('AssetArchive', (value) => archiveAsset(state, value, input)),
    Match.tag('AssetArchiveRestore', (value) => restoreArchivedAsset(state, value, input)),
    Match.tag('AssetServiceRecord', (value) => recordService(state, value, input)),
    Match.tag('AssetDepreciationPlanCreate', (value) => createPlan(state, value, input)),
    Match.tag('AssetDepreciationPlanConfirm', (value) => confirmPlan(state, value, input)),
    Match.tag('AssetDepreciationEntryRecord', (value) => recordEntry(state, value, input)),
    Match.tag('AssetDepreciationTemplateCreate', (value) => createTemplate(state, value, input)),
    Match.tag('AssetInventoryCreate', (value) => createInventory(state, value, input)),
    Match.tag('AssetInventoryMark', (value) => markInventory(state, value, input)),
    Match.tag('AssetInventoryFollowUp', (value) => followUp(state, value, input)),
    Match.tag('AssetInventoryFollowUpResolve', (value) => resolveFollowUp(state, value, input)),
    Match.tag('AssetInventoryClose', (value) => closeInventory(state, value, input)),
    Match.tag('AssetInvestmentCreate', (value) => createInvestment(state, value, input)),
    Match.tag('AssetInvestmentUpdate', (value) => updateInvestment(state, value, input)),
    Match.exhaustive,
  );

export const assetsAgenda = defineAgenda({
  commandSchema: AssetsCommandSchema,
  empty: emptyAssetsState,
  evolve: evolveAssets,
  id: 'assets',
  sensitivity: 'restricted',
  stateSchema: AssetsStateSchema,
});
