import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  AccessFieldGroup,
  AccessFieldGroupInput,
  AccessDeclarationInput,
} from '../../src/authorization/access-declaration.ts';
import { decodeAccessDeclaration, decodeAccessFieldGroups } from '../../src/authorization/access-declaration.ts';
import type { AccessAmount, AccessRecordTarget, DecisionCapabilityPolicy } from '../../src/access/decision/contract.ts';
import { withOptional } from '../../src/access/decision/optional.ts';
import { decideAccess } from '../../src/access/decision/engine.ts';
import { capabilityPolicyOf } from '../../src/access/enforcement/capability.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import { makeTestAccessDecision } from '../../src/access/enforcement/testing.ts';
import { ModuleKeySchema, PrincipalIdSchema, RecordKeySchema, TenantIdSchema } from '../../src/access/ids.ts';
import { buildAccessCatalogRelease } from '../../src/access/catalog/release.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { authorizeDeclaredFieldWrites, writtenFieldPaths } from '../../src/actions/field-write-authorization.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { amount, at, capability, cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';

/*
 * O74: a field group on a scope-wide entrypoint needs no record target. Its parent read is the
 * containing declaration's own capability decided scope-wide in this same scope, in the same engine
 * snapshot. A record-scoped entrypoint keeps the parent read it had. Every claim carries a negative
 * control, and the record-scoped controls prove the O74 shape widened nothing.
 */

const now = at('2026-11-03T12:00:00Z');
const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const readEntrypoint = defineSystemModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'core.shell.detail.staff-costs',
  moduleKey: 'core.shell',
  role: 'api',
});
const actionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'test.fields.action.price-change',
  moduleKey: 'test.fields',
  role: 'action',
});

const READ_KEY = 'core.shell.detail.read';
const SALARY_KEY = 'core.shell.detail.read-salaries';

/** The declaration of a governed read: scope-wide exactly when `selectors` is empty (Q2, O74). */
const readDeclaration = (selectors: readonly ('all' | 'assigned')[]): AccessDeclarationInput => ({
  key: READ_KEY,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'shell', level: 'basic' },
  risk: 'routine',
  selectors,
});

const salariesGroup = (overrides: Partial<AccessFieldGroupInput> = {}): AccessFieldGroupInput => ({
  fieldClass: 'salaries',
  fields: ['people.cost.amount'],
  key: SALARY_KEY,
  kind: 'field_read',
  modes: ['run'],
  placement: { group: 'shell', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
  ...overrides,
});

interface SalaryReadInput {
  readonly recordKey: string;
}

const groupedRead = (input: {
  readonly declaration: AccessDeclarationInput;
  readonly groups: readonly AccessFieldGroupInput[];
  readonly target?: (input: SalaryReadInput) => { readonly moduleKey: 'core.shell'; readonly recordKey: string };
}) =>
  defineRead(
    withOptional(
      {
        accessDeclaration: input.declaration,
        accessFieldGroups: input.groups,
        accessKind: 'detail',
        entrypoint: readEntrypoint,
        evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.shell.detail.staff-costs.v1' },
        inputSchema: Schema.Struct({ recordKey: RecordKeySchema }),
        legalEntityScope: 'forbidden',
        owningModuleKey: 'core.shell',
        policies: [],
        readKey: 'core.shell.detail.staff-costs',
        resultSchema: Schema.Struct({
          people: Schema.Array(Schema.Struct({ cost: Schema.Struct({ amount: Schema.optionalKey(Schema.Number) }) })),
        }),
        schemaVersion: '1',
      },
      'accessTarget',
      input.target,
    ),
    () => Effect.succeed({ evidence: { resultCount: 1 }, result: { people: [] } }),
    () => Effect.succeed({}),
  );

it('carries a field group on a scope-wide read without naming a record (O74)', () => {
  const registration = groupedRead({ declaration: readDeclaration([]), groups: [salariesGroup()] });
  expect(registration.descriptor.accessDeclaration?.key).toBe(READ_KEY);
  expect(registration.descriptor.accessFieldGroups?.map(({ key }) => key)).toEqual([SALARY_KEY]);
  expect(registration.descriptor.accessTarget).toBeUndefined();

  // The record-scoped control: the same group still demands the one record it is decided with.
  expect(() => groupedRead({ declaration: readDeclaration(['all']), groups: [salariesGroup()] })).toThrow(
    /must declare its accessTarget when its declaration is record-scoped/u,
  );
  // And with the record named it is accepted, exactly as before O74.
  expect(() =>
    groupedRead({
      declaration: readDeclaration(['all']),
      groups: [salariesGroup()],
      target: (input) => ({ moduleKey: 'core.shell', recordKey: input.recordKey }),
    }),
  ).not.toThrow();
});

const fieldPolicy = (): DecisionCapabilityPolicy => ({
  capabilityKey: capability(SALARY_KEY),
  fieldClass: 'salaries',
  kind: 'field_read',
  modes: ['run'],
  risk: 'sensitive',
  selectors: [],
});
const parentPolicy = (selectors: readonly ('all' | 'assigned')[] = []): DecisionCapabilityPolicy => ({
  capabilityKey: capability(READ_KEY),
  kind: 'read',
  modes: ['run'],
  risk: 'routine',
  selectors,
});

/** One decision of the real engine over exactly these cells. */
const decide = (cells: readonly ReturnType<typeof cell>[], parentSelectors: readonly ('all' | 'assigned')[] = []) => {
  const authority = makeAuthority({ cells });
  const check = makeCheck({ authority: { cells } });
  return Effect.map(
    decideAccess(authority.port, check.port, {
      actor: { actor: { _tag: 'Principal', principalId: person }, tenantId: tenant },
      now,
      request: {
        capability: fieldPolicy(),
        mode: 'run',
        parentRead: { capability: parentPolicy(parentSelectors) },
      },
    }),
    (decision) => ({ decision, snapshots: check.calls.checkBulk }),
  );
};

it.effect('decides a scope-wide field group with its own parent read in one snapshot (O74)', () =>
  Effect.gen(function* decidesScopeWideFieldGroupWithParent() {
    const fieldCell = cell({ capability: SALARY_KEY, selector: { _tag: 'all' } });
    const parentCell = cell({ capability: READ_KEY, selector: { _tag: 'all' } });

    const allowed = yield* decide([fieldCell, parentCell]);
    expect(allowed.decision.outcome).toBe('ALLOWED');
    // The field capability and its parent read travelled in the same bulk snapshot.
    expect(allowed.snapshots).toBe(1);
    expect(allowed.decision.evidence.some(({ witness }) => witness.purpose === 'parent_record_read')).toBe(true);

    // Negative control: without the parent read's own grant the field group proves nothing.
    const withoutParent = yield* decide([fieldCell]);
    expect(withoutParent.decision.outcome).toBe('DENIED');
    expect(withoutParent.decision.reasons.map(({ code }) => code)).toContain('deny.parent_read_required');

    // Negative control: without the field group's own grant the parent read alone grants nothing.
    const withoutField = yield* decide([parentCell]);
    expect(withoutField.decision.outcome).toBe('DENIED');
    expect(withoutField.decision.reasons.map(({ code }) => code)).not.toContain('deny.parent_read_required');
  }),
);

it.effect('refuses a parent read that is record-scoped and names no record (O74 keeps D14)', () =>
  Effect.gen(function* refusesRecordScopedParentWithoutRecord() {
    const decision = yield* decide([cell({ capability: SALARY_KEY }), cell({ capability: READ_KEY })], ['assigned']);
    expect(decision.decision.outcome).toBe('DENIED');
    expect(decision.decision.reasons.map(({ code }) => code)).toContain('deny.parent_read_required');
  }),
);

const ACTION_KEY = 'test.fields.action.price-change';
const WRITE_GROUP_KEY = 'test.fields.action.price-change.purchase-price';

const actionDeclaration = (selectors: readonly ('all' | 'assigned')[]): AccessDeclarationInput => ({
  key: ACTION_KEY,
  kind: 'action',
  modes: ['run'],
  placement: { group: 'fields', level: 'basic' },
  risk: 'routine',
  selectors,
});

const writeGroup = (overrides: Partial<AccessFieldGroupInput> = {}): AccessFieldGroupInput => ({
  fieldClass: 'purchase_prices',
  fields: ['derived.purchasePrice'],
  key: WRITE_GROUP_KEY,
  kind: 'field_write',
  modes: ['run'],
  placement: { group: 'fields', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
  ...overrides,
});

const writeGroups = (groups: readonly AccessFieldGroupInput[]): readonly AccessFieldGroup[] =>
  Result.getOrThrow(decodeAccessFieldGroups(groups, actionEntrypoint, ACTION_KEY));

const decodedActionDeclaration = (selectors: readonly ('all' | 'assigned')[]) =>
  Result.getOrThrow(decodeAccessDeclaration(actionDeclaration(selectors), actionEntrypoint));

const scope: OperationalScope = Object.freeze({
  authBindingId: 'binding-1',
  authContextRef: 'session-1',
  authMethod: 'session' as const,
  correlationId: 'c25-field-writes',
  principalId: PrincipalIdSchema.make(uuid(2)),
  tenantId: TenantIdSchema.make(uuid(1)),
});

const authorize = (input: {
  readonly answers: Readonly<Record<string, 'ALLOWED' | 'DENIED' | 'NEEDS_APPROVAL' | 'UNAVAILABLE'>>;
  readonly payload: unknown;
  readonly target?: AccessRecordTarget;
}) => {
  const gate = makeTestAccessDecision({
    answers: Object.fromEntries(
      Object.entries(input.answers).map(([key, outcome]) => [
        key,
        outcome === 'DENIED' ? { outcome, reasons: ['deny.insufficient_grant'] } : { outcome },
      ]),
    ),
    defaultAnswer: { outcome: 'ALLOWED' },
  });
  return Effect.map(
    authorizeDeclaredFieldWrites(
      withOptional(
        {
          accessDecision: gate,
          declaration: decodedActionDeclaration(input.target === undefined ? [] : ['assigned']),
          groups: writeGroups([writeGroup()]),
          legalEntityScope: 'optional',
          now,
          payload: input.payload,
          scope,
        },
        'target',
        input.target,
      ),
    ),
    (authorization) => ({ asked: gate.askedDecisions, authorization }),
  );
};

it.effect('refuses a payload that writes a governed field the caller may not write (R5a-3, O74)', () =>
  Effect.gen(function* refusesGovernedWrite() {
    const purchasePrice = { currency: 'CZK', minor: 1200 };

    const denied = yield* authorize({
      answers: { [WRITE_GROUP_KEY]: 'DENIED' },
      payload: { derived: { purchasePrice }, sellingPriceMinor: 2000 },
    });
    expect(denied.authorization.outcome).toBe('denied');
    expect(denied.authorization.failure?.code).toBe('action_permission_denied');
    expect(denied.authorization.failure?.reason).toContain('derived.purchasePrice');
    expect(denied.authorization.failure?.reasons).toContain('deny.insufficient_grant');
    // The group is decided against the Action's own capability, scope-wide and with no record (O74).
    expect(denied.asked).toHaveLength(1);
    expect(denied.asked[0]?.parentRead?.capability.capabilityKey).toBe(capability(ACTION_KEY));
    expect(denied.asked[0]?.parentRead?.target).toBeUndefined();
    expect(denied.asked[0]?.target).toBeUndefined();

    // Negative control: the same refusal is absent when the payload leaves the governed field out, so
    // every other field of the Action stays writable for the same caller.
    const otherField = yield* authorize({
      answers: { [WRITE_GROUP_KEY]: 'DENIED' },
      payload: { sellingPriceMinor: 2000 },
    });
    expect(otherField.authorization.outcome).toBe('allowed');
    expect(otherField.authorization.failure).toBeUndefined();

    // Negative control: a caller holding the group writes it.
    const granted = yield* authorize({
      answers: { [WRITE_GROUP_KEY]: 'ALLOWED' },
      payload: { derived: { purchasePrice } },
    });
    expect(granted.authorization.outcome).toBe('allowed');

    // A sensitive field that may only be proposed asks for an approval, never a silent run.
    const approvable = yield* authorize({
      answers: { [WRITE_GROUP_KEY]: 'NEEDS_APPROVAL' },
      payload: { derived: { purchasePrice } },
    });
    expect(approvable.authorization.outcome).toBe('denied');
    expect(approvable.authorization.failure?.code).toBe('action_approval_required');

    // And an unreadable field decision is a refusal to decide, never an allow (O48b).
    const unreadable = yield* authorize({
      answers: { [WRITE_GROUP_KEY]: 'UNAVAILABLE' },
      payload: { derived: { purchasePrice } },
    });
    expect(unreadable.authorization.outcome).toBe('unavailable');
  }),
);

it.effect('carries the record target of a record-scoped Action into its field parent read (O74)', () =>
  Effect.gen(function* carriesRecordScopedParent() {
    const target = { moduleKey: ModuleKeySchema.make('test.fields'), recordKey: RecordKeySchema.make('price-list-1') };
    const allowed = yield* authorize({ answers: {}, payload: {}, target });
    expect(allowed.authorization.outcome).toBe('allowed');
    expect(allowed.asked[0]?.parentRead?.target).toStrictEqual(target);
    expect(allowed.asked[0]?.target).toStrictEqual(target);
  }),
);

/**
 * The field groups of an Action decided by the real engine over exactly these cells: each group is
 * asked with the parent read `authorizeDeclaredFieldWrites` built, the way the gate hands it on.
 */
const authorizeWithEngine = (input: {
  readonly amount?: AccessAmount;
  readonly cells: readonly ReturnType<typeof cell>[];
}) => {
  const authority = makeAuthority({ cells: input.cells });
  const check = makeCheck({ authority: { cells: input.cells } });
  return authorizeDeclaredFieldWrites(
    withOptional(
      {
        accessDecision: {
          decide: (gate: GateInput) =>
            gate.carrier.accessDeclaration === undefined
              ? Effect.die('A field group is always asked with its declaration')
              : decideAccess(authority.port, check.port, {
                  actor: { actor: { _tag: 'Principal', principalId: person }, tenantId: tenant },
                  now: gate.now,
                  request: withOptional(
                    { capability: capabilityPolicyOf(gate.carrier.accessDeclaration), mode: 'run' },
                    'parentRead',
                    gate.parentRead,
                  ),
                }),
        },
        declaration: decodedActionDeclaration([]),
        groups: writeGroups([writeGroup()]),
        legalEntityScope: 'optional',
        now,
        payload: { derived: { purchasePrice: { currency: 'CZK', minor: 1200 } } },
        scope,
      },
      'amount',
      input.amount,
    ),
  );
};

it.effect('holds an amount-capped Action grant to the Action amount when it writes a governed field', () =>
  Effect.gen(function* holdsCappedParentToActionAmount() {
    const cappedRun = cell({ amountCeiling: { currency: 'CZK', limitMinor: 10_000 }, capability: ACTION_KEY });
    const fieldWrite = cell({ capability: WRITE_GROUP_KEY });

    // Below the ceiling, the capped Action grant justifies the field write it is the parent read of.
    const below = yield* authorizeWithEngine({ amount: amount(9999), cells: [cappedRun, fieldWrite] });
    expect(below.outcome).toBe('allowed');

    // Above the ceiling, the same grants refuse the governed field.
    const above = yield* authorizeWithEngine({ amount: amount(10_001), cells: [cappedRun, fieldWrite] });
    expect(above.outcome).toBe('denied');
    expect(above.failure?.reasons).toContain('deny.amount_exceeds_ceiling');

    // No amount is never read as within the ceiling.
    const missing = yield* authorizeWithEngine({ cells: [cappedRun, fieldWrite] });
    expect(missing.outcome).toBe('denied');
    expect(missing.failure?.reasons).toContain('deny.amount_required');

    // Without the field-write grant, the capped Action grant alone writes no governed field.
    const withoutField = yield* authorizeWithEngine({ amount: amount(9999), cells: [cappedRun] });
    expect(withoutField.outcome).toBe('denied');
    expect(withoutField.failure?.code).toBe('action_permission_denied');
    expect(withoutField.failure?.reasons).not.toContain('deny.parent_read_required');
  }),
);

it('names only the declared paths a payload really writes', () => {
  const [group] = writeGroups([writeGroup()]);
  expect(group).toBeDefined();
  if (group === undefined) {
    return;
  }
  expect(writtenFieldPaths(group, { derived: { purchasePrice: 10 } })).toEqual([['derived', 'purchasePrice']]);
  expect(writtenFieldPaths(group, { derived: { sellingPrice: 10 } })).toEqual([]);
  expect(writtenFieldPaths(group, { sellingPriceMinor: 10 })).toEqual([]);
  // A path addresses the payload root, so an array at any position applies the path to each row,
  // exactly as the read-side projection does.
  expect(writtenFieldPaths(group, [{ derived: { purchasePrice: 1 } }, {}])).toEqual([['derived', 'purchasePrice']]);
  const [rowGroup] = writeGroups([writeGroup({ fields: ['lines.derived.purchasePrice'] })]);
  expect(rowGroup).toBeDefined();
  if (rowGroup === undefined) {
    return;
  }
  expect(writtenFieldPaths(rowGroup, { lines: [{ derived: { purchasePrice: 1 } }, { derived: {} }] })).toEqual([
    ['lines', 'derived', 'purchasePrice'],
  ]);
  // Negative control: rows that write some other field are not governed by this path.
  expect(writtenFieldPaths(rowGroup, { lines: [{ derived: { sellingPrice: 1 } }] })).toEqual([]);
});

it('accepts a field group on a scope-wide Action at definition time (O74 needed no Action shift)', () => {
  expect(() =>
    defineAction(
      {
        accessDeclaration: actionDeclaration([]),
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.fields.action.price-change.v1' },
        accessFieldGroups: [writeGroup()],
        actionKey: ACTION_KEY,
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        entrypoint: actionEntrypoint,
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleKey: 'test.fields',
        payloadSchema: Schema.Struct({ derived: Schema.optionalKey(Schema.Struct({ purchasePrice: Schema.Number })) }),
        policies: [],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => Effect.void,
    ),
  ).not.toThrow();
});

/**
 * The parent read "Proč?" builds from the released catalog (O87): the field entry names its parent, the
 * release contains that parent, and the parent's own `selectors` decide whether a record target is named.
 * Nothing here reads the browser, and a scope-wide parent names no record at all (O74).
 */
it.effect('decides a released field group from the parent capability the release names (O87)', () =>
  Effect.gen(function* decidesFromReleasedParent() {
    const release = Result.getOrThrow(
      buildAccessCatalogRelease({
        installedModuleKeys: [ModuleKeySchema.make('core.shell')],
        modules: [
          {
            descriptors: [
              {
                accessDeclaration: readDeclaration([]),
                accessFieldGroups: [salariesGroup()],
                entrypoint: readEntrypoint,
              },
            ],
            moduleId: 'core.shell',
          },
        ],
        publishedAt: now,
      }),
    );
    const field = release.entries.find(({ key }) => key === SALARY_KEY);
    const parent = release.entries.find(({ key }) => key === field?.parentKey);
    // The field entry names its parent, and that parent is an entry of the same release.
    expect(field?.parentKey).toBe(READ_KEY);
    expect(parent?.key).toBe(READ_KEY);
    if (parent === undefined) {
      return;
    }
    // A scope-wide parent has no selectors, so the parent read names no record at all (O74).
    expect(parent.selectors).toEqual([]);
    const parentCapability: DecisionCapabilityPolicy = {
      capabilityKey: capability(parent.key),
      kind: parent.kind,
      modes: [...parent.modes],
      risk: parent.risk,
      selectors: [...parent.selectors],
    };

    const fieldCell = cell({ capability: SALARY_KEY, selector: { _tag: 'all' } });
    const parentCell = cell({ capability: READ_KEY, selector: { _tag: 'all' } });
    const decisionOf = (cells: readonly ReturnType<typeof cell>[]) => {
      const authority = makeAuthority({ cells });
      const check = makeCheck({ authority: { cells } });
      return decideAccess(authority.port, check.port, {
        actor: { actor: { _tag: 'Principal', principalId: person }, tenantId: tenant },
        now,
        request: {
          capability: fieldPolicy(),
          mode: 'run',
          parentRead: { capability: parentCapability },
        },
      });
    };

    const allowed = yield* decisionOf([fieldCell, parentCell]);
    expect(allowed.outcome).toBe('ALLOWED');
    expect(allowed.evidence.some(({ witness }) => witness.purpose === 'parent_record_read')).toBe(true);

    // Negative control: the same released parent read grants nothing without the field group's own grant.
    const withoutField = yield* decisionOf([parentCell]);
    expect(withoutField.outcome).toBe('DENIED');
    expect(withoutField.reasons.map(({ code }) => code)).not.toContain('deny.parent_read_required');
  }),
);
