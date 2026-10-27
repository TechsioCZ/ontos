import { EmployeeIdSchema } from '@app/workforce/resources/employee';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { PropertyCommandSchema } from '../../shared/actions/apply-command.ts';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { propertyDraftErrors } from '../../src/routes/[lang]/nemovitosti/use-property-editor.ts';

type Draft = Parameters<typeof propertyDraftErrors>[0];
const emptyDraft: Draft = {
  address: '',
  code: '',
  lifecycleState: 'PLANNED',
  name: '',
  note: '',
  propertyType: '',
  responsibleEmployeeIds: [],
};
const propertyDraft: Draft = {
  ...emptyDraft,
  address: '12 Park Street',
  code: 'NEW-PROPERTY',
  name: 'Park House',
  propertyType: 'Residential',
};
const tenantId = '70000000-0000-4000-8000-000000000020';
const propertyRef = {
  moduleId: 'property.portfolio',
  resourceId: '76000000-0000-4000-8000-000000000001',
  resourceType: 'property.portfolio.property',
  tenantId,
};
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
      unitRef: {
        moduleId: 'property.portfolio',
        resourceId: '76000000-0000-4000-8000-000000000002',
        resourceType: 'property.portfolio.unit',
        tenantId,
      },
    },
  ],
});

it('returns translation keys for required property fields and employees', () => {
  expect(propertyDraftErrors(emptyDraft)).toEqual({
    address: 'required',
    code: 'required',
    name: 'required',
    propertyType: 'required',
    responsibleEmployeeIds: 'responsibleRequired',
  });
});

it.effect('requires responsible employees for both property creation and property editing', () =>
  Effect.gen(function* propertyEmployeeRequirements() {
    const records = yield* recordsEffect;
    const property = yield* Effect.fromNullishOr(records.properties[0]);
    const employeeId = yield* Schema.decodeUnknownEffect(EmployeeIdSchema)('75000000-0000-4000-8000-000000000001');
    expect(propertyDraftErrors(propertyDraft, records)).toEqual({
      responsibleEmployeeIds: 'responsibleRequired',
    });
    expect(propertyDraftErrors({ ...propertyDraft, responsibleEmployeeIds: [employeeId] }, records)).toEqual({});
    const editDraft: Draft = { ...propertyDraft, code: property.code, property };
    expect(propertyDraftErrors(editDraft, records)).toEqual({
      responsibleEmployeeIds: 'responsibleRequired',
    });
    expect(propertyDraftErrors({ ...editDraft, responsibleEmployeeIds: [employeeId] }, records)).toEqual({});
  }),
);

it.effect('keeps unit creation independent of employees while rejecting duplicate property and unit codes', () =>
  Effect.gen(function* unitCreationValidation() {
    const records = yield* recordsEffect;
    const property = yield* Effect.fromNullishOr(records.properties[0]);
    const unit = yield* Effect.fromNullishOr(records.units[0]);
    const draft: Draft = { ...emptyDraft, code: 'NEW-UNIT', name: 'Second Floor', unitFor: property };
    expect(propertyDraftErrors(draft, records)).toEqual({});
    expect(propertyDraftErrors({ ...draft, code: '  ' }, records)).toEqual({ code: 'required' });
    expect(propertyDraftErrors({ ...draft, code: property.code }, records)).toEqual({ code: 'duplicateCode' });
    expect(propertyDraftErrors({ ...draft, code: ` ${unit.code} ` }, records)).toEqual({ code: 'duplicateCode' });
  }),
);

it.effect('validates a unit edit without employees or property fields and ignores its unchanged duplicate code', () =>
  Effect.gen(function* unitEditHasOnlyEditableFieldRequirements() {
    const records = yield* recordsEffect;
    const unit = yield* Effect.fromNullishOr(records.units[0]);
    const draft: Draft = {
      ...emptyDraft,
      code: unit.code,
      name: 'Updated floor name',
      note: 'Updated note',
      unit,
    };
    expect(propertyDraftErrors(draft, records)).toEqual({});
    expect(propertyDraftErrors({ ...draft, code: '' }, records)).toEqual({});
    expect(propertyDraftErrors(draft)).toEqual({});
    const command = yield* Schema.decodeUnknownEffect(PropertyCommandSchema.cases.UpdateUnit)({
      _tag: 'UpdateUnit',
      name: draft.name,
      note: draft.note,
      unitRef: unit.unitRef,
    });
    expect(Schema.is(PropertyCommandSchema.cases.UpdateUnit)(command)).toBe(true);
    expect(command).toMatchObject({
      name: 'Updated floor name',
      note: 'Updated note',
      unitRef: unit.unitRef,
    });
  }),
);

it.effect('requires a nonblank unit edit name and uses the command name limit without limiting optional notes', () =>
  Effect.gen(function* unitEditTextValidation() {
    const records = yield* recordsEffect;
    const unit = yield* Effect.fromNullishOr(records.units[0]);
    const draft: Draft = { ...emptyDraft, name: 'Updated unit', unit };
    expect(propertyDraftErrors({ ...draft, name: '  ' }, records)).toEqual({ name: 'required' });
    expect(propertyDraftErrors({ ...draft, name: 'n'.repeat(301) }, records)).toEqual({ name: 'tooLong' });
    expect(propertyDraftErrors({ ...draft, name: ` ${'n'.repeat(300)} ` }, records)).toEqual({});
    expect(propertyDraftErrors({ ...draft, note: 'n'.repeat(301) }, records)).toEqual({});
    for (const note of [null, '', 'n'.repeat(301)]) {
      const command = yield* Schema.decodeUnknownEffect(PropertyCommandSchema.cases.UpdateUnit)({
        _tag: 'UpdateUnit',
        name: draft.name,
        note,
        unitRef: unit.unitRef,
      });
      expect(command.note).toBe(note);
    }
  }),
);

it.effect('returns the same tooLong key for existing property and new-unit text limits', () =>
  Effect.gen(function* existingDraftTextLimits() {
    const records = yield* recordsEffect;
    const property = yield* Effect.fromNullishOr(records.properties[0]);
    const employeeId = yield* Schema.decodeUnknownEffect(EmployeeIdSchema)('75000000-0000-4000-8000-000000000001');
    expect(
      propertyDraftErrors(
        { ...propertyDraft, address: 'a'.repeat(301), responsibleEmployeeIds: [employeeId] },
        records,
      ),
    ).toEqual({ address: 'tooLong' });
    expect(
      propertyDraftErrors({ ...emptyDraft, code: 'c'.repeat(301), name: 'New unit', unitFor: property }, records),
    ).toEqual({ code: 'tooLong' });
  }),
);
