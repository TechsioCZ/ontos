// @rstest-environment happy-dom
// The planning forms (budget line, opening balance, plan item) send their one command only from the shared Save button
// ("Uložit"), last in the footer: typing and Enter change only the draft, an untouched form closes without asking, and
// an edit over someone else's newer version is refused as a conflict. The forms use the real module i18n, router
// and select components; the supplied view model records commands at the form boundary.
import { DateTime, Deferred, Effect, Predicate } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { unmountAll } from '@app/admin-ui/testing/module-ui';
import { Profiler } from 'react';
import { mountInRoute } from '../support/module-ui.ts';
import type { BudgetLine } from '../../shared/apis/records.ts';
import { editBudgetDraft, newBudgetDraft } from '../../src/routes/[lang]/finance/budget-draft.ts';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { newPlanDraft } from '../../src/routes/[lang]/finance/plan-item-draft.ts';
import { PlanItemEditor } from '../../src/routes/[lang]/finance/plan-item-editor.tsx';
import { BudgetEditor, OpeningBalanceEditor } from '../../src/routes/[lang]/finance/planning-forms.tsx';
import { clickSave, fakeVm, saveButton, typeInto } from './finance-form-harness.ts';

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
let saveClosed = Deferred.makeUnsafe<true>();
const onClose = () => {
  closes.push('closed');
  Deferred.doneUnsafe(saveClosed, Effect.succeed(true));
};

beforeEach(() => {
  closes.length = 0;
  saveClosed = Deferred.makeUnsafe<true>();
});

afterEach(unmountAll);

describe('planning forms save from Uložit only', () => {
  it.live('a budget line sends its category, period and entered amount in minor units', () =>
    Effect.gen(function* step1() {
      const sent: Command[] = [];
      yield* mountInRoute(
        <BudgetEditor budgetMonth="2026-10" initial={newBudgetDraft()} onClose={onClose} vm={fakeVm(sent)} />,
      );
      expect(saveButton().disabled).toBe(true);

      yield* typeInto('budget-planned', '30 000');

      yield* clickSave;
      yield* Deferred.await(saveClosed);
      expect(closes).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'UpsertBudgetLine')).toBe(true);
      expect(sent[0]).toMatchObject({ category: 'Energie', period: '2026-10', plannedMinor: 3_000_000 });
    }),
  );

  it.live('an edited budget line is refused as a conflict once someone else changed it, never overwritten', () =>
    Effect.gen(function* step3() {
      const sent: Command[] = [];
      const changed = { ...budget, plannedMinor: 9_900_000, updatedAt: DateTime.makeUnsafe('2026-10-02T08:00:00Z') };
      const conflicted = yield* Deferred.make<true>();
      yield* mountInRoute(
        <Profiler
          id="budget-conflict"
          onRender={() => {
            // The controller publishes conflict only after the preflight save Effect has finished.
            if (document.querySelector('[data-save-state="conflict"]') !== null) {
              Deferred.doneUnsafe(conflicted, Effect.succeed(true));
            }
          }}
        >
          <BudgetEditor
            budgetMonth="2026-10"
            initial={editBudgetDraft(budget)}
            onClose={onClose}
            vm={fakeVm(sent, { state: { budgets: [changed] } })}
          />
        </Profiler>,
      );
      yield* typeInto('budget-planned', '26 000');
      yield* clickSave;
      yield* Deferred.await(conflicted);
      expect(sent).toEqual([]);
      expect(closes).toEqual([]);
    }),
  );

  it.live('the opening balance is sent once by Uložit and the dialog closes', () =>
    Effect.gen(function* step4() {
      const sent: Command[] = [];
      yield* mountInRoute(<OpeningBalanceEditor month="2026-10" onClose={onClose} vm={fakeVm(sent)} />);
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('opening-amount', '-12 500');
      yield* clickSave;
      yield* Deferred.await(saveClosed);
      expect(closes).toHaveLength(1);
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

  it.live('a plan item sends its title, expected date, minor amount and probability', () =>
    Effect.gen(function* step5() {
      const sent: Command[] = [];
      yield* mountInRoute(<PlanItemEditor initial={newPlanDraft('2026-11-15')} onClose={onClose} vm={fakeVm(sent)} />);
      yield* typeInto('plan-title', 'Nájem nové haly');
      yield* typeInto('plan-amount', '45 000');
      yield* typeInto('plan-probability', '80');

      yield* clickSave;
      yield* Deferred.await(saveClosed);
      expect(closes).toHaveLength(1);
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
