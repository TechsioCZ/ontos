import { DateTime, Effect, Match, Random, Schema } from 'effect';
import type { Employee } from '@app/workforce/contracts/records';
import { EmployeeIdSchema } from '@app/workforce/resources/employee';
import { useState } from 'react';
import type { ApplyCommandResult, PropertyCommand } from '../../../../shared/actions/apply-command.ts';
import { PropertyCommandSchema } from '../../../../shared/actions/apply-command.ts';
import { PropertyLifecycleSchema } from '../../../../shared/apis/records.ts';
import type { RecordsResponse } from '../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';

type Property = RecordsResponse['properties'][number];
type EmployeeOption = Pick<Employee, 'active' | 'fullName' | 'id'>;
interface PropertyDraft {
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
  if (draft.unit === undefined && draft.unitFor === undefined && draft.responsibleEmployeeIds.length === 0) {
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

export const usePropertyEditor = (
  records: RecordsResponse | undefined,
  employees: readonly EmployeeOption[] | undefined,
  onSaved: (result: ApplyCommandResult) => void,
) => {
  const [draft, setDraft] = useState<PropertyDraft>();
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<
    'alreadyCommitted' | 'commitIndeterminate' | 'conflict' | 'forbidden' | 'saved' | 'unavailable' | 'validation'
  >();
  const blocked = feedback === 'alreadyCommitted' || feedback === 'commitIndeterminate';
  const change = (field: TextField, value: string) =>
    setDraft((current) => {
      if (current === undefined || (current.unit !== undefined && field !== 'name' && field !== 'note')) {
        return current;
      }
      return { ...current, [field]: value };
    });
  const begin = (property?: Property) => {
    setFeedback(undefined);
    setSubmitted(false);
    const legacyEmployees = employees?.filter((employee) => employee.fullName === property?.responsiblePerson) ?? [];
    setDraft(
      property === undefined
        ? emptyDraft
        : {
            address: property.address,
            code: property.code,
            lifecycleState: property.lifecycleState,
            name: property.name,
            note: property.note ?? '',
            property,
            propertyType: property.propertyType ?? '',
            responsibleEmployeeIds:
              property.responsibleEmployeeIds ??
              (legacyEmployees.length === 1 ? legacyEmployees.map((employee) => employee.id) : []),
          },
    );
  };
  const submit = (raw: PropertyCommand) => {
    if (records === undefined || busy || blocked) {
      return;
    }
    setBusy(true);
    setFeedback(undefined);
    void browserRuntime.runPromise(
      Schema.decodeEffect(PropertyCommandSchema)(raw).pipe(
        Effect.flatMap((command) =>
          Effect.all({ now: DateTime.now, random: Random.nextInt }, { concurrency: 1 }).pipe(
            Effect.flatMap(({ now, random }) =>
              executeApplyCommand({ command, expectedRevision: records.revision }, 'property-portfolio.edit', {
                idempotencyKey: `property:${DateTime.toEpochMillis(now)}:${random}`,
              }),
            ),
          ),
        ),
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
    if (draft.property !== undefined) {
      raw = {
        _tag: 'UpdateProperty',
        address: draft.address,
        lifecycleState: draft.lifecycleState,
        name: draft.name,
        note: draft.note.trim() || null,
        propertyRef: draft.property.propertyRef,
        propertyType: draft.propertyType,
        responsibleEmployeeIds: draft.responsibleEmployeeIds,
      };
    }
    if (draft.unitFor !== undefined) {
      raw = {
        _tag: 'CreateUnit',
        capacity: null,
        code: draft.code,
        name: draft.name,
        propertyRef: draft.unitFor.propertyRef,
      };
    }
    if (draft.unit !== undefined) {
      raw = {
        _tag: 'UpdateUnit',
        name: draft.name,
        note: draft.note.trim() || null,
        unitRef: draft.unit.unitRef,
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
      setSubmitted(false);
      setDraft({ ...emptyDraft, code: unit.code, name: unit.name, note: unit.note ?? '', unit });
    },
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
    changeLifecycle: (value: string) => {
      if (Schema.is(PropertyLifecycleSchema)(value)) {
        setDraft((current) => (current === undefined ? current : { ...current, lifecycleState: value }));
      }
    },
    changeResponsibleEmployees: (value: string | string[]) =>
      setDraft((current) =>
        current === undefined
          ? current
          : {
              ...current,
              responsibleEmployeeIds: [
                ...new Set((Array.isArray(value) ? value : [value]).filter(Schema.is(EmployeeIdSchema))),
              ],
            },
      ),
    draft,
    feedback,
    fields: visibleFields,
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
