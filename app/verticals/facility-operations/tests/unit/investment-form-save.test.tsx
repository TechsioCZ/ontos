// @rstest-environment happy-dom
// An investment plan item is created or edited on the shared Uložit only. An edit saves against the read its draft
// came from: someone else's newer change is refused as a conflict, and "Načíst aktuální verzi" opens the latest.
import { Effect, Predicate, Schema } from 'effect';
import { constUndefined } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { AssetsStateSchema, InvestmentSchema } from '../../shared/domain/assets.ts';
import type { Investment } from '../../shared/domain/assets.ts';
import { InvestmentForm } from '../../src/routes/[lang]/provoz/majetek/investments.tsx';
import {
  agendaAt,
  bodyText,
  changeElsewhere,
  click,
  fieldValue,
  labels,
  mountPanel,
  runnerAt,
  save,
  typeInto,
  unmountPanels,
} from './draft-base-fixture.ts';
import type { FakeAgenda } from './draft-base-fixture.ts';
import { recordingRunner, saveSent } from './form-save-fixture.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/routes/[lang]/provoz/majetek/property-tree.ts', () => ({
  locationItems: () => [],
  owningPropertyId: constUndefined,
  usePropertyTree: () => ({ status: 'loading' }),
}));
rstest.mock('../../src/ui/change-history.tsx', () => ({ ChangeHistory: () => null }));

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const investmentAt = (updatedAt: string, responsible: string): Investment =>
  Schema.decodeUnknownSync(InvestmentSchema)({
    createdAt: '2026-10-20T08:00:00Z',
    createdBy: actor,
    id: 'investment-1',
    plannedAmountMinor: 25_000_000,
    plannedDate: '2027-04-01',
    priority: 'medium',
    responsible,
    status: 'planned',
    title: 'Výměna kotle',
    updatedAt,
    updatedBy: actor,
  });
const opened = investmentAt('2026-10-20T08:00:00Z', 'Jan Novák');
const theirs = investmentAt('2026-10-21T09:30:00Z', 'Eva Malá');
const stateWith = (investment?: Investment) =>
  Schema.decodeUnknownSync(AssetsStateSchema)({
    assets: [],
    investments: investment === undefined ? [] : [Schema.encodeSync(InvestmentSchema)(investment)],
  });
const saved: string[] = [];
const onSaved = () => {
  saved.push('saved');
};
const editOf = (investment: Investment, agenda: FakeAgenda, revision: number) =>
  createElement(InvestmentForm, {
    investment: opened,
    onSubmit: { onSaved, run: runnerAt(agenda, revision) },
    state: stateWith(investment),
  });

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saved.length = 0;
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('investment plan item', () => {
  it.live('a new item is created once with the typed values', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(createElement(InvestmentForm, { onSubmit: { onSaved, run: runner.run }, state: stateWith() }));
      yield* typeInto('#investment-title', 'Nová střecha');
      yield* typeInto('#investment-planned', '400 000');
      yield* typeInto('#investment-planned-date', '2027-06-01');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({
          _tag: 'AssetInvestmentCreate',
          plannedAmountMinor: 40_000_000,
          plannedDate: '2027-06-01',
          title: 'Nová střecha',
        }),
      ]);
      expect(saved).toEqual(['saved']);
    }),
  );

  it.live('an edit over someone else’s newer change is refused as a conflict; reload latest takes their version', () =>
    Effect.gen(function* scenario() {
      const agenda = agendaAt(3);
      const panel = yield* mountPanel(editOf(opened, agenda, 3));
      yield* typeInto('#investment-responsible', 'Petr Dvořák');
      changeElsewhere(agenda);
      yield* panel.render(editOf(theirs, agenda, 4));
      yield* save(agenda, 1);
      expect(agenda.applied.map((entry) => entry.expectedRevision)).toEqual([3]);
      expect(bodyText()).toContain(labels.conflict);
      expect(saved).toEqual([]);
      yield* click(labels.reloadLatest);
      expect(fieldValue('#investment-responsible')).toBe('Eva Malá');
      yield* typeInto('#investment-responsible', 'Petr Dvořák');
      yield* save(agenda, 2);
      expect(agenda.applied.map((entry) => entry.expectedRevision)).toEqual([3, 4]);
      expect(Predicate.isTagged(agenda.applied[1]?.command, 'AssetInvestmentUpdate')).toBe(true);
      expect(agenda.applied[1]?.command).toMatchObject({ investmentId: opened.id, responsible: 'Petr Dvořák' });
      expect(saved).toEqual(['saved']);
    }),
  );
});
