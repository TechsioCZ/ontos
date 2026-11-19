// The property workspace a portfolio user navigates: the selected property and unit are marked current, and the
// tree never keeps the units of a property the user left.
import { expect, it } from 'effect-rstest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PropertyWorkspace } from '../../src/routes/[lang]/nemovitosti/property-workspace.tsx';

type WorkspaceProps = ComponentProps<typeof PropertyWorkspace>;

const gardenProperty = {
  address: '12 Garden Street',
  archived: false,
  code: 'GARDEN',
  id: '76000000-0000-4000-8000-000000000001',
  name: 'Garden House',
  stateLabel: 'Active property',
  unitCount: 2,
} satisfies NonNullable<WorkspaceProps['property']>;
const riversideProperty = {
  address: '24 River Street',
  archived: false,
  code: 'RIVER',
  id: '76000000-0000-4000-8000-000000000002',
  name: 'Riverside House',
  stateLabel: 'Active property',
  unitCount: 1,
} satisfies NonNullable<WorkspaceProps['property']>;
const gardenUnit = {
  archived: false,
  availabilityLabel: 'Available unit',
  code: 'GARDEN-101',
  id: '76000000-0000-4000-8000-000000000003',
  name: 'Garden apartment',
  stateLabel: 'Active unit',
} satisfies NonNullable<WorkspaceProps['unit']>;
const secondGardenUnit = {
  ...gardenUnit,
  availabilityLabel: 'Occupied unit',
  code: 'GARDEN-102',
  id: '76000000-0000-4000-8000-000000000004',
  name: 'Garden studio',
} satisfies NonNullable<WorkspaceProps['unit']>;
const riversideUnit = {
  ...gardenUnit,
  code: 'RIVER-201',
  id: '76000000-0000-4000-8000-000000000005',
  name: 'Riverside apartment',
} satisfies NonNullable<WorkspaceProps['unit']>;

const slot = (name: string) => createElement('div', { 'data-workspace-slot': name }, `Supplied ${name} content`);
const actionSlot = createElement(
  'button',
  { 'data-workspace-slot': 'actions', type: 'button' },
  'Schedule maintenance',
);
const rejectRenderInteraction = () => {
  expect.unreachable('Rendering the workspace must not navigate or mutate records.');
};
const workspaceProps = {
  actions: actionSlot,
  activeTab: 'units',
  busy: false,
  canCreateUnit: true,
  details: slot('details'),
  editor: slot('editor'),
  filters: slot('filters'),
  messages: slot('messages'),
  onCreateProperty: rejectRenderInteraction,
  onCreateUnit: rejectRenderInteraction,
  onSelectResource: rejectRenderInteraction,
  onSelectTab: rejectRenderInteraction,
  properties: [gardenProperty, riversideProperty],
  t: (key: string) => key,
  tabs: [
    { content: slot('units'), label: 'Units', value: 'units' },
    { content: slot('documents'), label: 'Documents', value: 'documents' },
  ],
  units: [],
} satisfies WorkspaceProps;

const renderWorkspace = (props: Partial<WorkspaceProps> = {}) =>
  renderToStaticMarkup(createElement(PropertyWorkspace, { ...workspaceProps, ...props }));

const controls = (html: string) =>
  [...html.matchAll(/<(?<tag>button|a)\b[^>]*>[\s\S]*?<\/\k<tag>>/gu)].map((match) => match[0]);
const controlWithText = (html: string, text: string) => {
  const matches = controls(html).filter((control) => control.includes(text));
  expect(matches).toHaveLength(1);
  return matches[0] ?? '';
};
it('switches the scoped tree to another property without keeping the previous property units', () => {
  const html = renderWorkspace({
    property: riversideProperty,
    unit: riversideUnit,
    units: [riversideUnit],
  });
  expect(controlWithText(html, riversideProperty.name)).not.toMatch(/\baria-current="(?:page|true)"/u);
  expect(controlWithText(html, riversideUnit.name)).toMatch(/\baria-current="(?:page|true)"/u);
  expect(html).not.toContain(gardenProperty.name);
  expect(html).not.toContain(gardenUnit.name);
  expect(html).not.toContain(secondGardenUnit.name);
});
