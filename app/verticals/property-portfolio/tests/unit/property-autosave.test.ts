import { EmployeeIdSchema } from '@app/workforce/resources/employee';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { PropertyCommandSchema } from '../../shared/actions/apply-command.ts';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import {
  currentEditDraft,
  editCommandOf,
  editUnchangedSince,
  propertyDraftOf,
  sameEditDraft,
  unitDraftOf,
  withResponsibleEmployees,
  withTextField,
} from '../../src/routes/[lang]/nemovitosti/use-property-editor.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const propertyRef = {
  moduleId: 'property.portfolio',
  resourceId: '76000000-0000-4000-8000-000000000001',
  resourceType: 'property.portfolio.property',
  tenantId,
};
const unitRef = {
  moduleId: 'property.portfolio',
  resourceId: '76000000-0000-4000-8000-000000000002',
  resourceType: 'property.portfolio.unit',
  tenantId,
};
const employeeId = '75000000-0000-4000-8000-000000000001';
const recordsEffect = Schema.decodeUnknownEffect(RecordsResponseSchema)({
  assets: [],
  properties: [
    {
      address: '12 Park Street',
      code: 'PROPERTY-01',
      createdAt: '2026-10-27T09:00:00.000Z',
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: '71000000-0000-4000-8000-000000000020',
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
      lifecycleState: 'ACTIVE',
      name: 'Park House',
      note: null,
      propertyRef,
      propertyType: 'Residential',
      responsibleEmployeeIds: [employeeId],
      updatedAt: '2026-10-27T09:00:00.000Z',
    },
  ],
  revision: 4,
  units: [
    {
      capacity: 2,
      code: 'UNIT-01',
      lifecycleState: 'ACTIVE',
      name: 'First Floor',
      note: 'Original note',
      propertyRef,
      unitKind: 'Apartment',
      unitRef,
    },
  ],
});

it.effect('compares edit drafts by their stored values, not by the record snapshot they carry', () =>
  Effect.gen(function* editDraftComparison() {
    const records = yield* recordsEffect;
    const property = yield* Effect.fromNullishOr(records.properties[0]);
    const saved = propertyDraftOf(property, []);
    expect(sameEditDraft(saved, propertyDraftOf(property, []))).toBe(true);
    expect(sameEditDraft(saved, { ...saved, name: 'Park House ' })).toBe(true);
    expect(sameEditDraft(saved, { ...saved, name: 'Park House II' })).toBe(false);
    expect(sameEditDraft(saved, { ...saved, note: 'Poznámka' })).toBe(false);
    // A newer snapshot of the same register row still describes the same draft.
    expect(sameEditDraft(saved, { ...saved, property: { ...property, updatedAt: '2026-10-28T09:00:00.000Z' } })).toBe(
      true,
    );
  }),
);

it.effect('sends an UpdateProperty for a changed building and an UpdateUnit for a changed unit', () =>
  Effect.gen(function* editCommands() {
    const records = yield* recordsEffect;
    const property = yield* Effect.fromNullishOr(records.properties[0]);
    const unit = yield* Effect.fromNullishOr(records.units[0]);
    const propertyDraft = propertyDraftOf(property, []);
    const propertyCommand = Option.getOrThrow(editCommandOf({ ...propertyDraft, name: 'Park House II' }, records));
    expect(Schema.is(PropertyCommandSchema.cases.UpdateProperty)(propertyCommand)).toBe(true);
    expect(propertyCommand).toMatchObject({ address: '12 Park Street', name: 'Park House II', propertyRef });

    const unitCommand = Option.getOrThrow(
      editCommandOf({ ...unitDraftOf(unit), code: 'IGNORED', name: 'Second Floor' }, records),
    );
    expect(Schema.is(PropertyCommandSchema.cases.UpdateUnit)(unitCommand)).toBe(true);
    expect(unitCommand).toMatchObject({ name: 'Second Floor', note: 'Original note', unitRef });
  }),
);

it.effect('never turns an invalid building draft into a command', () =>
  Effect.gen(function* invalidEditDraft() {
    const records = yield* recordsEffect;
    const property = yield* Effect.fromNullishOr(records.properties[0]);
    const draft = propertyDraftOf(property, []);
    expect(Option.isNone(editCommandOf({ ...draft, name: '  ' }, records))).toBe(true);
    expect(Option.isNone(editCommandOf({ ...draft, responsibleEmployeeIds: [] }, records))).toBe(true);
    // A draft without a record is a create, never an autosaved edit.
    const { property: _record, ...withoutRecord } = draft;
    expect(Option.isNone(editCommandOf(withoutRecord, records))).toBe(true);
  }),
);

it.effect('follows the register: an edit is resendable only while the stored record is unchanged', () =>
  Effect.gen(function* unchangedSince() {
    const records = yield* recordsEffect;
    const property = yield* Effect.fromNullishOr(records.properties[0]);
    const unit = yield* Effect.fromNullishOr(records.units[0]);
    const propertyBase = propertyDraftOf(property, []);
    const unitBase = unitDraftOf(unit);
    expect(editUnchangedSince(propertyBase, [])(records)).toBe(true);
    expect(editUnchangedSince(unitBase, [])(records)).toBe(true);

    const changedProperty = yield* Schema.decodeUnknownEffect(RecordsResponseSchema)({
      ...records,
      properties: [{ ...property, name: 'Renamed by someone else', updatedAt: '2026-10-29T09:00:00.000Z' }],
    });
    expect(editUnchangedSince(propertyBase, [])(changedProperty)).toBe(false);
    expect(currentEditDraft(propertyBase, changedProperty, [])).toMatchObject({ name: 'Renamed by someone else' });

    const gone = yield* Schema.decodeUnknownEffect(RecordsResponseSchema)({ ...records, properties: [], units: [] });
    expect(editUnchangedSince(propertyBase, [])(gone)).toBe(false);
    expect(editUnchangedSince(unitBase, [])(gone)).toBe(false);
    expect(currentEditDraft(propertyBase, gone, [])).toBeUndefined();
  }),
);

it.effect('keeps a unit code read-only and accepts only known employee ids', () =>
  Effect.gen(function* draftFieldGuards() {
    const records = yield* recordsEffect;
    const unit = yield* Effect.fromNullishOr(records.units[0]);
    const unitDraft = unitDraftOf(unit);
    expect(withTextField(unitDraft, 'code', 'UNIT-99')).toBe(unitDraft);
    expect(withTextField(unitDraft, 'name', 'Second Floor')).toMatchObject({ code: 'UNIT-01', name: 'Second Floor' });
    const employee = yield* Schema.decodeUnknownEffect(EmployeeIdSchema)(employeeId);
    expect(withResponsibleEmployees(unitDraft, [employee, employee])).toMatchObject({
      responsibleEmployeeIds: [employee],
    });
    expect(withResponsibleEmployees(unitDraft, 'not-an-employee-id')).toMatchObject({ responsibleEmployeeIds: [] });
  }),
);
