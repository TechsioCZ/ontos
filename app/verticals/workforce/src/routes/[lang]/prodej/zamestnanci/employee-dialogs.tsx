import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useDraftSave,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { Effect, Option, Predicate, Schema } from 'effect';
import { Url } from 'effect/http';
import { useState } from 'react';
import type { WorkforceCommand } from '../../../../../shared/actions/apply-command.ts';
import { EmployeeIdSchema } from '../../../../../shared/apis/records.ts';
import type { Employee, EmployeeId, EmployeeRole, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  bulkCommand,
  createCommand,
  draftErrors,
  draftFromEmployee,
  emptyDraft,
  employeeRoles,
  errorFieldKey,
  employeeSaveResult,
  isDepartmentName,
  listedFieldsOf,
  newEmployeeId,
  roleFromValue,
  sameDraft,
  updateCommand,
} from './employee-model.ts';
import type { CommitOutcome, DraftField, EditCommitResult, EmployeeDraft } from './employee-model.ts';

const RESIZE_LABEL_KEY = 'workforce.sidePanel.resize';

const key = 'workforce.pages.employees';
const employeeFormId = 'employee-form';
const selectPlaceholder = 'workforce.selectPlaceholder';

/** Fields a saved command shows on the rows of `ids` before the list reread settles. */
export interface ShownEdit {
  readonly ids: readonly EmployeeId[];
  readonly patch: Partial<Employee>;
}

/**
 * Runs one command. The page owns the revision, the toast and the list reload. `shown` is applied to the rows of `ids`
 * as soon as the command saves, so the table matches the toast while the reread is still on its way.
 */
export type CommitCommand = (
  build: Effect.Effect<WorkforceCommand>,
  successKey: string,
  shown?: ShownEdit,
) => Effect.Effect<CommitOutcome>;

/**
 * Runs one Save of the edit panel with the draft's base revision: the new revision once saved, `proposed` when the
 * change was parked for approval, else why not.
 */
export type EditCommitCommand = (
  command: WorkforceCommand,
  expectedRevision: number,
  shown: ShownEdit,
) => Effect.Effect<EditCommitResult>;

/** What a copied employees URL names: one exact employee, nothing, or an explicit invalid selection. */
export type EmployeeSearchTarget =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly id: EmployeeId; readonly kind: 'id' };

/** One Schema boundary owns the native query-string reading; no route code reads single parameters by hand. */
const EmployeeSearchQuerySchema = Schema.RecordFromUrlParams.pipe(
  Schema.decodeTo(
    Schema.Struct({
      employeeId: Schema.optionalKey(EmployeeIdSchema),
    }),
  ),
);

/** The native query selection of the page (`?employeeId=`); an invalid value is explicit, never a fallback. */
export const employeeSearchTargetFromSearchStr = (searchStr: string): EmployeeSearchTarget =>
  Option.match(
    Schema.decodeOption(EmployeeSearchQuerySchema)(Url.urlParams(new URL(searchStr, 'https://workforce.invalid/'))),
    {
      onNone: (): EmployeeSearchTarget => ({ kind: 'invalid' }),
      onSome: ({ employeeId }): EmployeeSearchTarget =>
        employeeId === undefined ? { kind: 'absent' } : { id: employeeId, kind: 'id' },
    },
  );

const EmployeeSearchLoadStatusSchema = Schema.Literals(['error', 'forbidden', 'loading', 'ready']);
export type EmployeeSearchLoadStatus = typeof EmployeeSearchLoadStatusSchema.Type;

export type EmployeeSearchSelection =
  | { readonly status: 'none' | 'invalid' }
  | { readonly employeeId: EmployeeId; readonly status: 'loading' | 'forbidden' | 'unavailable' | 'missing' }
  | { readonly employee: Employee; readonly employeeId: EmployeeId; readonly status: 'ready' };

/**
 * Resolves the copied target against the one authorized, unfiltered employees read of the current company. A target
 * that is not in that read is never substituted by the first row: absence means missing or forbidden and stays an
 * honest, non-disclosing unavailable selection.
 */
export const employeeSearchSelection = ({
  items,
  load,
  target,
}: {
  readonly items: readonly Employee[];
  readonly load: EmployeeSearchLoadStatus;
  readonly target: EmployeeSearchTarget;
}): EmployeeSearchSelection => {
  if (target.kind === 'absent') {
    return { status: 'none' };
  }
  if (target.kind === 'invalid') {
    return { status: 'invalid' };
  }
  const { id: employeeId } = target;
  if (load !== 'ready') {
    return { employeeId, status: load === 'error' ? 'unavailable' : load };
  }
  const employee = items.find(({ id }) => id === employeeId);
  return employee === undefined ? { employeeId, status: 'missing' } : { employee, employeeId, status: 'ready' };
};

/** A target panel never replaces a dialog that already holds a draft; only a fresh, undismissed target opens itself. */
export const shouldOpenEmployeeSearchTarget = ({
  activeDialogOpened,
  dismissedEmployeeId,
  selection,
}: {
  readonly activeDialogOpened: boolean;
  readonly dismissedEmployeeId: string | null;
  readonly selection: EmployeeSearchSelection;
}): boolean => selection.status === 'ready' && !activeDialogOpened && selection.employeeId !== dismissedEmployeeId;

/** A reader without write opens the same detail read-only; only a writable reader gets the autosaving edit panel. */
export const employeeSearchPanelMode = (canWrite: boolean): 'edit' | 'read-only' => (canWrite ? 'edit' : 'read-only');

export interface EmployeeSearchNotice {
  readonly labelKey: string;
  readonly retry: boolean;
  readonly tone: 'error' | 'warning';
}

/** The honest, non-disclosing notice of a copied target that is not currently available to this reader. */
export const employeeSearchNotice = (selection: EmployeeSearchSelection): EmployeeSearchNotice | undefined => {
  if (selection.status === 'forbidden') {
    return { labelKey: `${key}.empty.forbidden`, retry: false, tone: 'error' };
  }
  if (selection.status === 'invalid' || selection.status === 'missing' || selection.status === 'unavailable') {
    return { labelKey: `${key}.errors.load`, retry: true, tone: 'warning' };
  }
  return undefined;
};

/** The trusted actor/company scope a copied target must be revalidated against. */
export interface EmployeeTargetScope {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface EmployeeTargetRequest {
  /** A retry keeps the same target/scope identity but starts a fresh read. */
  readonly attempt?: number;
  readonly employeeId: EmployeeId;
  readonly scope: EmployeeTargetScope;
}

export const employeeTargetScopeKey = (scope: EmployeeTargetScope): string =>
  [scope.tenantId, scope.legalEntityId, scope.principalId].join('\u0000');

export const employeeTargetRequestKey = ({ employeeId, scope }: EmployeeTargetRequest): string =>
  [employeeTargetScopeKey(scope), employeeId].join('\u0000');

/** The current authorized employee plus the revision/capabilities the fresh read itself returned. */
export interface EmployeeTargetRecord {
  readonly availablePrincipals: RecordsResponse['availablePrincipals'];
  readonly canWrite: boolean;
  readonly employee: Employee;
  readonly revision: number;
}

export type EmployeeTargetState =
  | { readonly status: 'idle' }
  | { readonly status: 'invalid' }
  | { readonly employeeId: EmployeeId; readonly status: 'loading' | 'forbidden' | 'unavailable' | 'missing' }
  | { readonly employeeId: EmployeeId; readonly record: EmployeeTargetRecord; readonly status: 'ready' };

/** Maps the fresh target read onto the same notice language as the list-based selection. */
export const employeeTargetNotice = (state: EmployeeTargetState): EmployeeSearchNotice | undefined => {
  if (state.status === 'idle') {
    return undefined;
  }
  if (state.status === 'invalid') {
    return employeeSearchNotice({ status: 'invalid' });
  }
  if (state.status === 'ready') {
    return employeeSearchNotice({ employee: state.record.employee, employeeId: state.employeeId, status: 'ready' });
  }
  return employeeSearchNotice({ employeeId: state.employeeId, status: state.status });
};

const freshTargetState = (response: RecordsResponse, request: EmployeeTargetRequest): EmployeeTargetState => {
  const { actorPrincipalRef } = response;
  if (
    actorPrincipalRef.principalId !== request.scope.principalId ||
    actorPrincipalRef.tenantId !== request.scope.tenantId
  ) {
    // A response carrying another actor's scope can never become the current panel, even before an epoch check.
    return { employeeId: request.employeeId, status: 'unavailable' };
  }
  const employee = response.items.find(({ id }) => id === request.employeeId);
  if (employee === undefined) {
    return { employeeId: request.employeeId, status: 'missing' };
  }
  return {
    employeeId: request.employeeId,
    record: {
      availablePrincipals: response.availablePrincipals,
      canWrite: response.canWrite,
      employee,
      revision: response.revision,
    },
    status: 'ready',
  };
};

type EmployeeTargetApply = (request: EmployeeTargetRequest, state: EmployeeTargetState) => void;
type EmployeeTargetClassify<Failure> = (failure: Failure) => 'forbidden' | 'unavailable';
type EmployeeTargetRead<Failure> = (employeeId: EmployeeId) => Effect.Effect<RecordsResponse, Failure>;
type EmployeeTargetRun = (effect: Effect.Effect<void>) => () => void;

/**
 * One fresh, cancellable target read: each update interrupts the previous lookup, and only the current epoch may
 * publish a state. It never reads, refreshes or mutates the page's global employees/tags/AI datasets.
 */
export class EmployeeTargetController<Failure> {
  readonly #apply: EmployeeTargetApply;
  readonly #classify: EmployeeTargetClassify<Failure>;
  readonly #read: EmployeeTargetRead<Failure>;
  readonly #run: EmployeeTargetRun;
  #epoch = 0;
  #interrupt: (() => void) | null = null;

  constructor(
    apply: EmployeeTargetApply,
    classify: EmployeeTargetClassify<Failure>,
    read: EmployeeTargetRead<Failure>,
    run: EmployeeTargetRun,
  ) {
    this.#apply = apply;
    this.#classify = classify;
    this.#read = read;
    this.#run = run;
  }

  readonly cancel = (): void => {
    this.#epoch += 1;
    const current = this.#interrupt;
    this.#interrupt = null;
    current?.();
  };

  readonly update = ({
    enabled,
    request,
  }: {
    readonly enabled: boolean;
    readonly request: EmployeeTargetRequest;
  }): void => {
    this.cancel();
    if (!enabled) {
      return;
    }
    const currentEpoch = this.#epoch;
    this.#apply(request, { employeeId: request.employeeId, status: 'loading' });
    this.#interrupt = this.#run(
      this.#read(request.employeeId).pipe(
        Effect.match({
          onFailure: (failure) => ({ classification: this.#classify(failure) }),
          onSuccess: (response) => ({ state: freshTargetState(response, request) }),
        }),
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            if (currentEpoch !== this.#epoch) {
              return;
            }
            if ('state' in outcome) {
              this.#apply(request, outcome.state);
            } else {
              this.#apply(request, { employeeId: request.employeeId, status: outcome.classification });
            }
          }),
        ),
      ),
    );
  };
}

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

/**
 * Select labels inherit the surrounding font size; FormInput and Combobox labels use the `md` label token. Every
 * Select on this page takes these props, in the forms and in the filter bar, so all labels match.
 */
export const selectLabelProps = { className: 'text-label-md' };

const closeWhenDismissed =
  (onClose: () => void) =>
  (open: boolean): void => {
    if (!open) {
      onClose();
    }
  };

interface EmployeeFieldsProps {
  readonly availablePrincipals: RecordsResponse['availablePrincipals'];
  readonly disabled: boolean;
  readonly draft: EmployeeDraft;
  /** Set when the server reports that another Employee already uses the typed e-mail. */
  readonly emailTaken: boolean;
  readonly employee: Employee | null;
  readonly onChange: (patch: Partial<EmployeeDraft>) => void;
  /** Inline field errors are shown (after the first create attempt; always while editing). */
  readonly showErrors: boolean;
}

/** The fields of one Employee, shared by the create dialog and the autosaving edit panel. */
const EmployeeFields = ({
  availablePrincipals,
  disabled,
  draft,
  emailTaken,
  employee,
  onChange,
  showErrors,
}: EmployeeFieldsProps) => {
  const { language, t } = useModernI18n();
  const errors = draftErrors(draft);
  const fieldStatus = (field: DraftField) =>
    showErrors && errors.includes(field)
      ? { helpText: t(`${key}.errors.${errorFieldKey(draft, field)}`), validateStatus: 'error' as const }
      : {};
  const emailStatus = emailTaken
    ? { helpText: t(`${key}.errors.emailTaken`), validateStatus: 'error' as const }
    : fieldStatus('email');
  const roleItems = roleItemsOf(t);
  const principalOptions =
    employee?.principalRef !== undefined &&
    !availablePrincipals.some(({ principalRef }) => principalRef.principalId === employee.principalRef?.principalId)
      ? [...availablePrincipals, { displayName: employee.fullName, principalRef: employee.principalRef }]
      : availablePrincipals;
  return (
    <>
      <SelectTemplate
        disabled={disabled}
        items={principalOptions.map(({ displayName, principalRef }) => ({
          displayValue: displayName,
          label: displayName,
          value: principalRef.principalId,
        }))}
        label={t(`${key}.form.principal`)}
        labelProps={selectLabelProps}
        name="principalId"
        onValueChange={({ value }) => {
          const person = availablePrincipals.find(({ principalRef }) => principalRef.principalId === value[0]);
          if (person !== undefined) {
            onChange({
              fullName: draft.fullName.trim() === '' ? person.displayName : draft.fullName,
              principalRef: person.principalRef,
            });
          }
        }}
        placeholder={t(selectPlaceholder)}
        value={draft.principalRef === undefined ? [] : [draft.principalRef.principalId]}
      />
      {showErrors && employee === null && draft.principalRef === undefined && (
        <StatusText role="alert" status="error">
          {t(`${key}.errors.principal`)}
        </StatusText>
      )}
      <p className="text-sm text-fg-secondary">{t(`${key}.form.principalHelp`)}</p>
      {disabled ? null : (
        <a className="text-sm underline" href={`/${language}/sprava/lide-a-role`}>
          {t(`${key}.form.managePeople`)}
        </a>
      )}
      <FormInput
        autoComplete="off"
        disabled={disabled}
        id="employee-full-name"
        label={t(`${key}.form.fullName`)}
        name="fullName"
        onChange={(event) => onChange({ fullName: event.target.value })}
        required
        value={draft.fullName}
        {...fieldStatus('fullName')}
      />
      <FormInput
        autoComplete="email"
        disabled={disabled}
        id="employee-email"
        label={t(`${key}.form.email`)}
        name="email"
        onChange={(event) => onChange({ email: event.target.value })}
        required
        type="email"
        value={draft.email}
        {...emailStatus}
      />
      <FormInput
        autoComplete="tel"
        disabled={disabled}
        id="employee-phone"
        label={t(`${key}.form.phone`)}
        name="phone"
        onChange={(event) => onChange({ phone: event.target.value })}
        type="tel"
        value={draft.phone}
        {...fieldStatus('phone')}
      />
      <SelectTemplate
        disabled={disabled}
        items={roleItems}
        label={t(`${key}.form.role`)}
        labelProps={selectLabelProps}
        name="role"
        onValueChange={(details) => {
          const next = roleFromValue(details.value[0]);
          if (next !== null) {
            onChange({ role: next });
          }
        }}
        placeholder={t(selectPlaceholder)}
        value={[draft.role]}
      />
      <FormInput
        autoComplete="off"
        disabled={disabled}
        id="employee-department"
        label={t(`${key}.form.department`)}
        name="department"
        onChange={(event) => onChange({ department: event.target.value })}
        required
        value={draft.department}
        {...fieldStatus('department')}
      />
      <Switch checked={draft.active} disabled={disabled} onCheckedChange={(checked) => onChange({ active: checked })}>
        {t(`${key}.form.active`)}
      </Switch>
    </>
  );
};

/**
 * Edit one existing Employee. Editing changes only the draft on screen; the Save button sends it with the revision
 * the draft is based on, and a revision conflict offers the current version instead of overwriting it. Every way out
 * of the panel asks first while something is unsaved.
 */
const EmployeeEditPanel = ({
  availablePrincipals,
  commitEdit,
  employee,
  onClose,
  revision,
}: {
  readonly availablePrincipals: RecordsResponse['availablePrincipals'];
  readonly commitEdit: EditCommitCommand;
  readonly employee: Employee;
  readonly onClose: () => void;
  readonly revision: number;
}) => {
  const { language, t } = useModernI18n();
  const [emailTaken, setEmailTaken] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const record = useRecordDraft<EmployeeDraft, never>({
    equals: sameDraft,
    isValid: (value) => draftErrors(value).length === 0,
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision) =>
      commitEdit(updateCommand(employee, value), expectedRevision, {
        ids: [employee.id],
        patch: listedFieldsOf(value),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            setEmailTaken(result === 'duplicateEmail');
            setServerError(result === 'forbidden' ? t(commitErrorKey(result)) : null);
          }),
        ),
        Effect.map(employeeSaveResult),
      ),
    server: draftFromEmployee(employee),
  });
  // Browser Back and links ask the same question as Zavřít and the panel's own close button.
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const labels = saveLabelsFor(language);
  const handleClose = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
  return (
    <>
      <SidePanel
        actions={
          <div className="workforce-employee-form-actions">
            <Button onClick={handleClose} theme="outlined" type="button" variant="secondary">
              {t(`${key}.form.close`)}
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
          </div>
        }
        guard={guard}
        initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#employee-full-name')}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="md"
        title={t(`${key}.form.editTitle`)}
      >
        <form
          className="flex flex-col gap-200 py-200"
          id={employeeFormId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          {serverError !== null && (
            <StatusText showIcon status="error">
              {serverError}
            </StatusText>
          )}
          <EmployeeFields
            availablePrincipals={availablePrincipals}
            disabled={false}
            draft={record.draft}
            emailTaken={emailTaken}
            employee={employee}
            onChange={(patch) => {
              if (patch.email !== undefined) {
                setEmailTaken(false);
              }
              record.setDraft((current) => ({ ...current, ...patch }));
            }}
            showErrors
          />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

const noopChange = () => {
  // A read-only detail never changes its draft.
};

/** A created Employee closes the create panel. A conflict has no draft to reload there, so it reads as a failed save. */
const createSaveOutcome = (result: EditCommitResult): SaveOutcome => {
  const saved = employeeSaveResult(result);
  if (Predicate.isNumber(saved)) {
    return 'saved';
  }
  return saved === 'conflict' ? 'failed' : saved;
};

/**
 * Create a new Employee in a right-hand panel. Typing changes only the draft; Save sends it once and closes the panel
 * when the Employee is saved. Every way out asks first while the draft holds edits.
 */
const EmployeeCreateDialog = ({
  availablePrincipals,
  commitEdit,
  onClose,
  revision,
}: {
  readonly availablePrincipals: RecordsResponse['availablePrincipals'];
  readonly commitEdit: EditCommitCommand;
  readonly onClose: () => void;
  readonly revision: number;
}) => {
  const { language, t } = useModernI18n();
  const [draft, setDraft] = useState<EmployeeDraft>(emptyDraft);
  const [serverError, setServerError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const create = useDraftSave<EmployeeDraft, never>({
    equals: sameDraft,
    isValid: (value) => draftErrors(value).length === 0 && value.principalRef !== undefined,
    runtime: browserRuntime,
    save: (value) =>
      newEmployeeId.pipe(
        Effect.flatMap((id) => commitEdit(createCommand(id, value), revision, { ids: [], patch: {} })),
        Effect.tap((result) =>
          Effect.sync(() => {
            setEmailTaken(result === 'duplicateEmail');
            setServerError(result === 'forbidden' ? t(commitErrorKey(result)) : null);
          }),
        ),
        Effect.map(createSaveOutcome),
      ),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => create.dirty, withResolver: true });
  const discard = () => {
    setDraft(create.confirmed);
  };
  const guard = useUnsavedChangesGuard({ draft: create, navigation: blocker, onDiscard: discard });
  const labels = saveLabelsFor(language);
  const handleSave = () => {
    setSubmitted(true);
    create.save();
    create.afterSave((status) => {
      if (status === 'saved') {
        onClose();
      }
    });
  };

  return (
    <>
      <SidePanel
        actions={
          <div className="workforce-employee-form-actions">
            <Button onClick={() => guard.request(onClose)} theme="outlined" type="button" variant="secondary">
              {t(`${key}.form.cancel`)}
            </Button>
            <SaveBar labels={labels} onReloadLatest={noopChange} onSave={handleSave} status={create.status} />
          </div>
        }
        guard={guard}
        // The first field takes focus, not the close button the panel renders first.
        initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#employee-full-name')}
        onOpenChange={(next) => {
          if (!next) {
            guard.request(onClose);
          }
        }}
        open
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="md"
        title={t(`${key}.form.createTitle`)}
      >
        <form
          className="flex flex-col gap-200 py-200"
          id={employeeFormId}
          // Required-field and format messages stay inline in Czech; the browser bubble would show in English.
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          {serverError !== null && (
            <StatusText showIcon status="error">
              {serverError}
            </StatusText>
          )}
          <EmployeeFields
            availablePrincipals={availablePrincipals}
            disabled={create.status === 'saving'}
            draft={draft}
            emailTaken={emailTaken}
            employee={null}
            onChange={(patch) => {
              if (patch.email !== undefined) {
                setEmailTaken(false);
              }
              setDraft((current) => ({ ...current, ...patch }));
            }}
            showErrors={submitted}
          />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/**
 * One Employee opened from a copied search URL for a reader without write: the same fields, disabled, with no draft
 * controller, form submit, mutation action or draft. Closing it only dismisses the panel.
 */
const EmployeeReadOnlyPanel = ({
  availablePrincipals,
  employee,
  onClose,
}: {
  readonly availablePrincipals: RecordsResponse['availablePrincipals'];
  readonly employee: Employee;
  readonly onClose: () => void;
}) => {
  const { t } = useModernI18n();
  return (
    <SidePanel
      actions={
        <Button onClick={onClose} theme="outlined" variant="secondary">
          {t(`${key}.form.close`)}
        </Button>
      }
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('[data-employee-detail]')}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="md"
      title={employee.fullName}
    >
      <div className="flex flex-col gap-200 py-200" data-employee-detail>
        <EmployeeFields
          availablePrincipals={availablePrincipals}
          disabled
          draft={draftFromEmployee(employee)}
          emailTaken={false}
          employee={employee}
          onChange={noopChange}
          showErrors={false}
        />
      </div>
    </SidePanel>
  );
};

/** Create (employee is null) or edit one Employee in a right-hand panel. */
export const EmployeeFormDialog = ({
  availablePrincipals,
  commitEdit,
  employee,
  onClose,
  readOnly = false,
  revision,
}: {
  readonly availablePrincipals: RecordsResponse['availablePrincipals'];
  readonly commitEdit: EditCommitCommand;
  readonly employee: Employee | null;
  readonly onClose: () => void;
  readonly readOnly?: boolean;
  readonly revision: number;
}) => {
  if (employee === null) {
    return (
      <EmployeeCreateDialog
        availablePrincipals={availablePrincipals}
        commitEdit={commitEdit}
        onClose={onClose}
        revision={revision}
      />
    );
  }
  if (readOnly) {
    return <EmployeeReadOnlyPanel availablePrincipals={availablePrincipals} employee={employee} onClose={onClose} />;
  }
  return (
    <EmployeeEditPanel
      availablePrincipals={availablePrincipals}
      commitEdit={commitEdit}
      employee={employee}
      onClose={onClose}
      revision={revision}
    />
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
      commit(Effect.succeed(bulkCommand(ids, { department: trimmed })), `${key}.toast.bulkSaved`, {
        ids,
        patch: { department: trimmed },
      }).pipe(
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
    <SidePanel
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
      description={t(`${key}.bulk.description`, { total: ids.length })}
      // The first field takes focus, not the close button the panel renders first.
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#bulk-department')}
      onOpenChange={closeWhenDismissed(onClose)}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="md"
      title={t(`${key}.bulk.departmentTitle`)}
    >
      <form
        className="flex flex-col gap-200 py-200"
        noValidate
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
    </SidePanel>
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
      commit(Effect.succeed(bulkCommand(ids, { role })), `${key}.toast.bulkSaved`, { ids, patch: { role } }).pipe(
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
    <SidePanel
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
      description={t(`${key}.bulk.description`, { total: ids.length })}
      // The first field takes focus. A Select trigger has the DOM id `select:<id>:trigger`.
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('[id="select:bulk-role:trigger"]')}
      onOpenChange={closeWhenDismissed(onClose)}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="md"
      title={t(`${key}.bulk.roleTitle`)}
    >
      <div className="flex flex-col gap-200 py-200">
        {serverError !== null && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <SelectTemplate
          id="bulk-role"
          items={roleItems}
          label={t(`${key}.form.role`)}
          labelProps={selectLabelProps}
          name="bulkRole"
          onValueChange={(details) => {
            const next = roleFromValue(details.value[0]);
            if (next !== null) {
              setRole(next);
            }
          }}
          placeholder={t(selectPlaceholder)}
          value={[role]}
        />
      </div>
    </SidePanel>
  );
};
