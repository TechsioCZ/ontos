import { EmployeeIdSchema } from '@app/workforce/resources/employee';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { createElement } from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PropertyCommandSchema } from '../../shared/actions/apply-command.ts';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { ResponsibleEmployeesField } from '../../src/routes/[lang]/nemovitosti/responsible-employees-field.tsx';
import {
  editCommandOf,
  propertyDraftErrors,
  propertyDraftOf,
  responsibleSelection,
  withResponsibleEmployees,
  withTextField,
} from '../../src/routes/[lang]/nemovitosti/use-property-editor.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const provozId = '845c2c4d-10f7-5f66-ae1a-05e062049f1a';
const vedeniId = '75000000-0000-4000-8000-000000000001';
const formerId = '75000000-0000-4000-8000-000000000002';
const hiddenId = '75000000-0000-4000-8000-000000000003';

interface StoredResponsible {
  readonly responsibleEmployeeIds?: readonly string[];
  readonly responsiblePerson?: string;
}

const building = (id: string, code: string, responsible: StoredResponsible) => ({
  address: 'Nábřeží Kapitána Jaroše 7, 170 00 Praha 7',
  code,
  createdAt: '2026-10-22T05:03:03.774Z',
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '71000000-0000-4000-8000-000000000021',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  lifecycleState: 'ACTIVE',
  name: 'Riverside Office Park',
  note: null,
  propertyRef: {
    moduleId: 'property.portfolio',
    resourceId: id,
    resourceType: 'property.portfolio.property',
    tenantId,
  },
  propertyType: 'Administrativní budova',
  updatedAt: '2026-11-02T11:11:38.043Z',
  ...responsible,
});

const fixture = Effect.gen(function* responsibleFixture() {
  const records = yield* Schema.decodeUnknownEffect(RecordsResponseSchema)({
    assets: [],
    properties: [
      building('528cd143-ef28-4b23-bebf-340ab530af8d', 'RIVERSIDE', {
        responsibleEmployeeIds: [provozId],
        responsiblePerson: 'Provoz Nájempark',
      }),
      building('76000000-0000-4000-8000-000000000011', 'LEGACY', { responsiblePerson: 'Provoz Nájempark' }),
      building('76000000-0000-4000-8000-000000000012', 'MIXED', { responsibleEmployeeIds: [formerId, hiddenId] }),
    ],
    revision: 7,
    units: [],
  });
  const id = Schema.decodeUnknownEffect(EmployeeIdSchema);
  const employees = [
    { active: true, fullName: 'Vedení Nájempark', id: yield* id(vedeniId) },
    { active: true, fullName: 'Provoz Nájempark', id: yield* id(provozId) },
    { active: false, fullName: 'Bývalý správce', id: yield* id(formerId) },
  ];
  const [riverside, legacy, mixed] = records.properties;
  return {
    employees,
    legacy: yield* Effect.fromNullishOr(legacy),
    mixed: yield* Effect.fromNullishOr(mixed),
    records,
    riverside: yield* Effect.fromNullishOr(riverside),
  };
});

const copy = {
  empty: 'Žádní zaměstnanci k výběru.',
  label: 'Odpovědná osoba',
  loading: 'Načítání zaměstnanců…',
  placeholder: 'Vyberte zaměstnance',
  required: 'Vyberte alespoň jednoho zaměstnance.',
  retry: 'Načíst zaměstnance znovu',
  unavailable: 'Nedostupný zaměstnanec',
};
/** The employee register could not be read (for example, no workforce access). */
const unreadableRegister = Option.getOrUndefined(Option.none<readonly never[]>());
const rejectRenderInteraction = () => {
  expect.unreachable('Rendering the field must not change the selection.');
};
const render = (selection: ComponentProps<typeof ResponsibleEmployeesField>['selection']) =>
  renderToStaticMarkup(
    createElement(ResponsibleEmployeesField, {
      copy,
      disabled: false,
      error: '',
      invalid: false,
      loading: false,
      onChange: rejectRenderInteraction,
      onRetry: rejectRenderInteraction,
      selection,
    }),
  );
const visibleText = (markup: string) => markup.replaceAll(/<[^>]*>/gu, ' ');
/** The chosen employees listed under the field: the closed listbox options do not count as shown. */
const chosenText = (markup: string) =>
  visibleText(
    /<ul aria-labelledby="property-responsible-employees-label"[^>]*>(?<list>.*?)<\/ul>/u.exec(markup)?.groups?.[
      'list'
    ] ?? '',
  );

it.effect('shows the stored responsible employee of a building in its editor', () =>
  Effect.gen(function* storedEmployeeShown() {
    const { employees, riverside } = yield* fixture;
    const selection = responsibleSelection(propertyDraftOf(riverside), employees);
    expect(selection.selected).toEqual([{ id: provozId, name: 'Provoz Nájempark' }]);
    expect(selection.legacyName).toBeUndefined();
    const markup = render(selection);
    expect(chosenText(markup)).toContain('Provoz Nájempark');
    expect(visibleText(markup)).not.toContain(provozId);
  }),
);

it.effect('keeps an older name-only responsible person as stored while another field is edited', () =>
  Effect.gen(function* legacyNameKept() {
    const { employees, legacy, records } = yield* fixture;
    const draft = propertyDraftOf(legacy);
    expect(draft.responsibleEmployeeIds).toEqual([]);
    expect(propertyDraftErrors(draft, records)).toEqual({});
    const selection = responsibleSelection(draft, employees);
    expect(selection).toMatchObject({ legacyName: 'Provoz Nájempark', selected: [] });
    expect(chosenText(render(selection))).toContain('Provoz Nájempark');
    const command = yield* Option.match(editCommandOf(withTextField(draft, 'note', 'Revize výtahu'), records), {
      onNone: () => Effect.die('the note edit must save'),
      onSome: Schema.decodeUnknownEffect(PropertyCommandSchema),
    });
    expect(Schema.is(PropertyCommandSchema.cases.UpdateProperty)(command)).toBe(true);
    expect(command).toMatchObject({ note: 'Revize výtahu' });
    expect(command).not.toHaveProperty('responsibleEmployeeIds');
    expect(command).not.toHaveProperty('responsiblePerson');
  }),
);

it.effect('stores employees on an older building only once someone picks them', () =>
  Effect.gen(function* legacyExplicitPick() {
    const { employees, legacy, records } = yield* fixture;
    const picked = withResponsibleEmployees(propertyDraftOf(legacy), [vedeniId]);
    const selection = responsibleSelection(picked, employees);
    expect(selection.legacyName).toBeUndefined();
    expect(selection.selected).toEqual([{ id: vedeniId, name: 'Vedení Nájempark' }]);
    expect(Option.getOrUndefined(editCommandOf(picked, records))).toMatchObject({ responsibleEmployeeIds: [vedeniId] });
  }),
);

it.effect('shows inactive and unreadable chosen employees without their identifiers', () =>
  Effect.gen(function* unreadableNeutral() {
    const { employees, mixed } = yield* fixture;
    const selection = responsibleSelection(propertyDraftOf(mixed), employees);
    expect(selection.selected).toEqual([{ id: formerId, name: 'Bývalý správce' }, { id: hiddenId }]);
    expect(selection.options.map((choice) => choice.id)).toEqual([vedeniId, provozId, formerId, hiddenId]);
    const markup = render(selection);
    expect(chosenText(markup)).toContain('Bývalý správce');
    expect(chosenText(markup)).toContain('Nedostupný zaměstnanec');
    expect(visibleText(markup)).not.toContain(hiddenId);
    const unreadable = render(responsibleSelection(propertyDraftOf(mixed), unreadableRegister));
    expect(chosenText(unreadable).match(/Nedostupný zaměstnanec/gu)).toHaveLength(2);
    expect(visibleText(unreadable)).not.toContain('Bývalý správce');
    expect(visibleText(unreadable)).not.toContain(formerId);
  }),
);

it.effect('still requires an employee once a stored choice is cleared', () =>
  Effect.gen(function* clearedRequired() {
    const { records, riverside } = yield* fixture;
    const cleared = withResponsibleEmployees(propertyDraftOf(riverside), []);
    expect(propertyDraftErrors(cleared, records)).toEqual({ responsibleEmployeeIds: 'responsibleRequired' });
    expect(Option.isNone(editCommandOf(cleared, records))).toBe(true);
    expect(responsibleSelection(cleared, []).legacyName).toBeUndefined();
  }),
);
