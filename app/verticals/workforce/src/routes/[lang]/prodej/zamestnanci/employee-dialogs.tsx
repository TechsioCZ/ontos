import { SidePanel, dialogCloseLabel } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Effect } from 'effect';
import { useState } from 'react';
import type { WorkforceCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Employee, EmployeeId, EmployeeRole } from '../../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  bulkCommand,
  createCommand,
  draftErrors,
  draftFromEmployee,
  emptyDraft,
  employeeRoles,
  isDepartmentName,
  newEmployeeId,
  roleFromValue,
  updateCommand,
} from './employee-model.ts';
import type { CommitOutcome, DraftField, EmployeeDraft } from './employee-model.ts';

const key = 'workforce.pages.employees';

/** Runs one command. The page owns the revision, the toast and the list reload. */
export type CommitCommand = (
  build: Effect.Effect<WorkforceCommand>,
  successKey: string,
) => Effect.Effect<CommitOutcome>;

const commitErrorKey = (outcome: CommitOutcome): string => {
  if (outcome === 'conflict') {
    return `${key}.errors.conflict`;
  }
  if (outcome === 'forbidden') {
    return `${key}.errors.forbidden`;
  }
  return `${key}.errors.save`;
};

/** `displayValue` feeds the hidden native option, which otherwise shows the raw role code to assistive tech and innerText. */
const roleItemsOf = (translate: (key: string) => string) =>
  employeeRoles.map((role) => {
    const label = translate(`${key}.roles.${role}`);
    return { displayValue: label, label, value: role };
  });

/** Select labels inherit the surrounding font size; FormInput labels use the `md` label token. Match them. */
const roleLabelProps = { className: 'text-label-md' };

const closeWhenDismissed =
  (onClose: () => void) =>
  (details: { readonly open: boolean }): void => {
    if (!details.open) {
      onClose();
    }
  };

/**
 * Create (employee is null) or edit one Employee in a right-hand dialog. Every dialog on this page holds a draft,
 * so an outside click keeps it open; Escape, the close button and Zrušit close it.
 */
export const EmployeeFormDialog = ({
  commit,
  employee,
  onClose,
}: {
  readonly commit: CommitCommand;
  readonly employee: Employee | null;
  readonly onClose: () => void;
}) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<EmployeeDraft>(() =>
    employee === null ? emptyDraft : draftFromEmployee(employee),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  /** Set when the server reports that another Employee already uses the typed e-mail. */
  const [emailTaken, setEmailTaken] = useState(false);
  const errors = draftErrors(draft);
  const set = (patch: Partial<EmployeeDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const fieldStatus = (field: DraftField) =>
    submitted && errors.includes(field)
      ? { helpText: t(`${key}.errors.${field}`), validateStatus: 'error' as const }
      : {};
  const emailStatus = emailTaken
    ? { helpText: t(`${key}.errors.emailTaken`), validateStatus: 'error' as const }
    : fieldStatus('email');
  const roleItems = roleItemsOf(t);

  const submit = () => {
    setSubmitted(true);
    if (errors.length > 0) {
      return;
    }
    setBusy(true);
    setServerError(null);
    const build =
      employee === null
        ? newEmployeeId.pipe(Effect.map((id) => createCommand(id, draft)))
        : Effect.succeed(updateCommand(employee.id, draft));
    void browserRuntime.runPromise(
      commit(build, `${key}.toast.saved`).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setBusy(false);
            if (outcome === 'saved') {
              onClose();
            } else if (outcome === 'duplicateEmail') {
              setEmailTaken(true);
            } else {
              setServerError(t(commitErrorKey(outcome)));
            }
          }),
        ),
      ),
    );
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(`${key}.form.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${key}.form.saving`)} onClick={submit} variant="primary">
            {t(employee === null ? `${key}.form.create` : `${key}.form.save`)}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      size="md"
      title={t(employee === null ? `${key}.form.createTitle` : `${key}.form.editTitle`)}
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {serverError !== null && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <FormInput
          autoComplete="off"
          id="employee-full-name"
          label={t(`${key}.form.fullName`)}
          name="fullName"
          onChange={(event) => set({ fullName: event.target.value })}
          required
          value={draft.fullName}
          {...fieldStatus('fullName')}
        />
        <FormInput
          autoComplete="email"
          id="employee-email"
          label={t(`${key}.form.email`)}
          name="email"
          onChange={(event) => {
            setEmailTaken(false);
            set({ email: event.target.value });
          }}
          required
          type="email"
          value={draft.email}
          {...emailStatus}
        />
        <FormInput
          autoComplete="tel"
          id="employee-phone"
          label={t(`${key}.form.phone`)}
          name="phone"
          onChange={(event) => set({ phone: event.target.value })}
          type="tel"
          value={draft.phone}
          {...fieldStatus('phone')}
        />
        <SelectTemplate
          items={roleItems}
          label={t(`${key}.form.role`)}
          labelProps={roleLabelProps}
          name="role"
          onValueChange={(details) => {
            const next = roleFromValue(details.value[0]);
            if (next !== null) {
              set({ role: next });
            }
          }}
          placeholder={t('workforce.selectPlaceholder')}
          value={[draft.role]}
        />
        <FormInput
          autoComplete="off"
          id="employee-department"
          label={t(`${key}.form.department`)}
          name="department"
          onChange={(event) => set({ department: event.target.value })}
          required
          value={draft.department}
          {...fieldStatus('department')}
        />
        <Switch checked={draft.active} onCheckedChange={(checked) => set({ active: checked })}>
          {t(`${key}.form.active`)}
        </Switch>
      </form>
    </SidePanel>
  );
};

/** Bulk department change: one text field applied to every selected Employee. */
export const BulkDepartmentDialog = ({
  commit,
  ids,
  onClose,
  onSaved,
}: {
  readonly commit: CommitCommand;
  readonly ids: readonly EmployeeId[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const { t } = useModernI18n();
  const [department, setDepartment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const trimmed = department.trim();
  const invalid = submitted && !isDepartmentName(trimmed);

  const submit = () => {
    setSubmitted(true);
    if (!isDepartmentName(trimmed)) {
      return;
    }
    setBusy(true);
    setServerError(null);
    void browserRuntime.runPromise(
      commit(Effect.succeed(bulkCommand(ids, { department: trimmed })), `${key}.toast.bulkSaved`).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setBusy(false);
            if (outcome === 'saved') {
              onSaved();
            } else {
              setServerError(t(commitErrorKey(outcome)));
            }
          }),
        ),
      ),
    );
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(`${key}.form.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${key}.form.saving`)} onClick={submit} variant="primary">
            {t(`${key}.bulk.apply`)}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      closeOnInteractOutside={false}
      customTrigger
      description={t(`${key}.bulk.description`, { total: ids.length })}
      onOpenChange={closeWhenDismissed(onClose)}
      open
      title={t(`${key}.bulk.departmentTitle`)}
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {serverError !== null && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <FormInput
          autoComplete="off"
          id="bulk-department"
          label={t(`${key}.form.department`)}
          name="department"
          onChange={(event) => setDepartment(event.target.value)}
          required
          value={department}
          {...(invalid ? { helpText: t(`${key}.errors.department`), validateStatus: 'error' as const } : {})}
        />
      </form>
    </Dialog>
  );
};

/** Bulk role change: one role applied to every selected Employee. */
export const BulkRoleDialog = ({
  commit,
  ids,
  onClose,
  onSaved,
}: {
  readonly commit: CommitCommand;
  readonly ids: readonly EmployeeId[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const { t } = useModernI18n();
  const [role, setRole] = useState<EmployeeRole>('SALES_REP');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const roleItems = roleItemsOf(t);

  const submit = () => {
    setBusy(true);
    setServerError(null);
    void browserRuntime.runPromise(
      commit(Effect.succeed(bulkCommand(ids, { role })), `${key}.toast.bulkSaved`).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setBusy(false);
            if (outcome === 'saved') {
              onSaved();
            } else {
              setServerError(t(commitErrorKey(outcome)));
            }
          }),
        ),
      ),
    );
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(`${key}.form.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${key}.form.saving`)} onClick={submit} variant="primary">
            {t(`${key}.bulk.apply`)}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      closeOnInteractOutside={false}
      customTrigger
      description={t(`${key}.bulk.description`, { total: ids.length })}
      onOpenChange={closeWhenDismissed(onClose)}
      open
      title={t(`${key}.bulk.roleTitle`)}
    >
      <div className="flex flex-col gap-200 py-200">
        {serverError !== null && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <SelectTemplate
          items={roleItems}
          label={t(`${key}.form.role`)}
          labelProps={roleLabelProps}
          name="bulkRole"
          onValueChange={(details) => {
            const next = roleFromValue(details.value[0]);
            if (next !== null) {
              setRole(next);
            }
          }}
          placeholder={t('workforce.selectPlaceholder')}
          value={[role]}
        />
      </div>
    </Dialog>
  );
};
