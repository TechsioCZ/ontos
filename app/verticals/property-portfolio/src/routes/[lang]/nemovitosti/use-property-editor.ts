import type { RevisionedSaveResult } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { DateTime, Effect, Match, Option, Predicate, Random, Schema } from 'effect';
import type { Employee } from '@app/workforce/contracts/records';
import { EmployeeIdSchema } from '@app/workforce/resources/employee';
import { useState } from 'react';
import type { ApplyCommandResult, PropertyCommand } from '../../../../shared/actions/apply-command.ts';
import { PropertyCommandSchema } from '../../../../shared/actions/apply-command.ts';
import { PropertyLifecycleSchema } from '../../../../shared/apis/records.ts';
import type { RecordsResponse } from '../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../api/records-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';

type Property = RecordsResponse['properties'][number];
type EmployeeOption = Pick<Employee, 'active' | 'fullName' | 'id'>;
export interface PropertyDraft {
  readonly address: string;
  readonly code: string;
  readonly lifecycleState: Property['lifecycleState'];
  readonly name: string;
  readonly note: string;
  readonly property?: Property;
  readonly propertyType: string;
  readonly responsibleEmployeeIds: readonly Employee['id'][];
  readonly unit?: Unit;
  readonly unitFor?: Property;
}
const emptyDraft: PropertyDraft = {
  address: '',
  code: '',
  lifecycleState: 'PLANNED',
  name: '',
  note: '',
  propertyType: '',
  responsibleEmployeeIds: [],
};

const TextFieldSchema = Schema.Literals(['address', 'code', 'name', 'note', 'propertyType']);
type TextField = typeof TextFieldSchema.Type;
const DraftFieldSchema = Schema.Literals([...TextFieldSchema.literals, 'responsibleEmployeeIds']);
type DraftField = typeof DraftFieldSchema.Type;
const DraftErrorSchema = Schema.Literals(['required', 'tooLong', 'duplicateCode', 'responsibleRequired']);
type DraftError = typeof DraftErrorSchema.Type;
interface DraftErrors {
  address?: DraftError;
  code?: DraftError;
  name?: DraftError;
  note?: DraftError;
  propertyType?: DraftError;
  responsibleEmployeeIds?: DraftError;
}
type Unit = RecordsResponse['units'][number];

/**
 * The free-text responsible person of an older building that has no employee reference yet. It stays as stored until
 * someone picks employees: opening the editor or editing another field never turns the name into an employee.
 */
const legacyResponsiblePerson = (draft: PropertyDraft): string | undefined => {
  const { property } = draft;
  if (
    property === undefined ||
    property.responsibleEmployeeIds !== undefined ||
    draft.responsibleEmployeeIds.length > 0
  ) {
    return undefined;
  }
  const name = property.responsiblePerson?.trim() ?? '';
  return name.length === 0 ? undefined : name;
};

/** A responsible employee as the editor shows it; `name` is undefined when the employee register cannot show it. */
export interface ResponsibleChoice {
  readonly id: Employee['id'];
  readonly name: string | undefined;
}

/** What the responsible-person picker offers and shows as chosen for a draft. */
export interface ResponsibleSelection {
  /** The stored name of an older building without employee references, shown until employees are picked. */
  readonly legacyName: string | undefined;
  /** Active employees, plus every chosen one (inactive or unreadable) so the choice stays visible and removable. */
  readonly options: readonly ResponsibleChoice[];
  readonly selected: readonly ResponsibleChoice[];
}

export const responsibleSelection = (
  draft: PropertyDraft,
  employees: readonly EmployeeOption[] | undefined,
): ResponsibleSelection => {
  const chosen = new Set(draft.responsibleEmployeeIds);
  const names = new Map((employees ?? []).map((employee) => [employee.id, employee.fullName]));
  const selected = draft.responsibleEmployeeIds.map((id) => ({ id, name: names.get(id) }));
  return {
    legacyName: legacyResponsiblePerson(draft),
    options: [
      ...(employees ?? []).flatMap((employee) =>
        employee.active || chosen.has(employee.id) ? [{ id: employee.id, name: employee.fullName }] : [],
      ),
      ...selected.filter((choice) => choice.name === undefined),
    ],
    selected,
  };
};

/** Translation keys for invalid draft fields; empty when the editable fields are valid. */
export const propertyDraftErrors = (draft: PropertyDraft, records?: RecordsResponse): DraftErrors => {
  let fields: readonly TextField[] =
    draft.unitFor === undefined ? ['code', 'name', 'address', 'propertyType'] : ['code', 'name'];
  if (draft.unit !== undefined) {
    fields = ['name'];
  }
  const errors: DraftErrors = {};
  for (const field of fields) {
    const value = draft[field].trim();
    if (value.length === 0) {
      errors[field] = 'required';
    } else if (value.length > 300) {
      errors[field] = 'tooLong';
    }
  }
  if (
    draft.unit === undefined &&
    draft.unitFor === undefined &&
    draft.responsibleEmployeeIds.length === 0 &&
    legacyResponsiblePerson(draft) === undefined
  ) {
    errors.responsibleEmployeeIds = 'responsibleRequired';
  }
  const code = draft.code.trim();
  if (
    draft.property === undefined &&
    draft.unit === undefined &&
    code.length > 0 &&
    [...(records?.properties ?? []), ...(records?.units ?? []), ...(records?.assets ?? [])].some(
      (record) => record.code === code,
    )
  ) {
    errors.code = 'duplicateCode';
  }
  return errors;
};

/** The draft of an existing building, read from the register; only stored employee references are preselected. */
export const propertyDraftOf = (property: Property): PropertyDraft => ({
  address: property.address,
  code: property.code,
  lifecycleState: property.lifecycleState,
  name: property.name,
  note: property.note ?? '',
  property,
  propertyType: property.propertyType ?? '',
  responsibleEmployeeIds: property.responsibleEmployeeIds ?? [],
});

/** The draft of an existing unit, read from the register. */
export const unitDraftOf = (unit: Unit): PropertyDraft => ({
  ...emptyDraft,
  code: unit.code,
  name: unit.name,
  note: unit.note ?? '',
  unit,
});

/** Drafts that store the same record: surrounding spaces do not count; the record snapshots they carry do not either. */
export const sameEditDraft = (left: PropertyDraft, right: PropertyDraft): boolean =>
  left.address.trim() === right.address.trim() &&
  left.code.trim() === right.code.trim() &&
  left.lifecycleState === right.lifecycleState &&
  left.name.trim() === right.name.trim() &&
  left.note.trim() === right.note.trim() &&
  left.propertyType.trim() === right.propertyType.trim() &&
  left.responsibleEmployeeIds.join(',') === right.responsibleEmployeeIds.join(',');

/**
 * The update an edit draft sends; None while a field is invalid, so an invalid draft is never saved. An older building
 * keeps its stored responsible person until employees are picked, because the update then leaves it out.
 */
export const editCommandOf = (draft: PropertyDraft, records?: RecordsResponse): Option.Option<PropertyCommand> => {
  if (Object.keys(propertyDraftErrors(draft, records)).length > 0) {
    return Option.none();
  }
  if (draft.unit !== undefined) {
    return Option.some({
      _tag: 'UpdateUnit',
      name: draft.name,
      note: draft.note.trim() || null,
      unitRef: draft.unit.unitRef,
    });
  }
  if (draft.property !== undefined) {
    const update: PropertyCommand = {
      _tag: 'UpdateProperty',
      address: draft.address,
      lifecycleState: draft.lifecycleState,
      name: draft.name,
      note: draft.note.trim() || null,
      propertyRef: draft.property.propertyRef,
      propertyType: draft.propertyType,
    };
    return Option.some(
      draft.responsibleEmployeeIds.length === 0
        ? update
        : { ...update, responsibleEmployeeIds: draft.responsibleEmployeeIds },
    );
  }
  return Option.none();
};

/** The edited record as the register has it now, in the draft's shape; undefined once it is gone. */
export const currentEditDraft = (base: PropertyDraft, records: RecordsResponse): PropertyDraft | undefined => {
  if (base.unit !== undefined) {
    const { resourceId } = base.unit.unitRef;
    const unit = records.units.find((item) => item.unitRef.resourceId === resourceId);
    return unit === undefined ? undefined : unitDraftOf(unit);
  }
  const resourceId = base.property?.propertyRef.resourceId;
  const property = records.properties.find((item) => item.propertyRef.resourceId === resourceId);
  return property === undefined ? undefined : propertyDraftOf(property);
};

/** Whether the register still holds the edited record as the draft's base version. */
export const editUnchangedSince =
  (base: PropertyDraft) =>
  (records: RecordsResponse): boolean => {
    const current = currentEditDraft(base, records);
    return current !== undefined && sameEditDraft(current, base);
  };

/** A text field of a draft; a unit keeps its code (only its name and note are editable). */
export const withTextField = (draft: PropertyDraft, field: TextField, value: string): PropertyDraft =>
  draft.unit !== undefined && field !== 'name' && field !== 'note' ? draft : { ...draft, [field]: value };

export const withLifecycle = (draft: PropertyDraft, value: string): PropertyDraft =>
  Schema.is(PropertyLifecycleSchema)(value) ? { ...draft, lifecycleState: value } : draft;

export const withResponsibleEmployees = (draft: PropertyDraft, value: string | string[]): PropertyDraft => ({
  ...draft,
  responsibleEmployeeIds: [...new Set((Array.isArray(value) ? value : [value]).filter(Schema.is(EmployeeIdSchema)))],
});

const idempotencyKey = Effect.all({ now: DateTime.now, random: Random.nextInt }, { concurrency: 1 }).pipe(
  Effect.map(({ now, random }) => `property:${DateTime.toEpochMillis(now)}:${random}`),
);

const sendCommand = (raw: PropertyCommand, expectedRevision: number) =>
  Schema.decodeEffect(PropertyCommandSchema)(raw).pipe(
    Effect.flatMap((command) =>
      idempotencyKey.pipe(
        Effect.flatMap((key) =>
          executeApplyCommand({ command, expectedRevision }, 'property-portfolio.edit', { idempotencyKey: key }),
        ),
      ),
    ),
  );

/**
 * Save of an edited building or unit against the revision its draft builds on. The revision covers the whole
 * register, so a conflict is resent once against a fresh read while `unchanged` holds for it. A change parked for
 * approval is not saved: the draft stays unconfirmed on its base revision and `onProposal` hears of it.
 */
export const autosavePropertyEdit = (
  raw: PropertyCommand,
  expectedRevision: number,
  unchanged: (records: RecordsResponse) => boolean,
  onProposal?: (proposal: ActionProposalAccepted) => void,
): Effect.Effect<RevisionedSaveResult> =>
  sendCommand(raw, expectedRevision).pipe(
    Effect.catchTag('ApplyCommandActionConflictProblem', (conflict) =>
      conflict.code === 'property_conflict'
        ? Random.nextInt.pipe(
            Effect.flatMap((id) => executeRecords({ includeArchived: true }, `property-records:${id}`)),
            Effect.flatMap((fresh) => (unchanged(fresh) ? sendCommand(raw, fresh.revision) : Effect.fail(conflict))),
          )
        : Effect.fail(conflict),
    ),
    Effect.match({
      onFailure: (error): RevisionedSaveResult =>
        Predicate.isTagged(error, 'ApplyCommandActionConflictProblem') && error.code === 'property_conflict'
          ? 'conflict'
          : 'failed',
      onSuccess: (result): RevisionedSaveResult => {
        if (Schema.is(ActionProposalAcceptedSchema)(result)) {
          onProposal?.(result);
          return 'failed';
        }
        return result.revision;
      },
    }),
  );

export const usePropertyEditor = (
  records: RecordsResponse | undefined,
  employees: readonly EmployeeOption[] | undefined,
  onSaved: (result: ApplyCommandResult) => void,
) => {
  const [draft, setDraft] = useState<PropertyDraft>();
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<
    | 'alreadyCommitted'
    | 'approvalRequired'
    | 'commitIndeterminate'
    | 'conflict'
    | 'forbidden'
    | 'saved'
    | 'unavailable'
    | 'validation'
  >();
  const blocked = feedback === 'alreadyCommitted' || feedback === 'commitIndeterminate';
  const change = (field: TextField, value: string) =>
    setDraft((current) => (current === undefined ? current : withTextField(current, field, value)));
  /** The existing building or unit open in the autosaving edit panel. */
  const [editing, setEditing] = useState<PropertyDraft>();
  const begin = (property?: Property) => {
    setFeedback(undefined);
    setSubmitted(false);
    if (property === undefined) {
      setDraft(emptyDraft);
      return;
    }
    setEditing(propertyDraftOf(property));
  };
  const submit = (raw: PropertyCommand) => {
    if (records === undefined || busy || blocked) {
      return;
    }
    setBusy(true);
    setFeedback(undefined);
    void browserRuntime.runPromise(
      sendCommand(raw, records.revision).pipe(
        Effect.match({
          onFailure: (error) => {
            setFeedback(
              Match.value(error).pipe(
                Match.when({ _tag: 'ApplyCommandActionAlreadyCommittedProblem' }, () => 'alreadyCommitted' as const),
                Match.when(
                  { _tag: 'ApplyCommandActionCommitIndeterminateProblem' },
                  () => 'commitIndeterminate' as const,
                ),
                Match.when({ _tag: 'SchemaError' }, () => 'validation' as const),
                Match.when({ status: 400 }, () => 'validation' as const),
                Match.when({ status: 403 }, () => 'forbidden' as const),
                Match.when({ status: 409 }, () => 'conflict' as const),
                Match.when({ status: 422 }, () => 'validation' as const),
                Match.orElse(() => 'unavailable' as const),
              ),
            );
          },
          onSuccess: (result) => {
            setDraft(undefined);
            // A change parked for approval is not saved yet: no saved line and no refresh of the register.
            if (Schema.is(ActionProposalAcceptedSchema)(result)) {
              setFeedback('approvalRequired');
              return;
            }
            setFeedback('saved');
            onSaved(result);
          },
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };
  const save = () => {
    if (draft === undefined || busy || blocked) {
      return;
    }
    if (draft.unit === undefined && draft.unitFor === undefined && employees === undefined) {
      setFeedback('unavailable');
      return;
    }
    setSubmitted(true);
    if (Object.keys(propertyDraftErrors(draft, records)).length > 0) {
      setFeedback('validation');
      return;
    }
    let raw: PropertyCommand = {
      _tag: 'CreateProperty',
      address: draft.address,
      code: draft.code,
      lifecycleState: draft.lifecycleState,
      name: draft.name,
      note: draft.note.trim() || null,
      propertyType: draft.propertyType,
      responsibleEmployeeIds: draft.responsibleEmployeeIds,
    };
    if (draft.unitFor !== undefined) {
      raw = {
        _tag: 'CreateUnit',
        capacity: null,
        code: draft.code,
        name: draft.name,
        propertyRef: draft.unitFor.propertyRef,
      };
    }
    submit(raw);
  };
  let visibleFields: readonly DraftField[] =
    draft?.unitFor === undefined
      ? ['code', 'name', 'address', 'propertyType', 'responsibleEmployeeIds', 'note']
      : ['code', 'name'];
  let title = 'create';
  if (draft?.property !== undefined) {
    title = 'edit';
  }
  if (draft?.unitFor !== undefined) {
    title = 'createUnit';
  }
  if (draft?.unit !== undefined) {
    visibleFields = ['name', 'note'];
    title = 'editUnit';
  }
  return {
    begin,
    beginUnit: (property: Property) => {
      setFeedback(undefined);
      setSubmitted(false);
      setDraft({ ...emptyDraft, unitFor: property });
    },
    beginUnitEdit: (unit: Unit) => {
      setFeedback(undefined);
      setEditing(unitDraftOf(unit));
    },
    closeEdit: () => setEditing(undefined),
    editing,
    errors: draft === undefined || !submitted ? {} : propertyDraftErrors(draft, records),
    /** S02: a unit is taken out of service, returned to service or retired (history stays). */
    changeUnitLifecycle: (unit: Unit, lifecycleState: Unit['lifecycleState']) =>
      submit({ _tag: 'ChangeUnitLifecycle', lifecycleState, unitRef: unit.unitRef }),
    /** Staff-only archive (S02 demo hygiene): hides a test record from every register, history stays. */
    archiveProperty: (property: Property, reason: string) =>
      submit({ _tag: 'ArchiveProperty', propertyRef: property.propertyRef, reason }),
    archiveUnit: (unit: Unit, reason: string) => submit({ _tag: 'ArchiveUnit', reason, unitRef: unit.unitRef }),
    blocked,
    busy,
    cancel: () => {
      setDraft(undefined);
      setFeedback(undefined);
    },
    change,
    changeLifecycle: (value: string) =>
      setDraft((current) => (current === undefined ? current : withLifecycle(current, value))),
    changeResponsibleEmployees: (value: string | string[]) =>
      setDraft((current) => (current === undefined ? current : withResponsibleEmployees(current, value))),
    draft,
    feedback,
    fields: visibleFields,
    /** An autosaved edit was parked for approval instead of being saved. */
    reportProposal: () => setFeedback('approvalRequired'),
    restoreProperty: (property: Property) => submit({ _tag: 'RestoreProperty', propertyRef: property.propertyRef }),
    restoreUnit: (unit: Unit) => submit({ _tag: 'RestoreUnit', unitRef: unit.unitRef }),
    save,
    title,
    toggleLifecycle: (property: Property) =>
      submit({
        _tag: 'ChangePropertyLifecycle',
        lifecycleState: property.lifecycleState === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
        propertyRef: property.propertyRef,
      }),
  };
};
