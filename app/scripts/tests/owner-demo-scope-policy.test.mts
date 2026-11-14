import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { readAccessCatalogArtifact } from '../authorization-catalog-artifact.mts';
import { policyReleaseEntries, policyRoleCellRows } from '../demo/access-policy.mts';
import { demoModuleIds } from '../demo/permissions.mts';
import type { PolicyRole } from '../demo/access-policy.mts';

const TASK_MODULE = 'work.tasks';
const TASK_SEARCH = 'work.tasks.search-tasks.read';
const TASK_RECORDS = 'work.tasks.api-records.read';
const TASK_COMMAND = 'work.tasks.apply-command.write';

const releaseEntries = Effect.gen(function* ownerReleaseEntries() {
  const modules = yield* readAccessCatalogArtifact(fileURLToPath(new URL('../..', import.meta.url)));
  return yield* Effect.fromResult(policyReleaseEntries(modules, demoModuleIds));
});

it.effect('maps own-only Task reads to ASSIGNED without granting the scope-wide command Action', () =>
  Effect.gen(function* assignedTasksOnly() {
    const catalog = yield* releaseEntries;
    const keys = [TASK_RECORDS, TASK_SEARCH];
    const role: PolicyRole = {
      capabilitySelectors: Object.fromEntries(keys.map((key) => [key, 'assigned' as const])),
      label: 'Own Task read mapping control',
      modules: { [TASK_MODULE]: 'read' },
    };
    const cells = yield* Effect.fromResult(policyRoleCellRows(role, catalog));
    for (const key of keys) {
      expect(cells.filter(({ capabilityKey }) => capabilityKey === key)).toEqual([
        { capabilityKey: key, mode: 'run', selector: 'assigned' },
      ]);
    }
    expect(cells.some(({ capabilityKey }) => capabilityKey === TASK_COMMAND)).toBe(false);
    expect(cells.some(({ mode }) => mode !== 'run')).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('uses the final sensitive Task search carrier and does not give its read to an agent', () =>
  Effect.gen(function* sensitiveTaskSearch() {
    const catalog = yield* releaseEntries;
    const search = catalog.find(({ key }) => key === TASK_SEARCH);
    expect(search?.risk).toBe('sensitive');
    expect(search?.selectors).toEqual(['all', 'assigned']);
    const companyReader = yield* Effect.fromResult(
      policyRoleCellRows({ label: 'Reviewed company Task read', modules: { [TASK_MODULE]: 'read' } }, catalog),
    );
    expect(companyReader.filter(({ capabilityKey }) => capabilityKey === search?.key)).toEqual([
      { capabilityKey: TASK_SEARCH, mode: 'run', selector: 'all' },
    ]);
    const agent = yield* Effect.fromResult(
      policyRoleCellRows({ label: 'Agent Task control', modules: { [TASK_MODULE]: 'write' } }, catalog, 'agent'),
    );
    expect(agent.some(({ capabilityKey }) => capabilityKey === TASK_SEARCH)).toBe(false);
    expect(agent.some(({ capabilityKey }) => capabilityKey === TASK_RECORDS)).toBe(false);
    expect(
      agent.filter(({ capabilityKey }) => capabilityKey === TASK_COMMAND).every(({ mode }) => mode === 'propose'),
    ).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('preserves company-wide read scopes without deriving write authority for the four migrated owners', () =>
  Effect.gen(function* companyReadersOnly() {
    const catalog = yield* releaseEntries;
    for (const moduleKey of ['crm.activities', 'demo.workforce', 'demo.tagging', 'demo.sales-insights']) {
      const cells = yield* Effect.fromResult(
        policyRoleCellRows({ label: 'Company read mapping control', modules: { [moduleKey]: 'read' } }, catalog),
      );
      expect(cells.filter(({ capabilityKey }) => capabilityKey === `${moduleKey}.api-records.read`)).toEqual([
        { capabilityKey: `${moduleKey}.api-records.read`, mode: 'run', selector: 'all' },
      ]);
      expect(cells.some(({ capabilityKey }) => capabilityKey === `${moduleKey}.apply-command.write`)).toBe(false);
      expect(cells.some(({ mode }) => mode !== 'run')).toBe(false);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('does not synthesize Tagging ASSIGNED or TEAM selectors its owner does not support', () =>
  Effect.gen(function* unsupportedTaggingSelectors() {
    const catalog = yield* releaseEntries;
    for (const selector of ['assigned', 'team'] as const) {
      const compiled = policyRoleCellRows(
        {
          capabilitySelectors: { 'demo.tagging.api-records.read': selector },
          label: 'Unsupported Tagging selector control',
          modules: { 'demo.tagging': 'read' },
        },
        catalog,
      );
      expect(Result.isFailure(compiled)).toBe(true);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
