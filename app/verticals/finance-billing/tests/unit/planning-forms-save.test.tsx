// @rstest-environment happy-dom
// The planning forms (budget line, opening balance, plan item) send their one command only from the shared Save button
// ("Uložit"), last in the footer: typing and Enter change only the draft, an untouched form closes without asking, and
// an edit over someone else's newer version is refused as a conflict. Only the i18n runtime, the router blocker and the
// select picker are replaced.
import { DateTime, Effect, Predicate } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type { BudgetLine } from '../../shared/apis/records.ts';
import { editBudgetDraft, newBudgetDraft } from '../../src/routes/[lang]/finance/budget-draft.ts';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { newPlanDraft } from '../../src/routes/[lang]/finance/plan-item-draft.ts';
import { PlanItemEditor } from '../../src/routes/[lang]/finance/plan-item-editor.tsx';
import { BudgetEditor, OpeningBalanceEditor } from '../../src/routes/[lang]/finance/planning-forms.tsx';
import {
  clickCancel,
  clickDiscard,
  clickSave,
  fakeVm,
  lastFooterButton,
  leaveQuestion,
  mount,
  pressEnter,
  saveButton,
  typeInto,
  unmountAll,
  waitUntil,
} from './finance-form-harness.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
}));
rstest.mock('@app/admin-ui/select-template', () => ({
  SelectTemplate: (props: {
    readonly items: readonly { readonly value: string }[];
    readonly label?: unknown;
    readonly onValueChange?: (details: { readonly value: string[] }) => void;
  }) =>
    createElement('button', {
      'data-pick': String(props.label),
      onClick: () => props.onValueChange?.({ value: props.items.slice(0, 1).map((item) => item.value) }),
      type: 'button',
    }),
}));

type Command = Parameters<FinanceViewModel['execute']>[0];

const budget: BudgetLine = {
  category: 'Energie',
  id: 'budget-1',
  kind: 'COST',
  period: '2026-10',
  plannedMinor: 2_500_000,
  updatedAt: DateTime.makeUnsafe('2026-10-01T08:00:00Z'),
};

const closes: string[] = [];
const onClose = () => {
  closes.push('closed');
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  closes.length = 0;
});

afterEach(() => {
  unmountAll();
  rstest.unstubAllGlobals();
});

describe('planning forms save from Uložit only', () => {
  it.live('a new budget line is sent once by Uložit, never by Enter, and the dialog closes', () =>
    Effect.gen(function* step1() {
      const sent: Command[] = [];
      yield* mount(
        <BudgetEditor budgetMonth="2026-10" initial={newBudgetDraft()} onClose={onClose} vm={fakeVm(sent)} />,
      );
      expect(saveButton().disabled).toBe(true);
      expect(lastFooterButton()).toBe(saveButton());

      yield* typeInto('budget-planned', '30 000');
      yield* pressEnter('budget-planned');
      expect(sent).toEqual([]);

      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'UpsertBudgetLine')).toBe(true);
      expect(sent[0]).toMatchObject({ category: 'Energie', period: '2026-10', plannedMinor: 3_000_000 });
    }),
  );

  it.live('an untouched budget closes at once; typed input asks, and Zahodit změny closes without sending', () =>
    Effect.gen(function* step2() {
      const sent: Command[] = [];
      yield* mount(
        <BudgetEditor budgetMonth="2026-10" initial={newBudgetDraft()} onClose={onClose} vm={fakeVm(sent)} />,
      );
      yield* clickCancel;
      expect(closes).toEqual(['closed']);
      expect(leaveQuestion()).toBe(false);

      unmountAll();
      closes.length = 0;
      yield* mount(
        <BudgetEditor budgetMonth="2026-10" initial={newBudgetDraft()} onClose={onClose} vm={fakeVm(sent)} />,
      );
      yield* typeInto('budget-explanation', 'Zdražení energií');
      yield* clickCancel;
      expect(closes).toEqual([]);
      expect(leaveQuestion()).toBe(true);
      yield* clickDiscard;
      expect(closes).toEqual(['closed']);
      expect(sent).toEqual([]);
    }),
  );

  it.live('an edited budget line is refused as a conflict once someone else changed it, never overwritten', () =>
    Effect.gen(function* step3() {
      const sent: Command[] = [];
      const changed = { ...budget, plannedMinor: 9_900_000, updatedAt: DateTime.makeUnsafe('2026-10-02T08:00:00Z') };
      yield* mount(
        <BudgetEditor
          budgetMonth="2026-10"
          initial={editBudgetDraft(budget)}
          onClose={onClose}
          vm={fakeVm(sent, { state: { budgets: [changed] } })}
        />,
      );
      yield* typeInto('budget-planned', '26 000');
      yield* clickSave;
      yield* waitUntil(() => document.querySelector('[data-save-state="conflict"]') !== null);
      expect(sent).toEqual([]);
      expect(closes).toEqual([]);
    }),
  );

  it.live('the opening balance is sent once by Uložit and the dialog closes', () =>
    Effect.gen(function* step4() {
      const sent: Command[] = [];
      yield* mount(<OpeningBalanceEditor month="2026-10" onClose={onClose} vm={fakeVm(sent)} />);
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('opening-amount', '-12 500');
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toEqual([
        {
          _tag: 'SetOpeningBalance',
          actorLabel: 'Jana Nováková',
          openingBalanceMinor: -1_250_000,
          openingDate: '2026-10-01',
        },
      ]);
    }),
  );

  it.live('a plan item is sent once by Uložit, and its untouched form closes without asking', () =>
    Effect.gen(function* step5() {
      const sent: Command[] = [];
      yield* mount(<PlanItemEditor initial={newPlanDraft('2026-11-15')} onClose={onClose} vm={fakeVm(sent)} />);
      yield* clickCancel;
      expect(closes).toEqual(['closed']);

      unmountAll();
      closes.length = 0;
      yield* mount(<PlanItemEditor initial={newPlanDraft('2026-11-15')} onClose={onClose} vm={fakeVm(sent)} />);
      yield* typeInto('plan-title', 'Nájem nové haly');
      yield* typeInto('plan-amount', '45 000');
      yield* typeInto('plan-probability', '80');
      expect(lastFooterButton()).toBe(saveButton());
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'UpsertPlanItem')).toBe(true);
      expect(sent[0]).toMatchObject({
        amountMinor: 4_500_000,
        expectedDate: '2026-11-15',
        probabilityPercent: 80,
        title: 'Nájem nové haly',
      });
    }),
  );
});
