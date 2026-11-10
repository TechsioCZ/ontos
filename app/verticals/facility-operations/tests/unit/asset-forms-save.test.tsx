// @rstest-environment happy-dom
// Every assets form sends its command once on the shared Uložit, last in the panel footer; leaving asks first.
import { SidePanel } from '@app/admin-ui';
import { Effect, Schema } from 'effect';
import { constUndefined, constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { AssetSchema, AssetsStateSchema, DepreciationPlanSchema } from '../../shared/domain/assets.ts';
import type { AssetsState } from '../../shared/domain/assets.ts';
import {
  ArchiveForm,
  AssetCardCreateForm,
  DisposeForm,
  EntryForm,
  EventForm,
  FollowUpForm,
  InventoryCreateForm,
  PlanForm,
  ServiceForm,
  TemplateForm,
  ValueChangeForm,
} from '../../src/routes/[lang]/provoz/majetek/asset-forms.tsx';
import type { AssetSubmit } from '../../src/routes/[lang]/provoz/majetek/form-kit.tsx';
import { FooterSlotProvider, useFooterSlot } from '../../src/ui/footer-slot.tsx';
import { labels, mountPanel, typeInto, unmountPanels } from './draft-base-fixture.ts';
import { leaveQuestionOpen, recordingRunner, saveButton, saveSent } from './form-save-fixture.ts';
import type { RecordingRunner } from './form-save-fixture.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/routes/[lang]/provoz/majetek/property-tree.ts', () => ({
  assetPlacementOf: () => ({}),
  locationItems: () => [],
  owningPropertyId: constUndefined,
  usePropertyTree: () => ({ status: 'loading' }),
}));

const copy = {
  panelTitle: 'facility-operations.assets.actions.recordEvent',
  resize: 'facility-operations.assets.resize',
};
const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const at = '2026-10-20T08:00:00Z';
const asset = Schema.decodeUnknownSync(AssetSchema)({
  acquisitionValueMinor: 12_000_000,
  category: 'Klimatizace',
  createdAt: at,
  createdBy: actor,
  id: 'asset-1',
  inventoryNumber: 'MJ-2024-017',
  kind: 'equipment',
  name: 'Venkovní jednotka',
  updatedAt: at,
  updatedBy: actor,
});
const plan = Schema.decodeUnknownSync(DepreciationPlanSchema)({
  baseMinor: 12_000_000,
  createdAt: at,
  createdBy: actor,
  entries: [],
  history: [],
  id: 'plan-1',
  interval: 'yearly',
  method: 'Rovnoměrný',
  startDate: '2024-03-01',
  status: 'confirmed',
  type: 'accounting',
  years: 5,
});
const state: AssetsState = Schema.decodeUnknownSync(AssetsStateSchema)({
  assets: [Schema.encodeSync(AssetSchema)(asset)],
});

const saved: string[] = [];
const submitThrough = (runner: RecordingRunner): AssetSubmit => ({
  onSaved: () => {
    saved.push('saved');
  },
  run: runner.run,
});

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saved.length = 0;
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

/** One form, typed and saved: the command it sent and the panel's feedback. */
const typedAndSaved = (
  form: ReturnType<typeof createElement>,
  typing: readonly (readonly [string, string])[],
  runner: RecordingRunner,
) =>
  Effect.gen(function* scenario() {
    yield* mountPanel(form);
    for (const [selector, value] of typing) {
      yield* typeInto(selector, value);
    }
    yield* saveSent(runner, 1);
    expect(runner.sent).toHaveLength(1);
    expect(saved).toEqual(['saved']);
    return runner.sent[0];
  });

describe('assets forms save once on Uložit', () => {
  it.live('a new asset card', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      const sent = yield* typedAndSaved(
        createElement(AssetCardCreateForm, { onSubmit: submitThrough(runner), state }),
        [
          ['#asset-inventory-number', 'MJ-2026-001'],
          ['#asset-name', 'Kotel'],
          ['#asset-category', 'Vytápění'],
        ],
        runner,
      );
      expect(sent).toMatchObject({ _tag: 'AssetCreate', inventoryNumber: 'MJ-2026-001', name: 'Kotel' });
    }),
  );

  it.live('a value change, an event, a disposal and a service visit', () =>
    Effect.gen(function* scenario() {
      const values = recordingRunner();
      expect(
        yield* typedAndSaved(
          createElement(ValueChangeForm, { asset, onSubmit: submitThrough(values) }),
          [
            ['#value-new', '90 000'],
            ['#value-reason', 'Znalecký posudek'],
          ],
          values,
        ),
      ).toMatchObject({ _tag: 'AssetValueChange', newValueMinor: 9_000_000, reason: 'Znalecký posudek' });
      unmountPanels();
      saved.length = 0;
      const events = recordingRunner();
      expect(
        yield* typedAndSaved(
          createElement(EventForm, { asset, onSubmit: submitThrough(events) }),
          [['#event-note', 'Výměna kompresoru']],
          events,
        ),
      ).toMatchObject({ _tag: 'AssetEventRecord', note: 'Výměna kompresoru' });
      unmountPanels();
      saved.length = 0;
      const disposals = recordingRunner();
      expect(
        yield* typedAndSaved(
          createElement(DisposeForm, { asset, onSubmit: submitThrough(disposals) }),
          [['#dispose-reason', 'Neopravitelná závada']],
          disposals,
        ),
      ).toMatchObject({ _tag: 'AssetDispose', kind: 'retirement', reason: 'Neopravitelná závada' });
      unmountPanels();
      saved.length = 0;
      const services = recordingRunner();
      expect(
        yield* typedAndSaved(
          createElement(ServiceForm, { asset, onSubmit: submitThrough(services) }),
          [['#service-title', 'Roční revize']],
          services,
        ),
      ).toMatchObject({ _tag: 'AssetServiceRecord', kind: 'revision', title: 'Roční revize' });
    }),
  );

  it.live('a depreciation plan, a plan entry and a template', () =>
    Effect.gen(function* scenario() {
      const plans = recordingRunner();
      expect(
        yield* typedAndSaved(
          createElement(PlanForm, { asset, onSubmit: submitThrough(plans), state, type: 'accounting' }),
          [['#plan-years', '5']],
          plans,
        ),
      ).toMatchObject({ _tag: 'AssetDepreciationPlanCreate', baseMinor: 12_000_000, years: 5 });
      unmountPanels();
      saved.length = 0;
      const entries = recordingRunner();
      expect(
        yield* typedAndSaved(
          createElement(EntryForm, { asset, onSubmit: submitThrough(entries), plan }),
          [['#entry-amount', '24 000']],
          entries,
        ),
      ).toMatchObject({ _tag: 'AssetDepreciationEntryRecord', amountMinor: 2_400_000, planId: plan.id });
      unmountPanels();
      saved.length = 0;
      const templates = recordingRunner();
      expect(
        yield* typedAndSaved(
          createElement(TemplateForm, { onSubmit: submitThrough(templates) }),
          [
            ['#template-name', 'Klimatizace 5 let'],
            ['#template-years', '5'],
          ],
          templates,
        ),
      ).toMatchObject({ _tag: 'AssetDepreciationTemplateCreate', name: 'Klimatizace 5 let', years: 5 });
    }),
  );

  it.live('an inventory count and its follow-up', () =>
    Effect.gen(function* scenario() {
      const inventories = recordingRunner();
      expect(
        yield* typedAndSaved(
          createElement(InventoryCreateForm, { onSubmit: submitThrough(inventories), state }),
          [['#inventory-title', 'Inventura 2026']],
          inventories,
        ),
      ).toMatchObject({ _tag: 'AssetInventoryCreate', assetIds: [asset.id], title: 'Inventura 2026' });
      unmountPanels();
      saved.length = 0;
      // The follow-up opens with a suggested title and date: Uložit sends it as it is.
      const followUps = recordingRunner();
      yield* mountPanel(
        createElement(FollowUpForm, {
          assetId: asset.id,
          assetName: asset.name,
          inventoryId: 'inventory-1',
          onSubmit: submitThrough(followUps),
        }),
      );
      expect(saveButton().disabled).toBe(false);
      yield* saveSent(followUps, 1);
      expect(followUps.sent).toEqual([
        expect.objectContaining({ _tag: 'AssetInventoryFollowUp', assetId: asset.id, inventoryId: 'inventory-1' }),
      ]);
    }),
  );

  it.live('an archive reason that opens filled in', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(createElement(ArchiveForm, { asset, onSubmit: submitThrough(runner) }));
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([expect.objectContaining({ _tag: 'AssetArchive', assetId: asset.id })]);
      expect(saved).toEqual(['saved']);
    }),
  );
});

/** An assets side panel as the page builds it: the form's Uložit renders into the footer slot. */
const EventPanel = ({ runner }: { readonly runner: RecordingRunner }) => {
  const footer = useFooterSlot();
  return createElement(
    SidePanel,
    {
      actions: footer.target,
      onOpenChange: constVoid,
      open: true,
      resizeLabel: copy.resize,
      title: copy.panelTitle,
    },
    createElement(
      FooterSlotProvider,
      { slot: footer.slot },
      createElement(EventForm, { asset, onSubmit: submitThrough(runner) }),
    ),
  );
};

describe('the panel footer and the way out', () => {
  it.live('Uložit is the last control of the panel footer and saves from there', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(createElement(EventPanel, { runner }));
      const slot = document.querySelector('[data-footer-slot]');
      const buttons = [...(slot?.querySelectorAll('button') ?? [])];
      expect(buttons.at(-1)?.textContent.trim()).toBe(labels.save);
      yield* typeInto('#event-note', 'Výměna kompresoru');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([expect.objectContaining({ _tag: 'AssetEventRecord', note: 'Výměna kompresoru' })]);
    }),
  );

  it.live('a refused save keeps the typed input and says why', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner(['unavailable']);
      yield* mountPanel(createElement(EventForm, { asset, onSubmit: submitThrough(runner) }));
      yield* typeInto('#event-note', 'Výměna kompresoru');
      yield* saveSent(runner, 1);
      expect(saved).toEqual([]);
      expect(document.body.textContent).toContain('facility-operations.common.errors.unavailable');
      expect(document.querySelector<HTMLTextAreaElement>('#event-note')?.value).toBe('Výměna kompresoru');
      expect(leaveQuestionOpen()).toBe(false);
    }),
  );
});
