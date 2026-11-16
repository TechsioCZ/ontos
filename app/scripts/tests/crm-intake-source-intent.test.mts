import { readFileSync } from 'node:fs';
import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CatalogSnapshotEntrySchema } from '../../packages/core-runtime/src/access/model.ts';
import { scanAccessCatalogSource, buildAccessCatalogSnapshot } from '../authorization-catalog.mts';
import { policyRoleCellRows } from '../demo/access-policy.mts';
import {
  CRM_PARTY_INTAKE_WORKLOAD,
  partyHumanReaderKeys,
  partyHumanWriterKeys,
  reviewedDemoAssignments,
  reviewedMachinePrincipals,
  reviewedWorkloadBindings,
} from '../demo/permissions.mts';

const source = (file: string) => ({ file, source: readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8') });
const retiredCreateCapability = 'party.registry.crm-client-party.create';
const retiredReviewCapability = 'party.registry.crm-client-intake-review.read';
const carrierSources = [
  source('verticals/crm/src/api/pending-client-intake.read.ts'),
  source('verticals/crm/src/actions/intake-client-party.action.ts'),
  source('verticals/party-registry/src/actions/create-crm-client-party.action.ts'),
  source('verticals/party-registry/src/api/crm-client-intake-review.read.ts'),
];

it('leaves the intake workload to the platform: no hand-made principal, binding or role names it', () => {
  // The platform registers CRM's internal workload per company at release (release-internal-workloads.mts).
  expect(reviewedWorkloadBindings().some(({ workloadKey }) => workloadKey === CRM_PARTY_INTAKE_WORKLOAD)).toBe(false);
  expect(reviewedMachinePrincipals.some(({ displayName }) => displayName.includes('Party Registry'))).toBe(false);
  expect(reviewedDemoAssignments().some(({ principalId }) => principalId.includes('intake'))).toBe(false);
});
it('uses actual parsed workload-only CRM carriers and the composed crm delegated Party carrier', () => {
  const snapshot = buildAccessCatalogSnapshot(carrierSources, new Set(['crm']));
  expect(snapshot.invalid).toEqual([]);
  expect(snapshot.missing).toEqual([]);
  expect(snapshot.entries).toEqual([]);
  expect(
    snapshot.workloads
      .map(({ entrypointKey, moduleId, workloads }) => ({ entrypointKey, moduleId, workloads }))
      .toSorted((a, b) => a.entrypointKey.localeCompare(b.entrypointKey)),
  ).toEqual([
    {
      entrypointKey: 'demo.crm.api.pending-client-intake',
      moduleId: 'demo.crm',
      workloads: [CRM_PARTY_INTAKE_WORKLOAD],
    },
    { entrypointKey: 'demo.crm.intake-client-party', moduleId: 'demo.crm', workloads: [CRM_PARTY_INTAKE_WORKLOAD] },
  ]);
  for (const party of carrierSources.slice(2)) {
    const scanned = scanAccessCatalogSource(party.source, party.file);
    expect(scanned.problems).toEqual([]);
    const [carrier] = scanned.carriers;
    expect(carrier?.accessActor).toMatchObject({
      callers: ['crm'],
      subject: 'workload',
      subjectWorkloads: [CRM_PARTY_INTAKE_WORKLOAD],
    });
    expect(carrier?.accessDeclaration).toBeNull();
    expect(carrier?.accessWorkload).toBeNull();
    expect(carrier?.accessFieldGroups).toBeNull();
    expect(buildAccessCatalogSnapshot(carrierSources, new Set(['unrelated-app'])).invalid.length).toBeGreaterThan(0);
  }
});

it('does not resurrect retired Party intake permissions through reviewed human Roles, even from a stale catalog', () => {
  const readKeys = new Set<string>([...partyHumanReaderKeys, retiredReviewCapability]);
  const catalog = [...partyHumanWriterKeys, retiredCreateCapability, retiredReviewCapability].map((key) =>
    Schema.decodeUnknownSync(CatalogSnapshotEntrySchema)({
      key,
      kind: readKeys.has(key) ? 'read' : 'action',
      modes: readKeys.has(key) ? ['run'] : ['run', 'propose', 'approve'],
      moduleKey: 'party.registry',
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    }),
  );
  for (const { role } of reviewedDemoAssignments()) {
    const access = role.modules['party.registry'];
    if (access === undefined) {
      continue;
    }
    expect(role.restrictedModules).toContain('party.registry');
    const intended = access === 'read' ? partyHumanReaderKeys : partyHumanWriterKeys;
    expect(role.capabilityKeys?.['party.registry']).toEqual(intended);
    const scoped = {
      ...role,
      capabilityKeys: { 'party.registry': role.capabilityKeys?.['party.registry'] ?? [] },
      capabilityModes: {},
      capabilitySelectors: {},
      modules: { 'party.registry': access },
    };
    const cells = policyRoleCellRows(scoped, catalog);
    expect(Result.isSuccess(cells)).toBe(true);
    if (Result.isSuccess(cells)) {
      expect(cells.success.some(({ capabilityKey }) => capabilityKey === retiredCreateCapability)).toBe(false);
      expect(cells.success.some(({ capabilityKey }) => capabilityKey === retiredReviewCapability)).toBe(false);
      expect(cells.success.some(({ capabilityKey }) => capabilityKey === 'party.registry.party.create')).toBe(
        access === 'write',
      );
      expect(cells.success.some(({ capabilityKey }) => capabilityKey === 'party.registry.customer.list')).toBe(true);
    }
  }
});

it('keeps workload-only owner operations out of general MCP tool publication', () => {
  const contribution = source('verticals/party-registry/shared/mcp/contribution.ts').source;
  expect(contribution).toContain("'create-crm-client-party': OntosMcpHidden");
  expect(contribution).toContain("'crm-client-intake-review': OntosMcpHidden");
});

it('does not delegate the generic duplicate-detail or its identity-review fields to the intake workload', () => {
  const detail = source('verticals/party-registry/src/api/duplicate-candidate-detail.read.ts');
  const scanned = scanAccessCatalogSource(detail.source, detail.file);
  expect(scanned.problems).toEqual([]);
  expect(scanned.carriers).toHaveLength(1);
  expect(scanned.carriers[0]?.accessActor).toBeNull();
  expect(scanned.carriers[0]?.accessWorkload).toBeNull();
});

it('leaves the original Commerce customer-context generic Party create carrier unchanged', () => {
  const original = source('verticals/party-registry/src/actions/create-party.action.ts');
  const scanned = scanAccessCatalogSource(original.source, original.file);
  const carrier = scanned.carriers.find(
    ({ accessDeclaration }) => accessDeclaration?.key === 'party.registry.party.create',
  );
  expect(carrier?.accessActor?.callers).toEqual(['commerce-customer-context']);
  expect(carrier?.accessActor?.subjectWorkloads).not.toContain(CRM_PARTY_INTAKE_WORKLOAD);
});
