import {
  DocumentTitle,
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  requiredLabelFor,
  saveLabelsFor,
  useDraftSave,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { RecordDraft, SaveOutcome } from '@app/admin-ui';
import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  SwitchField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Predicate, Schema } from 'effect';
import { Url } from 'effect/http';
import { Atom } from 'effect/reactivity';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkforceCommand } from '../../../../../shared/actions/apply-command.ts';
import { EmployeeIdSchema } from '../../../../../shared/apis/records.ts';
import type { Employee, EmployeeId, EmployeeRole, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  DepartmentTextSchema,
  EmailTextSchema,
  FullNameTextSchema,
  PhoneTextSchema,
  bulkCommand,
  createCommand,
  draftFromEmployee,
  draftOfValues,
  emptyDraft,
  employeeRoles,
  employeeSaveResult,
  isSendableDraft,
  listedFieldsOf,
  newEmployeeId,
  roleFromValue,
  sameDraft,
  updateCommand,
  valuesOfDraft,
} from './employee-model.ts';
import type { CommitOutcome, EditCommitResult, EmployeeDraft, EmployeeValues } from './employee-model.ts';
import { Link } from '@techsio/ui-kit/atoms/link';

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

const roleItemsOf = (translate: (key: string) => string) =>
  employeeRoles.map((role) => ({ label: translate(`${key}.roles.${role}`), value: role }));

/**
 * Select labels inherit the surrounding font size; text field labels use the `md` label token. Every select on this
 * page takes its label through this, in the forms and in the filter bar, so all labels match.
 */
export const selectLabel = (text: string): ReactNode => <span className="text-label-md">{text}</span>;

const closeWhenDismissed =
  (onClose: () => void) =>
  (open: boolean): void => {
    if (!open) {
      onClose();
    }
  };

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what an earlier panel left, so a panel reads the values only after `onReady`.
 */
export const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

/**
 * One Employee as the create, edit and read-only panels show it; only one of them is open at a time. The panel's
 * Uložit sends the draft, so the form itself sends nothing: Enter asks the panel to save. `takenEmail` is the e-mail
 * the server refused as used by another Employee; it is never shown as a control, only as the e-mail field's message.
 */
const employeeForm = FormReact.make(
  FormBuilder.empty
    .addField('active', Schema.Boolean)
    .addField('department', DepartmentTextSchema)
    .addField('email', EmailTextSchema)
    .addField('fullName', FullNameTextSchema)
    .addField('phone', PhoneTextSchema)
    .addField('principalId', Schema.String)
    .addField('role', Schema.String)
    .addField('takenEmail', Schema.String)
    .refine(({ email, takenEmail }) =>
      takenEmail !== '' && email.trim() === takenEmail
        ? { issue: `${key}.errors.emailTaken`, path: ['email'] }
        : undefined,
    ),
  {
    fields: {
      active: SwitchField,
      department: TextField,
      email: TextField,
      fullName: TextField,
      phone: TextField,
      principalId: ChoiceField,
      role: ChoiceField,
      takenEmail: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

const textOf = (value: Atom.Atom<Option.Option<string>>) => value.pipe(Atom.map(Option.getOrElse(() => '')));
const fullNameField = employeeForm.getFieldAtoms(employeeForm.fields.fullName);
const takenEmailField = employeeForm.getFieldAtoms(employeeForm.fields.takenEmail);
/** The picked account and the typed e-mail as plain values, which change only when the person changes them. */
const chosenPrincipalId = textOf(employeeForm.getFieldAtoms(employeeForm.fields.principalId).value);
const typedEmail = textOf(employeeForm.getFieldAtoms(employeeForm.fields.email).value);
const takenEmail = textOf(takenEmailField.value);
/** The typed e-mail with the refused one, read together so a change of either sees the other as it is now. */
const emailRefusal = Atom.readable((get) => ({ email: get(typedEmail), taken: get(takenEmail) }));
/** A save or Enter was tried: from then on the create panel names every field it holds back. */
const saveTried = Atom.readable((get) => get(employeeForm.submitCount) + get(employeeForm.validationCount) > 0);

type PrincipalChoice = RecordsResponse['availablePrincipals'][number];

/** The accounts the panel offers: the company's people, and the account the Employee is linked to when it is not one. */
const principalChoicesOf = (
  availablePrincipals: RecordsResponse['availablePrincipals'],
  employee: Employee | null,
): readonly PrincipalChoice[] =>
  employee?.principalRef !== undefined &&
  !availablePrincipals.some(({ principalRef }) => principalRef.principalId === employee.principalRef?.principalId)
    ? [...availablePrincipals, { displayName: employee.fullName, principalRef: employee.principalRef }]
    : availablePrincipals;

const principalRefsOf = (choices: readonly PrincipalChoice[]) => choices.map(({ principalRef }) => principalRef);

/**
 * The e-mail the server refused as taken shows on the e-mail field until the e-mail changes. `refuse` marks the sent
 * e-mail as taken, or clears the mark with `""`.
 */
const useTakenEmail = () => {
  const setTaken = useAtomSet(takenEmailField.setValue);
  const validate = useAtomSet(employeeForm.validate);
  // Read while subscribed, so the subscription sees every change.
  useAtomValue(emailRefusal);
  useAtomSubscribe(
    emailRefusal,
    ({ email, taken }) => {
      if (taken !== '' && email.trim() !== taken) {
        setTaken('');
        validate();
      }
    },
    { immediate: false },
  );
  return (email: string) => {
    setTaken(email.trim());
    validate();
  };
};

/** While editing, every field the draft holds back is named from the moment the form opens. */
const NamesEveryProblem = () => {
  const validate = useAtomSet(employeeForm.validate);
  useEffect(() => {
    validate();
  }, [validate]);
  return null;
};

/** Enter in the employee form is Uložit. */
const useEnterSaves = (save: () => void) => {
  // Read while subscribed, so the subscription sees every submit.
  useAtomValue(employeeForm.submitCount);
  useAtomSubscribe(
    employeeForm.submitCount,
    (count) => {
      if (count > 0) {
        save();
      }
    },
    { immediate: false },
  );
};

interface EmployeeFieldsProps {
  readonly choices: readonly PrincipalChoice[];
  /** People who can be picked; picking one fills an empty name with theirs. */
  readonly people: RecordsResponse['availablePrincipals'];
  /** The create panel requires an account and names it once a save was tried. */
  readonly principalRequired: boolean;
  /** The link to manage people is offered while the fields can change. */
  readonly showManagePeople: boolean;
}

/** The fields of one Employee, shared by the create, edit and read-only panels. */
const EmployeeFields = ({ choices, people, principalRequired, showManagePeople }: EmployeeFieldsProps) => {
  const { language, t } = useModernI18n();
  const requiredLabel = requiredLabelFor(language);
  const principalId = useAtomValue(chosenPrincipalId);
  const tried = useAtomValue(saveTried);
  const setFullName = useAtomSet(fullNameField.setValue);
  useAtomSubscribe(
    chosenPrincipalId,
    (picked) => {
      const person = people.find(({ principalRef }) => principalRef.principalId === picked);
      if (person !== undefined) {
        setFullName((current: string) => (current.trim() === '' ? person.displayName : current));
      }
    },
    { immediate: false },
  );
  return (
    <>
      <employeeForm.principalId
        items={choices.map(({ displayName, principalRef }) => ({
          label: displayName,
          value: principalRef.principalId,
        }))}
        label={selectLabel(t(`${key}.form.principal`))}
        placeholder={t(selectPlaceholder)}
      />
      {principalRequired && tried && principalId === '' && (
        <StatusText role="alert" status="error">
          {t(`${key}.errors.principal`)}
        </StatusText>
      )}
      <p className="text-sm text-fg-secondary">{t(`${key}.form.principalHelp`)}</p>
      {showManagePeople ? (
        <Link className="text-sm" href={`/${language}/sprava/lide-a-role`} size="current">
          {t(`${key}.form.managePeople`)}
        </Link>
      ) : null}
      <employeeForm.fullName
        autoComplete="off"
        id="employee-full-name"
        label={t(`${key}.form.fullName`)}
        name="fullName"
        required
        requiredLabel={requiredLabel}
      />
      <employeeForm.email
        autoComplete="email"
        id="employee-email"
        label={t(`${key}.form.email`)}
        name="email"
        required
        requiredLabel={requiredLabel}
        type="email"
      />
      <employeeForm.phone
        autoComplete="tel"
        id="employee-phone"
        label={t(`${key}.form.phone`)}
        name="phone"
        type="tel"
      />
      <employeeForm.role
        items={roleItemsOf(t)}
        label={selectLabel(t(`${key}.form.role`))}
        placeholder={t(selectPlaceholder)}
      />
      <employeeForm.department
        autoComplete="off"
        id="employee-department"
        label={t(`${key}.form.department`)}
        name="department"
        required
        requiredLabel={requiredLabel}
      />
      <employeeForm.active>{t(`${key}.form.active`)}</employeeForm.active>
    </>
  );
};

/**
 * The form's values are the record's draft: typing changes the draft, and a draft that moves without typing (a newer
 * server version, Zahodit změny, Načíst aktuální verzi) moves the form.
 */
const useRecordValues = (
  record: RecordDraft<EmployeeDraft>,
  principals: ReturnType<typeof principalRefsOf>,
  opened: EmployeeDraft,
) => {
  const values = useAtomValue(employeeForm.values);
  const setValues = useAtomSet(employeeForm.setValues);
  const { draft, setDraft } = record;
  useAtomSubscribe(
    employeeForm.values,
    (next) => {
      if (Option.isSome(next)) {
        setDraft(draftOfValues(next.value, principals, opened));
      }
    },
    { immediate: false },
  );
  const shownDraft = useRef(draft);
  useEffect(() => {
    if (shownDraft.current === draft) {
      return;
    }
    shownDraft.current = draft;
    if (Option.exists(values, (shown) => !sameDraft(draftOfValues(shown, principals, opened), draft))) {
      setValues(valuesOfDraft(draft));
    }
  }, [draft, opened, principals, setValues, values]);
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
  const [serverError, setServerError] = useState<string | null>(null);
  const refuseEmail = useTakenEmail();
  const choices = principalChoicesOf(availablePrincipals, employee);
  const server = draftFromEmployee(employee);
  const record = useRecordDraft<EmployeeDraft, never>({
    equals: sameDraft,
    isValid: isSendableDraft,
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision) =>
      commitEdit(updateCommand(employee, value), expectedRevision, {
        ids: [employee.id],
        patch: listedFieldsOf(value),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            refuseEmail(result === 'duplicateEmail' ? value.email : '');
            setServerError(result === 'forbidden' ? t(commitErrorKey(result)) : null);
          }),
        ),
        Effect.map(employeeSaveResult),
      ),
    server,
  });
  useRecordValues(record, principalRefsOf(choices), server);
  // Browser Back and links ask the same question as Zavřít and the panel's own close button.
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const labels = saveLabelsFor(language);
  const handleClose = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
  useEnterSaves(handleSave);
  return (
    <>
      <DocumentTitle title={employee.fullName} />
      <SidePanel
        actions={
          <div className="flex w-full flex-wrap justify-end gap-100">
            <Button
              appearance="outline"
              className="min-h-12 w-full whitespace-nowrap sm:w-auto"
              onClick={handleClose}
              severity="secondary"
              type="button"
            >
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
        <FormRoot
          className="flex flex-col gap-200 py-200"
          defaultValues={valuesOfDraft(record.draft)}
          form={employeeForm}
          id={employeeFormId}
          translateMessage={t}
        >
          <NamesEveryProblem />
          {serverError !== null && (
            <StatusText showIcon status="error">
              {serverError}
            </StatusText>
          )}
          <EmployeeFields choices={choices} people={availablePrincipals} principalRequired={false} showManagePeople />
        </FormRoot>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

const noopChange = () => {
  // Nothing to reload: the draft has no newer server version.
};

/** A created Employee closes the create panel. A conflict has no draft to reload there, so it reads as a failed save. */
const createSaveOutcome = (result: EditCommitResult): SaveOutcome => {
  const saved = employeeSaveResult(result);
  if (Predicate.isNumber(saved)) {
    return 'saved';
  }
  return saved === 'conflict' ? 'failed' : saved;
};

/** The empty create form. */
const emptyValues: EmployeeValues = valuesOfDraft(emptyDraft);

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
  const [ready, setReady] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const refuseEmail = useTakenEmail();
  const validate = useAtomSet(employeeForm.validate);
  const setValues = useAtomSet(employeeForm.setValues);
  const choices = principalChoicesOf(availablePrincipals, null);
  const principals = principalRefsOf(choices);
  const draft = Option.match(
    Option.filter(useAtomValue(employeeForm.values), () => ready),
    { onNone: () => emptyDraft, onSome: (shown) => draftOfValues(shown, principals, emptyDraft) },
  );
  const create = useDraftSave<EmployeeDraft, never>({
    equals: sameDraft,
    isValid: (value) => isSendableDraft(value) && value.principalRef !== undefined,
    runtime: browserRuntime,
    save: (value) =>
      newEmployeeId.pipe(
        Effect.flatMap((id) => commitEdit(createCommand(id, value), revision, { ids: [], patch: {} })),
        Effect.tap((result) =>
          Effect.sync(() => {
            refuseEmail(result === 'duplicateEmail' ? value.email : '');
            setServerError(result === 'forbidden' ? t(commitErrorKey(result)) : null);
          }),
        ),
        Effect.map(createSaveOutcome),
      ),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => create.dirty, withResolver: true });
  const discard = () => {
    setValues(valuesOfDraft(create.confirmed));
  };
  const guard = useUnsavedChangesGuard({ draft: create, navigation: blocker, onDiscard: discard });
  const labels = saveLabelsFor(language);
  const saving = create.status === 'saving';
  const handleSave = () => {
    // From the first try on, every field the draft holds back is named.
    validate();
    create.save();
    create.afterSave((status) => {
      if (status === 'saved') {
        onClose();
      }
    });
  };
  useEnterSaves(handleSave);

  return (
    <>
      <SidePanel
        actions={
          <div className="flex w-full flex-wrap justify-end gap-100">
            <Button
              appearance="outline"
              className="min-h-12 w-full whitespace-nowrap sm:w-auto"
              onClick={() => guard.request(onClose)}
              severity="secondary"
              type="button"
            >
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
        {/* Required-field and format messages stay inline in Czech; the browser bubble would show in English. */}
        <FormRoot
          blocked={saving}
          className="flex flex-col gap-200 py-200"
          defaultValues={emptyValues}
          form={employeeForm}
          id={employeeFormId}
          translateMessage={t}
        >
          <FormReady onReady={setReady} />
          {serverError !== null && (
            <StatusText showIcon status="error">
              {serverError}
            </StatusText>
          )}
          <EmployeeFields choices={choices} people={availablePrincipals} principalRequired showManagePeople={!saving} />
        </FormRoot>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/**
 * One Employee opened from a copied search URL for a reader without write: the same fields, locked, with no draft
 * controller, save or mutation action. Closing it only dismisses the panel.
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
  const setValues = useAtomSet(employeeForm.setValues);
  const shown = useRef(employee);
  // A fresher read of the same Employee shows at once.
  useEffect(() => {
    if (shown.current !== employee) {
      shown.current = employee;
      setValues(valuesOfDraft(draftFromEmployee(employee)));
    }
  }, [employee, setValues]);
  return (
    <SidePanel
      actions={
        <Button appearance="outline" onClick={onClose} severity="secondary">
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
        <DocumentTitle title={employee.fullName} />
        <FormRoot
          blocked
          className="flex flex-col gap-200"
          defaultValues={valuesOfDraft(draftFromEmployee(employee))}
          form={employeeForm}
          translateMessage={t}
        >
          <EmployeeFields
            choices={principalChoicesOf(availablePrincipals, employee)}
            people={availablePrincipals}
            principalRequired={false}
            showManagePeople={false}
          />
        </FormRoot>
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

/**
 * Explicit save of one bulk dialog: the change is only on screen until the shared Save button sends it as one bulk
 * command, and leaving with an unsent change asks Uložit / Zahodit změny / Zůstat.
 */
const useBulkSave = <V,>({
  commit,
  ids,
  initial,
  isValid,
  onSaved,
  opened,
  patchOf,
  value,
}: {
  readonly commit: CommitCommand;
  readonly ids: readonly EmployeeId[];
  /** What the draft is compared with: the empty dialog, so a change it opens with is already savable. */
  readonly initial: V;
  readonly isValid: (value: V) => boolean;
  readonly onSaved: () => void;
  /** The value the dialog opens with when it differs from `initial`: not typed input, so closing does not ask. */
  readonly opened?: V;
  readonly patchOf: (value: V) => Partial<Employee> & Parameters<typeof bulkCommand>[1];
  readonly value: V;
}) => {
  const { language, t } = useModernI18n();
  const [serverError, setServerError] = useState<string | null>(null);
  const record = useDraftSave<V, never>({
    initial,
    isValid,
    opened,
    runtime: browserRuntime,
    save: (draft) => {
      const patch = patchOf(draft);
      return commit(Effect.succeed(bulkCommand(ids, patch)), `${key}.toast.bulkSaved`, { ids, patch }).pipe(
        Effect.map((outcome): SaveOutcome => {
          setServerError(outcome === 'saved' ? null : t(commitErrorKey(outcome)));
          return outcome === 'saved' ? 'saved' : 'failed';
        }),
      );
    },
    value,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: noopChange });
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        onSaved();
      }
    });
  };
  return { guard, handleSave, labels: saveLabelsFor(language), record, serverError };
};

/** The department every selected Employee gets. A typed value that is not a department shows its message at once. */
const bulkDepartmentForm = FormReact.make(FormBuilder.empty.addField('department', DepartmentTextSchema), {
  fields: { department: TextField },
  mode: { validation: 'onChange' },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

const isDepartmentText = Schema.is(DepartmentTextSchema);

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
  const { language, t } = useModernI18n();
  const [ready, setReady] = useState(false);
  const department = Option.match(
    Option.filter(useAtomValue(bulkDepartmentForm.values), () => ready),
    { onNone: () => '', onSome: (values) => values.department },
  );
  const bulk = useBulkSave({
    commit,
    ids,
    initial: '',
    isValid: isDepartmentText,
    onSaved,
    patchOf: (value) => ({ department: value.trim() }),
    value: department,
  });

  return (
    <SidePanel
      actions={
        <>
          <Button appearance="outline" onClick={() => bulk.guard.request(onClose)} severity="secondary">
            {t(`${key}.form.cancel`)}
          </Button>
          <SaveBar
            error={bulk.serverError}
            labels={bulk.labels}
            onReloadLatest={noopChange}
            onSave={bulk.handleSave}
            status={bulk.record.status}
          />
          <UnsavedChangesDialog labels={bulk.labels} prompt={bulk.guard.prompt} />
        </>
      }
      description={t(`${key}.bulk.description`, { total: ids.length })}
      guard={bulk.guard}
      // The first field takes focus, not the close button the panel renders first.
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#bulk-department')}
      onOpenChange={closeWhenDismissed(onClose)}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="md"
      title={t(`${key}.bulk.departmentTitle`)}
    >
      {/* Enter never applies the change: only Uložit does. */}
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={{ department: '' }}
        form={bulkDepartmentForm}
        translateMessage={t}
      >
        <FormReady onReady={setReady} />
        <bulkDepartmentForm.department
          autoComplete="off"
          id="bulk-department"
          label={t(`${key}.form.department`)}
          name="department"
          required
          requiredLabel={requiredLabelFor(language)}
        />
      </FormRoot>
    </SidePanel>
  );
};

/** The role every selected Employee gets. */
const bulkRoleForm = FormReact.make(FormBuilder.empty.addField('role', Schema.String), {
  fields: { role: ChoiceField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

/** The role the bulk role dialog suggests when it opens. */
const openingRole: EmployeeRole = 'SALES_REP';
const bulkRoleFormId = 'bulk-role';

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
  const [ready, setReady] = useState(false);
  const role = Option.match(
    Option.filter(useAtomValue(bulkRoleForm.values), () => ready),
    { onNone: () => openingRole, onSome: (values) => roleFromValue(values.role) },
  );
  const bulk = useBulkSave<EmployeeRole | null>({
    commit,
    ids,
    // The role the dialog opens with is already a change Uložit applies.
    initial: null,
    isValid: (value) => value !== null,
    onSaved,
    // Closing the dialog untouched asks nothing: the opening role is a suggestion, not input.
    opened: openingRole,
    patchOf: (value) => (value === null ? {} : { role: value }),
    value: role,
  });

  return (
    <SidePanel
      actions={
        <>
          <Button appearance="outline" onClick={() => bulk.guard.request(onClose)} severity="secondary">
            {t(`${key}.form.cancel`)}
          </Button>
          <SaveBar
            error={bulk.serverError}
            labels={bulk.labels}
            onReloadLatest={noopChange}
            onSave={bulk.handleSave}
            status={bulk.record.status}
          />
          <UnsavedChangesDialog labels={bulk.labels} prompt={bulk.guard.prompt} />
        </>
      }
      description={t(`${key}.bulk.description`, { total: ids.length })}
      guard={bulk.guard}
      // The first field takes focus: the trigger of the role select.
      initialFocusEl={() =>
        globalThis.document.querySelector<HTMLElement>(`#${bulkRoleFormId} [data-scope="select"][data-part="trigger"]`)
      }
      onOpenChange={closeWhenDismissed(onClose)}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="md"
      title={t(`${key}.bulk.roleTitle`)}
    >
      {/* Enter never applies the change: only Uložit does. */}
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={{ role: openingRole }}
        form={bulkRoleForm}
        id={bulkRoleFormId}
        translateMessage={t}
      >
        <FormReady onReady={setReady} />
        <bulkRoleForm.role
          items={roleItemsOf(t)}
          label={selectLabel(t(`${key}.form.role`))}
          placeholder={t(selectPlaceholder)}
        />
      </FormRoot>
    </SidePanel>
  );
};
