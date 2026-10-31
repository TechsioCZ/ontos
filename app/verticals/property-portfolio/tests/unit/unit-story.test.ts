import { ContractPresentationSchema } from '@app/legal-agreements/contracts/records';
import { OccupancySchema } from '@app/property-leasing/contracts/records';
import { TaskSchema } from '@app/work-tasks/contracts/records';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { createElement } from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { UnitRecordSchema } from '../../shared/apis/records.ts';
import { AssetRefSchema } from '../../shared/resources/asset.ts';
import { UnitStory } from '../../src/routes/[lang]/nemovitosti/unit-story.tsx';

type StoryProps = ComponentProps<typeof UnitStory>;

const K = 'property-portfolio.pages.records.unitStory';
const tenantId = '70000000-0000-4000-8000-000000000020';
const otherTenantId = '70000000-0000-4000-8000-000000000021';
const ref = (owner: string, resource: string, index: number, tenant = tenantId) => ({
  moduleId: owner,
  resourceId: `76000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  resourceType: `${owner}.${resource}`,
  tenantId: tenant,
});
const unitRef = ref('property.portfolio', 'unit', 3);
const unit = Schema.decodeUnknownSync(UnitRecordSchema)({
  capacity: 2,
  code: '101',
  lifecycleState: 'ACTIVE',
  name: 'Apartment 101',
  note: null,
  propertyRef: ref('property.portfolio', 'property', 1),
  unitKind: 'Apartment',
  unitRef,
});
const lease = (index: number) => ({
  contractRef: null,
  customerCounterpartyRef: null,
  endDate: null,
  externalBookingCorrelation: null,
  guestPartyRef: null,
  kind: 'LONG_TERM_LEASE',
  note: null,
  occupancyRef: ref('property.leasing', 'occupancy', index),
  peopleCount: 2,
  startDate: '2026-10-05',
  state: 'ACTIVE',
  unitRef,
});
const contract = (index: number) => ({
  contractRef: ref('legal.agreements', 'contract', index),
  counterpartyRef: ref('party.registry', 'counterparty', 100),
  endDate: null,
  expiringSoon: true,
  hasSuccessorDraft: false,
  isExpired: false,
  kind: 'LEASE',
  lifecycleState: 'ACTIVE',
  note: null,
  occupancyRef: null,
  propertyRef: null,
  renewalNoticeDate: null,
  signatureState: 'SIGNED',
  startDate: '2026-10-05',
  subject: `Agreement ${index}`,
  supersedesContractRef: null,
  unitRef,
});
const task = (index: number) => ({
  collectionRef: ref('work.tasks', 'task-collection', 200),
  contextRefs: [unitRef],
  createdAt: '2026-10-01T12:00:00Z',
  dueDate: '2026-10-27',
  priority: 'NORMAL',
  ref: ref('work.tasks', 'task', index),
  state: 'IN_PROGRESS',
  title: `Task ${index}`,
  updatedAt: '2026-10-01T12:00:00Z',
});
const makeStoryProps = (leaseBlock?: StoryProps['leaseBlock']) =>
  ({
    agreements: {
      contracts: Schema.decodeUnknownSync(Schema.Array(ContractPresentationSchema))([contract(10)]),
      documents: [],
      revision: 1,
    },
    language: 'cs',
    leaseBlock,
    occupancy: {
      occupancies: Schema.decodeUnknownSync(Schema.Array(OccupancySchema))([
        {
          ...lease(30),
          rentTerms: { currency: 'CZK', monthlyRentMinor: 1_500_000, paymentDay: 5, serviceChargesMinor: 250_000 },
        },
        { ...lease(31), endDate: '2025-09-30', startDate: '2024-10-01', state: 'COMPLETED' },
      ]),
      revision: 1,
    },
    t: (key: string, options?: { readonly amount?: string; readonly date?: string }) =>
      [key, options?.amount, options?.date].filter((part) => part !== undefined).join('|'),
    tasks: Schema.decodeUnknownSync(Schema.Array(TaskSchema))([task(40)]),
    unit,
  }) satisfies StoryProps;
const props = makeStoryProps();
const renderStory = (overrides: Partial<StoryProps> = {}) =>
  renderToStaticMarkup(createElement(UnitStory, { ...props, ...overrides }));

it('keeps all three sections and headings when no tab section is requested', () => {
  const html = renderStory();
  expect(html.match(/<section\b/gu)).toHaveLength(3);
  expect(html.match(/<h3\b/gu)).toHaveLength(3);
  for (const label of ['leases', 'contracts', 'tasks']) {
    expect(html).toContain(`aria-label="${K}.${label}"`);
  }
  expect(html).toContain('propertyportfolio:lg:grid-cols-3');
});

it.each([
  ['leases', 'leases', '/cs/najmy?resourceId='],
  ['agreements', 'contracts', '/cs/smlouvy?resourceId='],
  ['tasks', 'tasks', '/cs/ukoly?resourceId='],
] as const)('renders only the requested %s section without repeating its heading', (section, label, link) => {
  const html = renderStory({ section });
  expect(html.match(/<section\b/gu)).toHaveLength(1);
  expect(html).toContain(`aria-label="${K}.${label}"`);
  expect(html).toContain(link);
  expect(html).not.toContain('<h3');
  expect(html).not.toContain('propertyportfolio:lg:grid-cols-3');
  for (const other of ['leases', 'contracts', 'tasks'].filter((name) => name !== label)) {
    expect(html).not.toContain(`aria-label="${K}.${other}"`);
  }
});

it('retains lease dates, rent including service charges, states, history order and owner links', () => {
  const html = renderStory({ section: 'leases' });
  expect(html).toContain('5. 10. 2026');
  expect(html).toContain('1. 10. 2024');
  expect(html).toContain('30. 9. 2025');
  expect(html).toContain(`${K}.openEnd`);
  const amount = new Intl.NumberFormat('cs-CZ', {
    currency: 'CZK',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(17_500);
  expect(html).toContain(`${K}.rent|${amount}`);
  expect(html).toContain(`${K}.noRent`);
  expect(html).toContain('property-portfolio.pages.records.occupancyStates.ACTIVE');
  expect(html).toContain('property-portfolio.pages.records.occupancyStates.COMPLETED');
  expect(html.indexOf(`resourceId=${ref('property.leasing', 'occupancy', 30).resourceId}`)).toBeLessThan(
    html.indexOf(`resourceId=${ref('property.leasing', 'occupancy', 31).resourceId}`),
  );
  expect(html).toContain(`/cs/najmy?create=lease&amp;unitId=${unitRef.resourceId}`);
});

it('retains contract subjects, fallback labels, dates, expiry badges, states, order and owner links', () => {
  const { subject: _subject, ...withoutSubject } = contract(11);
  const contracts = Schema.decodeUnknownSync(Schema.Array(ContractPresentationSchema))([
    { ...withoutSubject, endDate: '2025-09-30', expiringSoon: false, startDate: '2024-10-01' },
    contract(10),
  ]);
  const html = renderStory({ agreements: { ...props.agreements, contracts }, section: 'agreements' });
  expect(html).toContain('Agreement 10');
  expect(html).toContain(`>${K}.contract<`);
  expect(html).toContain('5. 10. 2026');
  expect(html).toContain('1. 10. 2024');
  expect(html).toContain('30. 9. 2025');
  expect(html).toContain(`${K}.openEnd`);
  expect(html).toContain(`${K}.expiring`);
  expect(html).toContain('property-portfolio.pages.records.agreementStates.ACTIVE');
  expect(html.indexOf(`/cs/smlouvy?resourceId=${ref('legal.agreements', 'contract', 10).resourceId}`)).toBeLessThan(
    html.indexOf(`/cs/smlouvy?resourceId=${ref('legal.agreements', 'contract', 11).resourceId}`),
  );
});

it('retains task titles, optional due dates, states and real owner links', () => {
  const { dueDate: _dueDate, ...withoutDueDate } = task(41);
  const tasks = Schema.decodeUnknownSync(Schema.Array(TaskSchema))([task(40), withoutDueDate]);
  const html = renderStory({ language: 'en', section: 'tasks', tasks });
  expect(html).toContain('Task 40');
  expect(html).toContain('Task 41');
  expect(html.split(`${K}.due|27. 10. 2026`)).toHaveLength(2);
  expect(html).toContain(`${K}.taskStates.IN_PROGRESS`);
  for (const index of [40, 41]) {
    expect(html).toContain(`/en/ukoly?resourceId=${ref('work.tasks', 'task', index).resourceId}`);
  }
  expect(html).toContain('href="/en/ukoly"');
});

it('scopes every section to the complete selected unit reference', () => {
  const otherRefs = [{ ...unitRef, tenantId: otherTenantId }, ref('property.portfolio', 'unit', 4)];
  const occupancies = Schema.decodeUnknownSync(Schema.Array(OccupancySchema))([
    lease(30),
    ...otherRefs.map((otherRef, index) => ({ ...lease(31 + index), unitRef: otherRef })),
  ]);
  const contracts = Schema.decodeUnknownSync(Schema.Array(ContractPresentationSchema))([
    contract(10),
    { ...contract(11), unitRef: null },
    ...otherRefs.map((otherRef, index) => ({ ...contract(12 + index), unitRef: otherRef })),
  ]);
  const tasks = Schema.decodeUnknownSync(Schema.Array(TaskSchema))([
    { ...task(40), contextRefs: [ref('property.portfolio', 'property', 1), unitRef, unitRef] },
    ...otherRefs.map((otherRef, index) => ({ ...task(41 + index), contextRefs: [otherRef] })),
    { ...task(43), contextRefs: [ref('property.portfolio', 'asset', 3)] },
    { ...task(44), contextRefs: [ref('legal.agreements', 'contract', 3)] },
  ]);
  const html = renderStory({
    agreements: { ...props.agreements, contracts },
    occupancy: { ...props.occupancy, occupancies },
    tasks,
  });
  expect(html).toContain(`/cs/najmy?resourceId=${ref('property.leasing', 'occupancy', 30).resourceId}`);
  for (const index of [31, 32]) {
    expect(html).not.toContain(`/cs/najmy?resourceId=${ref('property.leasing', 'occupancy', index).resourceId}`);
  }
  expect(html).toContain('Agreement 10');
  for (const index of [11, 12, 13]) {
    expect(html).not.toContain(`Agreement ${index}`);
  }
  expect(html.split('Task 40')).toHaveLength(2);
  for (const index of [41, 42, 43, 44]) {
    expect(html).not.toContain(`Task ${index}`);
  }
});

it.each(['building', 'outOfService', 'retired'] as const)(
  'preserves history but removes lease creation and vacant wording when blocked by %s',
  (leaseBlock) => {
    const html = renderStory({ leaseBlock, section: 'leases' });
    expect(html).toContain(`${K}.leaseBlock.${leaseBlock}`);
    expect(html).toContain('data-testid="unit-lease-block"');
    expect(html).toContain(`/cs/najmy?resourceId=${ref('property.leasing', 'occupancy', 30).resourceId}`);
    expect(html).not.toContain('create=lease');
    expect(html).not.toContain(`${K}.noLeases`);
    const empty = renderStory({
      leaseBlock,
      occupancy: { ...props.occupancy, occupancies: [] },
      section: 'leases',
    });
    expect(empty).not.toContain(`${K}.noLeases`);
    expect(empty).not.toContain('create=lease');
  },
);

it.each(['leases', 'agreements', 'tasks'] as const)(
  'distinguishes unloaded data from a loaded empty %s section',
  (section) => {
    const { agreements, occupancy, tasks }: Partial<StoryProps> = {};
    const unloaded = renderStory({ agreements, occupancy, section, tasks });
    expect(unloaded.split(`${K}.notLoaded`)).toHaveLength(2);
    const empty = renderStory({
      agreements: { contracts: [], documents: [], revision: 1 },
      occupancy: { occupancies: [], revision: 1 },
      section,
      tasks: [],
    });
    const emptyKey = { agreements: 'noContracts', leases: 'noLeases', tasks: 'noTasks' }[section];
    expect(empty).toContain(`${K}.${emptyKey}`);
    expect(empty).not.toContain(`${K}.notLoaded`);
    expect(unloaded).not.toContain(`${K}.${emptyKey}`);
  },
);

it('shows maintenance linked to the selected unit equipment without including a neighboring unit or tenant', () => {
  const asset = Schema.decodeUnknownSync(AssetRefSchema)(ref('property.portfolio', 'asset', 50));
  const neighboringAsset = ref('property.portfolio', 'asset', 51);
  const tasks = Schema.decodeUnknownSync(Schema.Array(TaskSchema))([
    { ...task(45), contextRefs: [asset] },
    { ...task(46), contextRefs: [neighboringAsset] },
    { ...task(47), contextRefs: [{ ...asset, tenantId: otherTenantId }] },
    { ...task(48), contextRefs: [asset, unit.unitRef] },
  ]);
  const html = renderStory({ section: 'tasks', tasks, unitAssets: [asset] });
  expect(html).toContain('Task 45');
  expect(html).not.toContain('Task 46');
  expect(html).not.toContain('Task 47');
  expect(html.split('Task 48')).toHaveLength(2);
  expect(html).toContain(`/cs/ukoly?resourceId=${ref('work.tasks', 'task', 45).resourceId}`);
  expect(html).not.toContain(`${K}.noTasks`);
});
