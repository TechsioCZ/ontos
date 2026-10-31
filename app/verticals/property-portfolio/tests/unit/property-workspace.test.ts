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
const expectSlotOnce = (html: string, name: string) => {
  expect(html.split(`data-workspace-slot="${name}"`)).toHaveLength(2);
};

it('renders the portfolio property tree without selecting the first property or showing unit children', () => {
  const html = renderWorkspace({ units: [gardenUnit, secondGardenUnit, riversideUnit] });
  expect(controlWithText(html, gardenProperty.name)).not.toMatch(/\baria-current="(?:page|true)"/u);
  expect(controlWithText(html, riversideProperty.name)).not.toMatch(/\baria-current="(?:page|true)"/u);
  expect(html).not.toContain(gardenUnit.name);
  expect(html).not.toContain(secondGardenUnit.name);
  expect(html).not.toContain(riversideUnit.name);
});

it('replaces the portfolio list with the selected property and its scoped unit tree', () => {
  const html = renderWorkspace({
    property: gardenProperty,
    units: [gardenUnit, secondGardenUnit],
  });
  expect(controlWithText(html, gardenProperty.name)).toMatch(/\baria-current="(?:page|true)"/u);
  expect(controlWithText(html, gardenUnit.name)).not.toMatch(/\baria-current="(?:page|true)"/u);
  expect(controlWithText(html, secondGardenUnit.name)).not.toMatch(/\baria-current="(?:page|true)"/u);
  expect(html).toContain(gardenProperty.address);
  expect(html).not.toContain(riversideProperty.name);
  expect(html).not.toContain(riversideUnit.name);
});

it('marks only the selected unit as current while retaining its property and neighboring unit', () => {
  const html = renderWorkspace({
    property: gardenProperty,
    unit: secondGardenUnit,
    units: [gardenUnit, secondGardenUnit],
  });
  expect(controlWithText(html, secondGardenUnit.name)).toMatch(/\baria-current="(?:page|true)"/u);
  expect(controlWithText(html, gardenUnit.name)).not.toMatch(/\baria-current="(?:page|true)"/u);
  expect(controlWithText(html, gardenProperty.name)).not.toMatch(/\baria-current="(?:page|true)"/u);
  expect(html).not.toContain(riversideProperty.name);
  expect(html).not.toContain(riversideUnit.name);
});

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

it('renders real UI kit Solid tabs with the supplied controlled selection and content', () => {
  const html = renderWorkspace({
    activeTab: 'documents',
    property: gardenProperty,
    units: [gardenUnit],
  });
  const unitsTab = controlWithText(html, '>Units<');
  const documentsTab = controlWithText(html, '>Documents<');
  for (const tab of [unitsTab, documentsTab]) {
    expect(tab).toContain('data-scope="tabs"');
    expect(tab).toContain('data-part="trigger"');
    expect(tab).toContain('role="tab"');
    expect(tab).toContain('data-[selected]:text-tabs-trigger-fg-solid-selected');
  }
  expect(html).toContain('role="tablist"');
  expect(html).toContain('role="tabpanel"');
  expect(unitsTab).toContain('aria-selected="false"');
  expect(documentsTab).toContain('aria-selected="true"');
  expectSlotOnce(html, 'documents');
});

it('renders supplied filters, messages, editor, details and actions once without substituting demo content', () => {
  const html = renderWorkspace({
    property: gardenProperty,
    units: [gardenUnit],
  });
  for (const name of ['filters', 'messages', 'editor', 'details', 'actions', 'units']) {
    expectSlotOnce(html, name);
  }
  expect(controlWithText(html, 'Schedule maintenance')).toContain('type="button"');
  expect(html).not.toMatch(/\b(?:prototype|mock(?:ed)?|placeholder|lorem ipsum|developer|storybook)\b/iu);
  expect(html).not.toMatch(/\bvariant[\s-]*d\b/iu);
});

it('renders an empty portfolio without fabricated property or unit navigation', () => {
  const html = renderWorkspace({ properties: [], units: [] });
  for (const item of [gardenProperty, riversideProperty, gardenUnit, secondGardenUnit, riversideUnit]) {
    expect(html).not.toContain(item.name);
  }
  expectSlotOnce(html, 'messages');
  expectSlotOnce(html, 'editor');
});
