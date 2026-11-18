// @rstest-environment happy-dom
// The lease and stay form as a person uses it: one Save button last in the footer, typing changes only the draft, a
// save goes out once (an edit against the revision the draft was read at), and leaving with unsaved input asks first.
// The generated clients use the real Shell issuer and owner HTTP contracts, i18n and router.
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import { text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { useReducer } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import type { ApplyCommandActionProblem } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
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
import { moduleText, mountInRoute } from '../support/module-ui.ts';
import { button, buttons, click, field, pick, type } from '../support/occupancy-form.tsx';

const result = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ resourceRef: occupancyRef, revision: 5 });
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
const answers: Effect.Effect<typeof ApplyCommandResultSchema.Type, ApplyCommandActionProblem>[] = [];
let recordsAnswer = Schema.decodeUnknownSync(RecordsResponseSchema)({ occupancies: [], revision: 4 });

const OwnerActionApi = ApplyCommandActionApi.prefix('/property-leasing-api');
const OwnerRecordsApi = RecordsApi.prefix('/property-leasing-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'legal-agreements': '/legal-agreements-api',
    'party-registry': '/party-registry-api',
    'property-leasing': '/property-leasing-api',
    'property-portfolio': '/property-portfolio-api',
  }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          return answers.shift() ?? Effect.succeed(result);
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () => Effect.sync(() => recordsAnswer)),
    ),
  ),
);

const copy = moduleText('cs');
const labels = saveLabelsFor('cs');
const close = copy('property-leasing.demo.close');
const today = '2026-11-10';

const sent = () => commands;
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
  commands.length = 0;
  answers.length = 0;
  recordsAnswer = Schema.decodeUnknownSync(RecordsResponseSchema)({ occupancies: [], revision: 4 });
  closed.length = 0;
  created.length = 0;
});

afterEach(unmountAll);

describe('lease draft', () => {
  it.live('typing sends nothing; one Save sends the change once against the read revision, then closes', () =>
    Effect.gen(function* saveOnce() {
      yield* pinTestDocument;
      yield* mountInRoute(<Form mode="edit" />);
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
    }).pipe(Effect.provide(network)),
  );

  it.live('closing with unsaved input asks; Zůstat keeps it, Zahodit změny restores it and closes', () =>
    Effect.gen(function* leave() {
      yield* pinTestDocument;
      yield* mountInRoute(<Form mode="edit" />);
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
    }).pipe(Effect.provide(network)),
  );

  it.live('Uložit in the question saves once and then closes', () =>
    Effect.gen(function* saveAndLeave() {
      yield* pinTestDocument;
      yield* mountInRoute(<Form mode="edit" />);
      yield* type(monthly, '19000');
      yield* click(button(close));
      yield* click(buttons(labels.save).at(-1));
      yield* waitUntil(() => closed.length === 1);
      expect(sent()).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('someone else changed the draft: the save is refused as a conflict, never resent over it', () =>
    Effect.gen(function* refused() {
      answers.push(Effect.fail(conflictProblem));
      recordsAnswer = Schema.decodeUnknownSync(RecordsResponseSchema)({
        occupancies: [{ ...leaseDraft, startDate: '2027-01-01' }],
        revision: 7,
      });
      yield* pinTestDocument;
      yield* mountInRoute(<Form mode="edit" />);
      yield* type(monthly, '19000');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.conflict));
      expect(sent()).toHaveLength(1);
      expect(buttons(labels.reloadLatest)).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('another lease changed: the save is resent once against the fresh revision', () =>
    Effect.gen(function* resent() {
      answers.push(Effect.fail(conflictProblem));
      recordsAnswer = Schema.decodeUnknownSync(RecordsResponseSchema)({ occupancies: [leaseDraft], revision: 7 });
      yield* pinTestDocument;
      yield* mountInRoute(<Form mode="edit" />);
      yield* type(monthly, '19000');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.saved));
      expect(sent().map((payload) => payload.expectedRevision)).toEqual([4, 7]);
    }).pipe(Effect.provide(network)),
  );
});

describe('new lease and stay', () => {
  it.live('reads the required text of a required field in Czech', () =>
    Effect.gen(function* requiredText() {
      yield* pinTestDocument;
      yield* mountInRoute(<Form mode="stay" />);
      expect(document.body.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
      expect(document.querySelector('label[for="stay-people-count"]')?.textContent).toContain(requiredLabelFor('cs'));
    }).pipe(Effect.provide(network)),
  );

  it.live('an untouched new lease closes without asking', () =>
    Effect.gen(function* untouched() {
      yield* pinTestDocument;
      yield* mountInRoute(<Form mode="lease" />);
      expect(button(labels.save).disabled).toBe(true);
      yield* click(button(close));
      expect(buttons(labels.stay)).toHaveLength(0);
      expect(closed).toEqual(['lease']);
    }).pipe(Effect.provide(network)),
  );

  it.live('a filled stay is created by one Save and opened', () =>
    Effect.gen(function* createStay() {
      yield* pinTestDocument;
      yield* mountInRoute(<Form mode="stay" />);
      yield* pick(copy('property-leasing.demo.unit'), unitRef.resourceId);
      yield* pick(copy('property-leasing.demo.guest'), guestRef.resourceId);
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
    }).pipe(Effect.provide(network)),
  );

  it.live('closing a filled stay asks before the input is lost', () =>
    Effect.gen(function* leaveStay() {
      yield* pinTestDocument;
      yield* mountInRoute(<Form mode="stay" />);
      yield* type('stay-note', 'Pozdní příjezd');
      yield* click(button(close));
      expect(buttons(labels.discard)).toHaveLength(1);
      yield* click(button(labels.discard));
      expect(closed).toEqual(['stay']);
      expect(sent()).toHaveLength(0);
    }).pipe(Effect.provide(network)),
  );
});
