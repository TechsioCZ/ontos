import type { RevisionedSaveResult, SaveOutcome } from '@app/admin-ui';
import { useDraftSave } from '@app/admin-ui';
import {
  ComboboxField,
  EntryTextField,
  FormBuilder,
  FormReact,
  MultiComboboxField,
  TextAreaField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import type { Field } from '@app/core-runtime/ui/form';
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
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';

type Property = RecordsResponse['properties'][number];
export type EmployeeOption = Pick<Employee, 'active' | 'fullName' | 'id'>;
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

/** The command that creates the building or unit a new-record draft describes. */
export const createCommandOf = (draft: PropertyDraft): PropertyCommand =>
  draft.unitFor === undefined
    ? {
        _tag: 'CreateProperty',
        address: draft.address,
        code: draft.code,
        lifecycleState: draft.lifecycleState,
        name: draft.name,
        note: draft.note.trim() || null,
        propertyType: draft.propertyType,
        responsibleEmployeeIds: draft.responsibleEmployeeIds,
      }
    : {
        _tag: 'CreateUnit',
        capacity: null,
        code: draft.code,
        name: draft.name,
        propertyRef: draft.unitFor.propertyRef,
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

/**
 * The fields of the building or unit form. The draft is validated as a whole against the register (required texts,
 * a free code, a responsible employee unless an older building keeps its stored name), so the texts are one record
 * field whose entries the form marks with that verdict. Uložit sends the draft through the save bar; the form's own
 * submit (Enter) only asks for that save.
 */
const RecordTextsSchema = Schema.Record(Schema.String, Schema.String);
const EmployeeChoicesSchema = Schema.Array(Schema.String);
const recordFormBuilder = FormBuilder.empty
  .addField('lifecycleState', Schema.String)
  .addField('note', Schema.String)
  .addField('responsibleEmployeeIds', EmployeeChoicesSchema)
  .addField('text', RecordTextsSchema);

/**
 * The fields of the building or unit form, named so the module's declarations can refer to them. A field record has
 * to be indexable, which an interface is not.
 */
type RecordFields = Readonly<{
  readonly lifecycleState: Field.FieldDef<'lifecycleState', typeof Schema.String>;
  readonly note: Field.FieldDef<'note', typeof Schema.String>;
  readonly responsibleEmployeeIds: Field.FieldDef<'responsibleEmployeeIds', typeof EmployeeChoicesSchema>;
  readonly text: Field.FieldDef<'text', typeof RecordTextsSchema>;
}>;
interface RecordControls {
  readonly lifecycleState: typeof ComboboxField;
  readonly note: typeof TextAreaField;
  readonly responsibleEmployeeIds: typeof MultiComboboxField;
  readonly text: typeof EntryTextField;
}
export type RecordForm = FormReact.BuiltForm<RecordFields, never, void, never, void, RecordControls>;
export type RecordValues = Field.EncodedFromFields<RecordFields>;

const makeRecordForm = (): RecordForm =>
  FormReact.make(recordFormBuilder, {
    fields: {
      lifecycleState: ComboboxField,
      note: TextAreaField,
      responsibleEmployeeIds: MultiComboboxField,
      text: EntryTextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  });
/** The new building or unit. */
export const createRecordForm: RecordForm = makeRecordForm();
/** The existing building or unit open in the edit dialog. */
export const editRecordForm: RecordForm = makeRecordForm();

/** The texts of a draft that are one entry each of the form's `text` field. */
const textEntries = ['address', 'code', 'name', 'propertyType'] as const;
export type RecordTextEntry = (typeof textEntries)[number];

/** What the form shows for a draft. */
export const recordValuesOf = (draft: PropertyDraft): RecordValues => ({
  lifecycleState: draft.lifecycleState,
  note: draft.note,
  responsibleEmployeeIds: draft.responsibleEmployeeIds,
  text: { address: draft.address, code: draft.code, name: draft.name, propertyType: draft.propertyType },
});
export const emptyRecordValues: RecordValues = recordValuesOf(emptyDraft);

/** The draft the form's values make of `base`: a unit keeps its code, an unknown state or employee id is left out. */
export const draftOfValues = (base: PropertyDraft, values: RecordValues): PropertyDraft => {
  let draft = withTextField(base, 'note', values.note);
  for (const entry of textEntries) {
    draft = withTextField(draft, entry, values.text[entry] ?? draft[entry]);
  }
  return withResponsibleEmployees(withLifecycle(draft, values.lifecycleState), [...values.responsibleEmployeeIds]);
};

/** Whether the form shows exactly these values. */
export const sameRecordValues = (left: RecordValues, right: RecordValues): boolean =>
  left.lifecycleState === right.lifecycleState &&
  left.note === right.note &&
  left.responsibleEmployeeIds.join(',') === right.responsibleEmployeeIds.join(',') &&
  textEntries.every((entry) => left.text[entry] === right.text[entry]);

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
export const savePropertyEdit = (
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
          return 'proposed';
        }
        return result.revision;
      },
    }),
  );

export type PropertyEditor = ReturnType<typeof usePropertyEditor>;

export const usePropertyEditor = (
  records: RecordsResponse | undefined,
  employees: readonly EmployeeOption[] | undefined,
  onSaved: (result: ApplyCommandResult) => void,
) => {
  /**
   * The new-record dialog that is open: an empty building, or a unit of `unitFor`; undefined while none is. Its values
   * are the create form's.
   */
  const [createBase, setCreateBase] = useState<PropertyDraft>();
  const createValues = useAtomValue(createRecordForm.values);
  const setCreateValues = useAtomSet(createRecordForm.setValues);
  /** The new building or unit being entered; undefined while no create form is open. */
  const draft =
    createBase === undefined
      ? undefined
      : Option.match(createValues, {
          onNone: () => createBase,
          onSome: (values) => draftOfValues(createBase, values),
        });
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
  /** The existing building or unit open in the edit panel. */
  const [editing, setEditing] = useState<PropertyDraft>();
  const saveCreate = (value: PropertyDraft): Effect.Effect<SaveOutcome> => {
    if (records === undefined || blocked) {
      return Effect.succeed('failed');
    }
    setFeedback(undefined);
    return sendCommand(createCommandOf(value), records.revision).pipe(
      Effect.match({
        onFailure: (error): SaveOutcome => {
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
          return 'failed';
        },
        onSuccess: (result): SaveOutcome => {
          setCreateBase(undefined);
          // A change parked for approval is not saved yet: no saved line and no refresh of the register.
          if (Schema.is(ActionProposalAcceptedSchema)(result)) {
            setFeedback('approvalRequired');
            return 'proposed';
          }
          setFeedback('saved');
          onSaved(result);
          return 'saved';
        },
      }),
    );
  };
  /** The new-record draft: it is sent only by its Save button, and starts over from the empty draft each time. */
  const createDraft = useDraftSave<PropertyDraft, never>({
    equals: sameEditDraft,
    isValid: (value) =>
      Object.keys(propertyDraftErrors(value, records)).length === 0 &&
      (value.unit !== undefined || value.unitFor !== undefined || employees !== undefined),
    runtime: browserRuntime,
    save: saveCreate,
    value: draft ?? emptyDraft,
  });
  /** Opens the new-record dialog on `base`, with empty fields. */
  const startCreate = (base: PropertyDraft) => {
    setFeedback(undefined);
    createDraft.adopt(base);
    setCreateValues(emptyRecordValues);
    setCreateBase(base);
  };
  const begin = (property?: Property) => {
    if (property === undefined) {
      startCreate(emptyDraft);
      return;
    }
    setFeedback(undefined);
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
            setCreateBase(undefined);
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
  let visibleFields: readonly DraftField[] =
    draft?.unitFor === undefined
      ? ['code', 'name', 'address', 'propertyType', 'responsibleEmployeeIds', 'note']
      : ['code', 'name'];
  let title = 'create';
  if (draft?.unitFor !== undefined) {
    title = 'createUnit';
  }
  if (draft?.unit !== undefined) {
    visibleFields = ['name', 'note'];
    title = 'editUnit';
  }
  return {
    begin,
    beginUnit: (property: Property) => startCreate({ ...emptyDraft, unitFor: property }),
    beginUnitEdit: (unit: Unit) => {
      setFeedback(undefined);
      setEditing(unitDraftOf(unit));
    },
    blocked,
    /** S02: a unit is taken out of service, returned to service or retired (history stays). */
    changeUnitLifecycle: (unit: Unit, lifecycleState: Unit['lifecycleState']) =>
      submit({ _tag: 'ChangeUnitLifecycle', lifecycleState, unitRef: unit.unitRef }),
    /** Staff-only archive (S02 demo hygiene): hides a test record from every register, history stays. */
    archiveProperty: (property: Property, reason: string) =>
      submit({ _tag: 'ArchiveProperty', propertyRef: property.propertyRef, reason }),
    archiveUnit: (unit: Unit, reason: string) => submit({ _tag: 'ArchiveUnit', reason, unitRef: unit.unitRef }),
    busy: busy || createDraft.status === 'saving',
    cancel: () => {
      setCreateBase(undefined);
      setFeedback(undefined);
      // A closed create form starts clean the next time it opens.
      createDraft.adopt(emptyDraft);
    },
    closeEdit: () => setEditing(undefined),
    /** The new-record draft and its Save control: `createDraft.save` is the only send. */
    createDraft,
    draft,
    editing,
    errors: draft === undefined || !createDraft.dirty ? {} : propertyDraftErrors(draft, records),
    feedback,
    fields: visibleFields,
    /** An edit was parked for approval instead of being saved. */
    reportProposal: () => setFeedback('approvalRequired'),
    restoreProperty: (property: Property) => submit({ _tag: 'RestoreProperty', propertyRef: property.propertyRef }),
    restoreUnit: (unit: Unit) => submit({ _tag: 'RestoreUnit', unitRef: unit.unitRef }),
    title,
    toggleLifecycle: (property: Property) =>
      submit({
        _tag: 'ChangePropertyLifecycle',
        lifecycleState: property.lifecycleState === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
        propertyRef: property.propertyRef,
      }),
  };
};
