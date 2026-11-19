// @rstest-environment happy-dom
// Bulk dialogs must send the selected employees and the module-specific patch.
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import { acted, unmountAll } from '@app/admin-ui/testing/module-ui';
import { Deferred, Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, describe, expect, it } from 'effect-rstest';
import type { WorkforceCommand } from '../../shared/actions/apply-command.ts';
import { EmployeeIdSchema } from '../../shared/apis/records.ts';
import { BulkDepartmentDialog, BulkRoleDialog } from '../../src/routes/[lang]/prodej/zamestnanci/employee-dialogs.tsx';
import type { CommitCommand } from '../../src/routes/[lang]/prodej/zamestnanci/employee-dialogs.tsx';
import { mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const ids = [Schema.decodeUnknownSync(EmployeeIdSchema)('7a000000-0000-4000-8000-000000000001')];

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

const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const clickSave = () =>
  acted(() => {
    saveButton().click();
  });

afterEach(unmountAll);

describe('bulk employee dialogs', () => {
  it.live('applies the department patch to the selected employees', () =>
    Effect.gen(function* departmentSave() {
      const sent: WorkforceCommand[] = [];
      const saved: string[] = [];
      const saveFinished = yield* Deferred.make<string>();
      yield* mountInRoute(
        <BulkDepartmentDialog
          commit={recording(sent)}
          ids={ids}
          onClose={constVoid}
          onSaved={() => {
            saved.push('saved');
            Deferred.doneUnsafe(saveFinished, Effect.succeed('finished'));
          }}
        />,
      );

      yield* typeInto('bulk-department', 'Obchod');

      yield* clickSave();
      // afterSave runs only once the injected commit and the draft controller have finished.
      yield* Deferred.await(saveFinished);
      expect(sent).toEqual([{ _tag: 'BulkUpdateEmployees', ids, patch: { department: 'Obchod' } }]);
      expect(saved).toEqual(['saved']);
    }),
  );

  it.live('the role the dialog opens with is applied by the first Uložit', () =>
    Effect.gen(function* openingRoleSave() {
      const sent: WorkforceCommand[] = [];
      const saveFinished = yield* Deferred.make<string>();
      yield* mountInRoute(
        <BulkRoleDialog
          commit={recording(sent)}
          ids={ids}
          onClose={constVoid}
          onSaved={() => {
            Deferred.doneUnsafe(saveFinished, Effect.succeed('finished'));
          }}
        />,
      );
      expect(saveButton().disabled).toBe(false);
      yield* clickSave();
      // afterSave runs only once the injected commit and the draft controller have finished.
      yield* Deferred.await(saveFinished);
      expect(sent).toEqual([{ _tag: 'BulkUpdateEmployees', ids, patch: { role: 'SALES_REP' } }]);
    }),
  );

  it.live('reads the required text of a required field in Czech', () =>
    Effect.gen(function* requiredFieldCopy() {
      yield* mountInRoute(
        <BulkDepartmentDialog commit={recording([])} ids={ids} onClose={constVoid} onSaved={constVoid} />,
      );
      expect(field('bulk-department').labels?.[0]?.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
    }),
  );
});
