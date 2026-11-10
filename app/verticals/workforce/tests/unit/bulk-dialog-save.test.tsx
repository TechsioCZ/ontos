// @rstest-environment happy-dom
// The bulk employee dialogs apply their change only from the shared Save button ("Uložit"), last in the footer:
// typing and Enter change only the draft. Only the i18n runtime and the router blocker are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkforceCommand } from '../../shared/actions/apply-command.ts';
import { EmployeeIdSchema } from '../../shared/apis/records.ts';
import { BulkDepartmentDialog, BulkRoleDialog } from '../../src/routes/[lang]/prodej/zamestnanci/employee-dialogs.tsx';
import type { CommitCommand } from '../../src/routes/[lang]/prodej/zamestnanci/employee-dialogs.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const ids = [Schema.decodeUnknownSync(EmployeeIdSchema)('7a000000-0000-4000-8000-000000000001')];

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const views: (() => void)[] = [];

const mount = async (element: ReactElement) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  views.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(element);
  });
  await settle();
};

const recording =
  (sent: WorkforceCommand[]): CommitCommand =>
  (build) =>
    build.pipe(
      Effect.map((command) => {
        sent.push(command);
        return 'saved' as const;
      }),
    );

const footerButtons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.closest('form') === null);

const saveButton = (): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromNullishOr(footerButtons().find((button) => (button.textContent ?? '').trim() === labels.save)),
  );

const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));

const typeInto = async (id: string, value: string) => {
  const input = field(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

const clickSave = async () => {
  await act(async () => {
    saveButton().click();
  });
  await settle();
};

/** Whether the Uložit / Zahodit změny / Zůstat question is up. */
const leaveQuestion = (): boolean => document.querySelector('[role="alertdialog"]') !== null;

const clickCancel = async () => {
  const cancel = Option.getOrThrow(
    Option.fromNullishOr(
      footerButtons().find((button) => (button.textContent ?? '').trim() === 'workforce.pages.employees.form.cancel'),
    ),
  );
  await act(async () => {
    cancel.click();
  });
  await settle();
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  for (const unmount of views.splice(0)) {
    unmount();
  }
  rstest.unstubAllGlobals();
});

describe('bulk employee dialogs', () => {
  it.live('the department change is applied once by Uložit, never by Enter', () =>
    Effect.promise(async () => {
      const sent: WorkforceCommand[] = [];
      const saved: string[] = [];
      await mount(
        <BulkDepartmentDialog
          commit={recording(sent)}
          ids={ids}
          onClose={constVoid}
          onSaved={() => {
            saved.push('saved');
          }}
        />,
      );
      expect(saveButton().disabled).toBe(true);
      expect(footerButtons().at(-1)).toBe(saveButton());

      await typeInto('bulk-department', 'Obchod');
      await act(async () => {
        field('bulk-department').form?.requestSubmit();
      });
      expect(sent).toEqual([]);

      await clickSave();
      expect(sent).toEqual([{ _tag: 'BulkUpdateEmployees', ids, patch: { department: 'Obchod' } }]);
      expect(saved).toEqual(['saved']);
    }),
  );

  it.live('the role the dialog opens with is applied by the first Uložit', () =>
    Effect.promise(async () => {
      const sent: WorkforceCommand[] = [];
      await mount(<BulkRoleDialog commit={recording(sent)} ids={ids} onClose={constVoid} onSaved={constVoid} />);
      expect(saveButton().disabled).toBe(false);
      await clickSave();
      expect(sent).toEqual([{ _tag: 'BulkUpdateEmployees', ids, patch: { role: 'SALES_REP' } }]);
    }),
  );

  it.live('the role dialog closes untouched without asking about unsaved changes', () =>
    Effect.promise(async () => {
      const closed: string[] = [];
      const sent: WorkforceCommand[] = [];
      await mount(
        <BulkRoleDialog
          commit={recording(sent)}
          ids={ids}
          onClose={() => {
            closed.push('closed');
          }}
          onSaved={constVoid}
        />,
      );
      await clickCancel();
      expect(closed).toEqual(['closed']);
      expect(leaveQuestion()).toBe(false);
      expect(sent).toEqual([]);
    }),
  );

  it.live('the department dialog asks before closing once something was typed', () =>
    Effect.promise(async () => {
      const closed: string[] = [];
      await mount(
        <BulkDepartmentDialog
          commit={recording([])}
          ids={ids}
          onClose={() => {
            closed.push('closed');
          }}
          onSaved={constVoid}
        />,
      );
      await typeInto('bulk-department', 'Obchod');
      await clickCancel();
      expect(closed).toEqual([]);
      expect(leaveQuestion()).toBe(true);
    }),
  );
});
