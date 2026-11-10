// @rstest-environment happy-dom
// The new-property form as the user sees the editor state: typing changes only the draft, nothing is sent until its
// Save runs, and that one save sends exactly one command. Only the generated clients are replaced.
import { EmployeeIdSchema } from '@app/workforce/resources/employee';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { PropertyEditor } from '../../src/routes/[lang]/nemovitosti/use-property-editor.ts';
import { usePropertyEditor } from '../../src/routes/[lang]/nemovitosti/use-property-editor.ts';

const { apply, records } = rstest.hoisted(() => ({ apply: rstest.fn(), records: rstest.fn() }));

rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: apply }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));

const employeeId = '75000000-0000-4000-8000-000000000001';
const employees = [
  { active: true, fullName: 'Jana Nováková', id: Schema.decodeUnknownSync(EmployeeIdSchema)(employeeId) },
];
const registerRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 4,
  units: [],
});

const rendered: PropertyEditor[] = [];
const Harness = ({ onRender }: { readonly onRender: (editor: PropertyEditor) => void }) => {
  const editor = usePropertyEditor(registerRecords, employees, () => {});
  onRender(editor);
  return null;
};

/** Mounts the harness and returns the unmount; every React update runs inside `act`. */
const mountHarness = (): (() => void) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <Harness
        onRender={(editor) => {
          rendered.push(editor);
        }}
      />,
    );
  });
  return () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
};

const current = (): PropertyEditor => {
  const latest = rendered.at(-1);
  if (latest === undefined) {
    throw new Error('the editor is not mounted');
  }
  return latest;
};

/** Runs editor calls inside `act` so their state updates land before the next step. */
const perform = (action: (editor: PropertyEditor) => void) =>
  Effect.sync(() => {
    act(() => {
      action(current());
    });
  });

beforeEach(() => {
  apply.mockReset();
  records.mockReset();
  rendered.length = 0;
  apply.mockReturnValue(Effect.succeed({ resourceRef: { resourceId: 'p-1' }, revision: 5 }));
});

it.live('typing in the new-property form sends nothing, not even after a pause', () =>
  Effect.gen(function* typingSendsNothing() {
    const unmount = mountHarness();
    yield* perform((editor) => editor.begin());
    yield* perform((editor) => {
      editor.change('code', 'NEW-01');
      editor.change('name', 'Nová budova');
      editor.change('address', 'Hlavní 1');
      editor.change('propertyType', 'Komerční');
      editor.changeResponsibleEmployees([employeeId]);
    });
    expect(current().createDraft.dirty).toBe(true);
    expect(current().createDraft.canSave).toBe(true);
    yield* Effect.sleep('1 second');
    expect(apply).not.toHaveBeenCalled();
    unmount();
    yield* Effect.sleep('100 millis');
    expect(apply).not.toHaveBeenCalled();
    expect(records).not.toHaveBeenCalled();
  }),
);

it.live('the Save of the new-property form sends exactly one command', () =>
  Effect.gen(function* saveSendsOnce() {
    const unmount = mountHarness();
    yield* perform((editor) => {
      editor.begin();
      editor.change('code', 'NEW-02');
      editor.change('name', 'Druhá budova');
      editor.change('address', 'Hlavní 2');
      editor.change('propertyType', 'Komerční');
      editor.changeResponsibleEmployees([employeeId]);
    });
    yield* perform((editor) => editor.createDraft.save());
    yield* Effect.sleep('100 millis');
    expect(apply).toHaveBeenCalledTimes(1);
    unmount();
  }),
);

it.live('an invalid new-property draft is not saved and its Save stays disabled', () =>
  Effect.gen(function* invalidDraft() {
    const unmount = mountHarness();
    yield* perform((editor) => {
      editor.begin();
      editor.change('code', 'NEW-03');
    });
    expect(current().createDraft.status).toBe('invalid');
    expect(current().createDraft.canSave).toBe(false);
    yield* perform((editor) => editor.createDraft.save());
    yield* Effect.sleep('100 millis');
    expect(apply).not.toHaveBeenCalled();
    unmount();
  }),
);
