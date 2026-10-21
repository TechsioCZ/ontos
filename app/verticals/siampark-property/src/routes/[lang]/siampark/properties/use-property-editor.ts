import { DateTime, Effect, Match, Random, Schema } from 'effect';
import { useState } from 'react';
import type { PropertyCommand } from '../../../../../shared/actions/apply-command.ts';
import { PropertyCommandSchema } from '../../../../../shared/actions/apply-command.ts';
import { PropertyLifecycleSchema } from '../../../../../shared/apis/records.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

type Property = RecordsResponse['properties'][number];
interface PropertyDraft {
  readonly address: string;
  readonly code: string;
  readonly name: string;
  readonly note: string;
  readonly propertyType: string;
  readonly responsiblePerson: string;
  readonly lifecycleState: Property['lifecycleState'];
  readonly property?: Property;
  readonly unitFor?: Property;
}
const emptyDraft: PropertyDraft = {
  address: '',
  code: '',
  name: '',
  note: '',
  propertyType: '',
  responsiblePerson: '',
  lifecycleState: 'PLANNED',
};

type DraftField = 'address' | 'code' | 'name' | 'note' | 'propertyType' | 'responsiblePerson';
type Unit = RecordsResponse['units'][number];
const fieldNames: Record<DraftField, string> = {
  address: 'adresu',
  code: 'kód',
  name: 'název',
  note: 'popis',
  propertyType: 'typ nemovitosti',
  responsiblePerson: 'odpovědnou osobu',
};
/** Czech inline messages for the property and unit form (rules 3.8 and 3.9); empty when the draft is valid. */
export const propertyDraftErrors = (
  draft: PropertyDraft,
  records: RecordsResponse | undefined,
): Partial<Record<DraftField, string>> => {
  const fields: readonly DraftField[] =
    draft.unitFor === undefined ? ['code', 'name', 'address', 'propertyType', 'responsiblePerson'] : ['code', 'name'];
  const errors: Partial<Record<DraftField, string>> = {};
  for (const field of fields) {
    const value = draft[field].trim();
    if (value.length === 0) errors[field] = `Vyplňte ${fieldNames[field]}.`;
    else if (value.length > 300) errors[field] = 'Nejvýše 300 znaků.';
  }
  const code = draft.code.trim();
  if (
    draft.property === undefined &&
    code.length > 0 &&
    [...(records?.properties ?? []), ...(records?.units ?? []), ...(records?.assets ?? [])].some(
      (record) => record.code === code,
    )
  )
    errors.code = 'Tento kód už používá jiná nemovitost, jednotka nebo vybavení.';
  return errors;
};

export const usePropertyEditor = (records: RecordsResponse | undefined, onSaved: () => void) => {
  const [draft, setDraft] = useState<PropertyDraft>();
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<'conflict' | 'forbidden' | 'saved' | 'unavailable' | 'validation'>();
  const change = (field: 'address' | 'code' | 'name' | 'note' | 'propertyType' | 'responsiblePerson', value: string) =>
    setDraft((current) => (current === undefined ? current : { ...current, [field]: value }));
  const begin = (property?: Property) => {
    setFeedback(undefined);
    setSubmitted(false);
    setDraft(
      property === undefined
        ? emptyDraft
        : {
            address: property.address,
            code: property.code,
            name: property.name,
            note: property.note ?? '',
            propertyType: property.propertyType ?? '',
            responsiblePerson: property.responsiblePerson ?? '',
            lifecycleState: property.lifecycleState,
            property,
          },
    );
  };
  const submit = (raw: PropertyCommand) => {
    if (records === undefined || busy) {
      return;
    }
    setBusy(true);
    setFeedback(undefined);
    void browserRuntime.runPromise(
      Schema.decodeEffect(PropertyCommandSchema)(raw).pipe(
        Effect.flatMap((command) =>
          Effect.all({ now: DateTime.now, random: Random.nextInt }, { concurrency: 1 }).pipe(
            Effect.flatMap(({ now, random }) =>
              executeApplyCommand({ command, expectedRevision: records.revision }, 'siampark-property.edit', {
                idempotencyKey: `property:${DateTime.toEpochMillis(now)}:${random}`,
              }),
            ),
          ),
        ),
        Effect.match({
          onFailure: (error) => {
            setFeedback(
              Match.value(error).pipe(
                Match.when({ _tag: 'SchemaError' }, () => 'validation' as const),
                Match.when({ status: 400 }, () => 'validation' as const),
                Match.when({ status: 403 }, () => 'forbidden' as const),
                Match.when({ status: 409 }, () => 'conflict' as const),
                Match.when({ status: 422 }, () => 'validation' as const),
                Match.orElse(() => 'unavailable' as const),
              ),
            );
          },
          onSuccess: () => {
            setDraft(undefined);
            setFeedback('saved');
            onSaved();
          },
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };
  const save = () => {
    if (draft === undefined) {
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
      name: draft.name,
      note: draft.note.trim() || null,
      propertyType: draft.propertyType,
      responsiblePerson: draft.responsiblePerson,
      lifecycleState: draft.lifecycleState,
    };
    if (draft.property !== undefined) {
      raw = {
        _tag: 'UpdateProperty',
        propertyType: draft.propertyType,
        responsiblePerson: draft.responsiblePerson,
        lifecycleState: draft.lifecycleState,
        address: draft.address,
        name: draft.name,
        note: draft.note.trim() || null,
        propertyRef: draft.property.propertyRef,
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
    submit(raw);
  };
  const visibleFields: readonly ('code' | 'name' | 'address' | 'note' | 'propertyType' | 'responsiblePerson')[] =
    draft?.unitFor === undefined
      ? ['code', 'name', 'address', 'propertyType', 'responsiblePerson', 'note']
      : ['code', 'name'];
  let title = 'create';
  if (draft?.property !== undefined) {
    title = 'edit';
  }
  if (draft?.unitFor !== undefined) {
    title = 'createUnit';
  }
  return {
    begin,
    beginUnit: (property: Property) => {
      setFeedback(undefined);
      setSubmitted(false);
      setDraft({ ...emptyDraft, unitFor: property });
    },
    errors: draft === undefined || !submitted ? {} : propertyDraftErrors(draft, records),
    /** S02: a unit is taken out of service, returned to service or retired (history stays). */
    changeUnitLifecycle: (unit: Unit, lifecycleState: Unit['lifecycleState']) =>
      submit({ _tag: 'ChangeUnitLifecycle', lifecycleState, unitRef: unit.unitRef }),
    busy,
    cancel: () => setDraft(undefined),
    change,
    changeLifecycle: (value: string) => {
      if (Schema.is(PropertyLifecycleSchema)(value))
        setDraft((current) => (current === undefined ? current : { ...current, lifecycleState: value }));
    },
    draft,
    feedback,
    fields: visibleFields,
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
