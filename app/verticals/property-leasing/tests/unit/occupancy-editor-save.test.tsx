// @rstest-environment happy-dom
// The lease and stay form as a person uses it: one Save button last in the footer, typing changes only the draft, a
// save goes out once (an edit against the revision the draft was read at), and leaving with unsaved input asks first.
// Only the generated clients, the reference credentials, the i18n runtime and the router are replaced.
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import type { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { Effect, Option } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { useReducer } from 'react';
import {
  initialEditorState,
  occupancyDraftOf,
  occupancyEditorActions,
  occupancyEditorReducer,
} from '../../src/routes/[lang]/najmy/editor-state.ts';
import type { OccupancyDraft } from '../../src/routes/[lang]/najmy/editor-state.ts';
import { createOccupancy, saveLeaseDraft } from '../../src/routes/[lang]/najmy/occupancy-command.ts';
import { stayDraftRecord, updateDraftCommand } from '../../src/routes/[lang]/najmy/occupancy-draft.ts';
import { OccupancyEditorPanel } from '../../src/routes/[lang]/najmy/occupancy-editor-panel.tsx';
import {
  conflictProblem,
  guestRef,
  leaseDraft,
  occupancyRef,
  references,
  unitRef,
} from '../fixtures/occupancy-draft.ts';
import {
  button,
  buttons,
  click,
  field,
  mount,
  pick,
  text,
  type,
  unmountAll,
  waitUntil,
} from '../support/occupancy-form.tsx';

const { apply, credentials, records } = rstest.hoisted(() => ({
  apply: rstest.fn(),
  credentials: rstest.fn(),
  records: rstest.fn(),
}));

rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: apply }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));
rstest.mock('@app/shared-contracts', () => {
  const actual = rstest.requireActual<{
    readonly makeReferenceGatewayCredentials: typeof makeReferenceGatewayCredentials;
  }>('@app/shared-contracts');
  return { ...actual, makeReferenceGatewayCredentials: credentials };
});
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => constVoid,
  useRouterState: () => '',
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const close = 'property-leasing.demo.close';
const today = '2026-11-10';

const sent = () => apply.mock.calls.map(([payload]) => payload);
const closed: string[] = [];
const created: string[] = [];

/** The page around the form: the editor reducer holds the draft, as on the lease screen. */
const Form = ({ mode }: { readonly mode: 'edit' | 'lease' | 'stay' }) => {
  const [state, dispatch] = useReducer(occupancyEditorReducer, today, (startDate) =>
    occupancyEditorReducer(
      initialEditorState(startDate),
      mode === 'edit'
        ? occupancyEditorActions.EDIT_DRAFT({ record: leaseDraft })
        : occupancyEditorActions.OPEN_DRAFT({ initialUnitId: '', mode, startDate }),
    ),
  );
  const editing = mode === 'edit' ? Option.some(leaseDraft) : Option.none();
  const handleChange = (input: keyof OccupancyDraft, value: string) =>
    dispatch(occupancyEditorActions.SET_INPUT({ field: input, value }));
  const handleRestore = (draft: OccupancyDraft) => dispatch(occupancyEditorActions.RESTORE_DRAFT({ draft }));
  return (
    <OccupancyEditorPanel
      customers={{ empty: true, items: [], loading: false, onOpenChange: constVoid, open: false }}
      draft={occupancyDraftOf(state)}
      editing={editing}
      guests={{
        busy: false,
        items: [{ label: guestRef.resourceId, value: guestRef.resourceId }],
        onQueryChange: constVoid,
        onSearch: constVoid,
        query: '',
      }}
      isValid={(draft) =>
        mode === 'edit'
          ? Option.isSome(updateDraftCommand(occupancyRef, draft))
          : Option.isSome(stayDraftRecord(draft, references, ''))
      }
      mode={mode === 'stay' ? 'stay' : 'lease'}
      onChange={handleChange}
      onClose={() => {
        closed.push(mode);
      }}
      onCreated={(resourceId) => {
        created.push(resourceId);
      }}
      onReload={constVoid}
      onRestore={handleRestore}
      onSave={(draft, save) =>
        mode === 'edit'
          ? saveLeaseDraft(leaseDraft, draft, save)
          : createOccupancy(draft, { expectedRevision: 4, kind: 'stay', references })
      }
      revision={4}
      units={[{ label: unitRef.resourceId, value: unitRef.resourceId }]}
    />
  );
};

const monthly = 'occupancy-rent-monthly';

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apply.mockReset();
  records.mockReset();
  credentials.mockReset();
  credentials.mockReturnValue(Effect.void);
  apply.mockReturnValue(Effect.succeed({ resourceRef: occupancyRef, revision: 5 }));
  closed.length = 0;
  created.length = 0;
});

afterEach(() => {
  unmountAll();
  rstest.unstubAllGlobals();
});

describe('lease draft', () => {
  it.effect('typing sends nothing; one Save sends the change once against the read revision, then closes', () =>
    Effect.gen(function* saveOnce() {
      yield* mount(<Form mode="edit" />);
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);

      yield* type(monthly, '19000');
      expect(text()).toContain(labels.unsaved);
      expect(sent()).toHaveLength(0);

      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.saved));
      expect(sent()).toEqual([
        {
          command: {
            _tag: 'UpdateDraft',
            endDate: null,
            occupancyRef,
            rentTerms: { currency: 'CZK', monthlyRentMinor: 1_900_000, paymentDay: 15, serviceChargesMinor: 0 },
            startDate: '2026-12-01',
          },
          expectedRevision: 4,
        },
      ]);

      yield* click(button(close));
      expect(buttons(labels.stay)).toHaveLength(0);
      expect(closed).toEqual(['edit']);
    }),
  );

  it.effect('closing with unsaved input asks; Zůstat keeps it, Zahodit změny restores it and closes', () =>
    Effect.gen(function* leave() {
      yield* mount(<Form mode="edit" />);
      yield* type(monthly, '19000');
      yield* click(button(close));
      expect(buttons(labels.discard)).toHaveLength(1);

      yield* click(button(labels.stay));
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      expect(field(monthly).value).toBe('19000');

      yield* click(button(close));
      yield* click(button(labels.discard));
      expect(closed).toEqual(['edit']);
      expect(field(monthly).value).toBe('18500');
      expect(sent()).toHaveLength(0);
    }),
  );

  it.effect('Uložit in the question saves once and then closes', () =>
    Effect.gen(function* saveAndLeave() {
      yield* mount(<Form mode="edit" />);
      yield* type(monthly, '19000');
      yield* click(button(close));
      yield* click(buttons(labels.save).at(-1));
      yield* waitUntil(() => closed.length === 1);
      expect(sent()).toHaveLength(1);
    }),
  );

  it.effect('someone else changed the draft: the save is refused as a conflict, never resent over it', () =>
    Effect.gen(function* refused() {
      apply.mockReturnValue(Effect.fail(conflictProblem));
      records.mockReturnValue(
        Effect.succeed({ occupancies: [{ ...leaseDraft, startDate: '2027-01-01' }], revision: 7 }),
      );
      yield* mount(<Form mode="edit" />);
      yield* type(monthly, '19000');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.conflict));
      expect(sent()).toHaveLength(1);
      expect(buttons(labels.reloadLatest)).toHaveLength(1);
    }),
  );

  it.effect('another lease changed: the save is resent once against the fresh revision', () =>
    Effect.gen(function* resent() {
      apply.mockReturnValueOnce(Effect.fail(conflictProblem));
      records.mockReturnValue(Effect.succeed({ occupancies: [leaseDraft], revision: 7 }));
      yield* mount(<Form mode="edit" />);
      yield* type(monthly, '19000');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.saved));
      expect(sent().map((payload) => payload.expectedRevision)).toEqual([4, 7]);
    }),
  );
});

describe('new lease and stay', () => {
  it.effect('reads the required text of a required field in Czech', () =>
    Effect.gen(function* requiredText() {
      yield* mount(<Form mode="stay" />);
      expect(document.body.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
      expect(document.querySelector('label[for="stay-people-count"]')?.textContent).toContain(requiredLabelFor('cs'));
    }),
  );

  it.effect('an untouched new lease closes without asking', () =>
    Effect.gen(function* untouched() {
      yield* mount(<Form mode="lease" />);
      expect(button(labels.save).disabled).toBe(true);
      yield* click(button(close));
      expect(buttons(labels.stay)).toHaveLength(0);
      expect(closed).toEqual(['lease']);
    }),
  );

  it.effect('a filled stay is created by one Save and opened', () =>
    Effect.gen(function* createStay() {
      yield* mount(<Form mode="stay" />);
      yield* pick('property-leasing.demo.unit', unitRef.resourceId);
      yield* pick('property-leasing.demo.guest', guestRef.resourceId);
      yield* type('occupancy-end-date', '2026-11-14');
      expect(button(labels.save).disabled).toBe(false);
      expect(sent()).toHaveLength(0);

      yield* click(button(labels.save));
      yield* waitUntil(() => created.length === 1);
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({
        command: {
          _tag: 'CreateDraft',
          record: { endDate: '2026-11-14', guestPartyRef: guestRef, kind: 'SHORT_STAY', peopleCount: 2, unitRef },
        },
        expectedRevision: 4,
      });
      expect(created).toEqual([occupancyRef.resourceId]);
    }),
  );

  it.effect('closing a filled stay asks before the input is lost', () =>
    Effect.gen(function* leaveStay() {
      yield* mount(<Form mode="stay" />);
      yield* type('stay-note', 'Pozdní příjezd');
      yield* click(button(close));
      expect(buttons(labels.discard)).toHaveLength(1);
      yield* click(button(labels.discard));
      expect(closed).toEqual(['stay']);
      expect(sent()).toHaveLength(0);
    }),
  );
});
