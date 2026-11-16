import { Result } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  accessCarrierIssue,
  collectAccessCatalog,
  decodeAccessDeclaration,
  decodeAccessDeclarationOrThrow,
  decodeAccessFieldGroups,
  decodeAccessWorkload,
  declaredAccessCarrier,
  deriveAgentPolicy,
  deriveCarrierAgentPolicy,
  hasDangerousAccessVerb,
  isProtectedAccessEntrypoint,
  missingAccessCarrierIssue,
} from '../../src/authorization/access-declaration.ts';
import type {
  AccessCatalogModule,
  AccessDeclarationInput,
  AccessDeclarationOwner,
  AccessFieldGroupInput,
  DeclaredAccessCarrier,
} from '../../src/authorization/access-declaration.ts';
import { AccessCatalogError } from '../../src/authorization/access-catalog-error.ts';
import { AccessDeclarationError } from '../../src/authorization/access-declaration-error.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { TenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

const actionOwner = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'action_execution', provisioning: 'explicit' },
  entrypointKey: 'party-registry.party.add-note',
  moduleKey: 'party-registry',
  role: 'action',
});
/** The v2 classification of the same Action: the kind no longer tells an Action from a page. */
const protectedActionOwner = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'party-registry.party.add-note',
  moduleKey: 'party-registry',
  role: 'action',
});
/** The v2 classification of a governed read: it may carry a workload marker (O72). */
const protectedReadOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'party-registry.party.list',
  moduleKey: 'party-registry',
  role: 'api',
});
/** The v2 classification of a shell contribution: protected, but never a governed read. */
const protectedContributionOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'party-registry.party.navigation',
  moduleKey: 'party-registry',
  role: 'search',
});
/** The v2 classification of a page: protected, but never an Action carrier. */
const protectedPageOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'party-registry.party.home',
  moduleKey: 'party-registry',
  role: 'page',
});
const dottedActionOwner = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'action_execution', provisioning: 'explicit' },
  entrypointKey: 'party.registry.party.add-note',
  moduleKey: 'party.registry',
  role: 'action',
});
const readOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'party-registry.party.list',
  moduleKey: 'party-registry',
  role: 'api',
});
const authenticatedOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'authenticated_principal' },
  entrypointKey: 'party-registry.party.me',
  moduleKey: 'party-registry',
  role: 'api',
});
const publicOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'public' },
  entrypointKey: 'party-registry.party.public',
  moduleKey: 'party-registry',
  role: 'api',
});
const capabilityOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { credential: 'session', kind: 'capability_issuance' },
  entrypointKey: 'party-registry.party.session',
  moduleKey: 'party-registry',
  role: 'api',
});
const backgroundOwner = defineTenantModuleEntrypoint({
  access: 'background',
  authorization: { kind: 'owner_local_background' },
  entrypointKey: 'party-registry.party.worker',
  moduleKey: 'party-registry',
  role: 'worker',
});

const routine = () =>
  ({
    key: 'party-registry.party.add-note',
    kind: 'action',
    modes: ['run'],
    placement: { group: 'parties', level: 'basic' },
    risk: 'routine',
    selectors: ['all', 'assigned', 'entrusted', 'team'],
  }) as const;

/** A valid authoring shape is decoded as written; commands default to the Action carrier. */
const decode = (input: AccessDeclarationInput, owner: AccessDeclarationOwner = actionOwner) =>
  Result.getOrThrow(decodeAccessDeclaration(input, owner));

/** Invalid controls are rejected before decoding, so they stay arbitrary unparsed values. */
const expectInvalid = <Input>(input: Input, owner: AccessDeclarationOwner = actionOwner): void => {
  const result = decodeAccessDeclaration(input, owner);
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(AccessDeclarationError);
    expect(result.failure.code).toBe('access_declaration_invalid');
  }
};

it('decodes the canonical declaration and freezes all nested output without freezing caller input', () => {
  const input = {
    ...routine(),
    amountInput: 'derived.totalGross',
    lineage: { renamedFrom: ['party-registry.party.note'], splitFrom: 'party-registry.party.edit' },
  };
  const decoded = decode(input);
  expect(decoded).toEqual(input);
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.isFrozen(decoded.placement)).toBe(true);
  expect(Object.isFrozen(decoded.modes)).toBe(true);
  expect(Object.isFrozen(decoded.selectors)).toBe(true);
  expect(Object.isFrozen(decoded.lineage)).toBe(true);
  expect(Object.isFrozen(decoded.lineage?.renamedFrom)).toBe(true);
  expect(Object.isFrozen(input)).toBe(false);
  expect(Object.isFrozen(input.lineage.renamedFrom)).toBe(false);
  expect(() => decodeAccessDeclarationOrThrow(input, actionOwner)).not.toThrow();
});

it('requires each canonical field and rejects excess properties at every nesting level', () => {
  const { key, kind, modes, placement, risk, selectors } = routine();
  for (const input of [
    undefined,
    {},
    { kind, modes, placement, risk, selectors },
    { key, modes, placement, risk, selectors },
    { key, kind, placement, risk, selectors },
    { key, kind, modes, risk, selectors },
    { key, kind, modes, placement, selectors },
    { key, kind, modes, placement, risk },
    { ...routine(), agentPolicy: 'run' },
    { ...routine(), placement: { ...placement, grant: true } },
    { ...routine(), lineage: { grant: true, renamedFrom: [] } },
  ]) {
    expectInvalid(input);
  }
});

it('accepts lowercase stable multi-segment keys and rejects nearby malformed identities', () => {
  expect(decode({ ...routine(), key: 'party-registry.party.add-note' }).key).toBe('party-registry.party.add-note');
  expect(decode({ ...routine(), key: 'party.registry.party.add-note.release1' }, dottedActionOwner).key).toBe(
    'party.registry.party.add-note.release1',
  );
  for (const key of [
    'party.party.add-note',
    'Party.party.add-note',
    'party-registry.party.addNote',
    'party-registry..add-note',
    '.party-registry.party.add-note',
    'party-registry.party.add-note.',
    'party-registry.party.add-note/x',
    'party-registry.party.-add-note',
    'party-registry.party.add-note--now',
    'party-registry.party.1add-note',
    'party-registry.party.add-note\n',
    'party-registry.party.add_note',
  ]) {
    expectInvalid({ ...routine(), key });
  }
});

it('keeps vocabularies closed and selectors/modes unique; empty selectors mean not record-scoped', () => {
  expect(decode({ ...routine(), selectors: [] }).selectors).toEqual([]);
  for (const input of [
    { ...routine(), kind: 'write' },
    { ...routine(), risk: 'low' },
    { ...routine(), modes: [] },
    { ...routine(), modes: ['run', 'run'] },
    { ...routine(), modes: ['execute'] },
    { ...routine(), selectors: ['owner'] },
    { ...routine(), selectors: ['all', 'all'] },
    { ...routine(), placement: { group: '', level: 'basic' } },
    { ...routine(), placement: { group: ' parties ', level: 'basic' } },
    { ...routine(), placement: { group: 'parties', level: 'low' } },
  ]) {
    expectInvalid(input);
  }
  for (const level of ['basic', 'extended', 'manage'] as const) {
    expect(decode({ ...routine(), placement: { group: 'parties', level } }).placement.level).toBe(level);
  }
});

it('requires sensitive-or-critical exports and admin operations', () => {
  for (const kind of ['export', 'admin'] as const) {
    expectInvalid({ ...routine(), kind }, readOwner);
    expect(decode({ ...routine(), kind, risk: 'sensitive' }, readOwner).risk).toBe('sensitive');
    expect(decode({ ...routine(), kind, risk: 'critical' }, readOwner).risk).toBe('critical');
  }
  expect(deriveAgentPolicy(decode(routine()))).toBe('run');
});

it('derives the agent policy: routine runs, sensitive Actions propose, admin and ephemeral never (O22, O45)', () => {
  const sensitive = { ...routine(), modes: ['run', 'propose'], risk: 'sensitive' } as const;
  expect(deriveAgentPolicy(decode(sensitive))).toBe('propose_only');
  expect(deriveAgentPolicy(decode({ ...sensitive, modes: ['run', 'propose', 'approve'] }))).toBe('propose_only');
  expect(deriveAgentPolicy(decode({ ...sensitive, ephemeral: true, modes: ['run'] }))).toBe('never');
  expect(deriveAgentPolicy({ kind: 'action', risk: 'routine' })).toBe('run');
});

it('never lets an agent read, export or administer sensitive material, and never administer at all (O45)', () => {
  expect(deriveAgentPolicy({ kind: 'admin', risk: 'sensitive' })).toBe('never');
  expect(deriveAgentPolicy({ kind: 'admin', risk: 'critical' })).toBe('never');
  expect(deriveAgentPolicy({ kind: 'admin', risk: 'routine' })).toBe('never');
  for (const kind of ['read', 'field_read', 'field_write', 'export'] as const) {
    expect(deriveAgentPolicy({ kind, risk: 'routine' })).toBe('run');
    expect(deriveAgentPolicy({ kind, risk: 'sensitive' })).toBe('never');
    expect(deriveAgentPolicy({ kind, risk: 'critical' })).toBe('never');
  }
  expect(deriveAgentPolicy(decode({ ...routine(), kind: 'read', risk: 'sensitive' }, readOwner))).toBe('never');
  expect(deriveAgentPolicy(decode({ ...routine(), kind: 'export', risk: 'sensitive' }, readOwner))).toBe('never');
});

it('classifies every dangerous verb regardless of case, camelCase, collapsed compound or separator', () => {
  const verbs = [
    'anonymize',
    'anonymise',
    'approve',
    'cancel',
    'close-period',
    'credit-note',
    'delete',
    'erase',
    'export',
    'grant',
    'impersonate',
    'merge',
    'pay',
    'payout',
    'publish',
    'purge',
    'refund',
    'remove',
    'retire',
    'revoke',
    'transfer',
    'void',
    'write-off',
  ];
  for (const verb of verbs) {
    const words = verb.split('-');
    const camel = words
      .map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase()}${word.slice(1)}`))
      .join('');
    for (const spelling of [
      verb,
      verb.toUpperCase(),
      camel,
      words.join('_'),
      words.join('.'),
      words.join(''),
      words.join(' / '),
    ]) {
      expect(hasDangerousAccessVerb(`party-registry.party.${spelling}`)).toBe(true);
      expectInvalid({ ...routine(), key: `party-registry.party.${spelling}` });
    }
    const key = `party-registry.party.${verb}`;
    expect(decode({ ...routine(), key, modes: ['run', 'propose'], risk: 'sensitive' }).key).toBe(key);
  }
  for (const verb of ['read', 'add-note', 'list', 'display', 'preview']) {
    expect(hasDangerousAccessVerb(`party-registry.party.${verb}`)).toBe(false);
    expect(decode({ ...routine(), key: `party-registry.party.${verb}` }).risk).toBe('routine');
  }
});

it('matches dangerous verbs as whole words only, and only in the verb segments after the resource (O6)', () => {
  for (const identifier of [
    'party-registry.emergency.create',
    'party-registry.party.avoid-contact',
    'party-registry.immigrant.register',
    'party-registry.payment.reconcile',
    'party-registry.payment.read',
    'party-registry.payment.approval',
    'party-registry.payment.compensate',
    'party-registry.partnership.list',
    'party-registry.party.approval-request',
  ]) {
    expect(hasDangerousAccessVerb(identifier)).toBe(false);
    expect(decode({ ...routine(), key: identifier }).risk).toBe('routine');
  }
  expect(hasDangerousAccessVerb('party-registry.party.delete.add-note')).toBe(true);
  expect(hasDangerousAccessVerb('party-registry.retire.add-note')).toBe(true);
});

it('requires a fieldClass only for field access and raises personal/financial visibility above routine', () => {
  for (const fieldClass of [
    'margins',
    'purchase_prices',
    'salaries',
    'personal_data',
    'bank_details',
    'credit_limits',
    'financial_amounts',
    'tax_identifiers',
    'authority_metadata',
  ]) {
    expectInvalid({ ...routine(), fieldClass, kind: 'field_read' }, readOwner);
    expectInvalid({ ...routine(), fieldClass, kind: 'field_write' }, actionOwner);
    expectInvalid({ ...routine(), fieldClass });
    expect(decode({ ...routine(), fieldClass, kind: 'field_read', risk: 'sensitive' }, readOwner).risk).toBe(
      'sensitive',
    );
    expect(
      decode({ ...routine(), fieldClass, kind: 'field_write', modes: ['run', 'propose'], risk: 'sensitive' }).risk,
    ).toBe('sensitive');
  }
  for (const kind of ['field_read', 'field_write'] as const) {
    expectInvalid({ ...routine(), kind }, kind === 'field_write' ? actionOwner : readOwner);
  }
  expect(decode({ ...routine(), fieldClass: 'public_labels', kind: 'field_read' }, readOwner).risk).toBe('routine');
  expect(decode({ ...routine(), fieldClass: 'public_labels', kind: 'field_write' }).risk).toBe('routine');
  expectInvalid({ ...routine(), fieldClass: ' ', kind: 'field_read' }, readOwner);
  expectInvalid({ ...routine(), fieldClass: 'Personal-Data', kind: 'field_read' }, readOwner);
  for (const fieldClass of ['commercial_activity', 'labels']) {
    expect(decode({ ...routine(), fieldClass, kind: 'field_read' }, readOwner).fieldClass).toBe(fieldClass);
  }
});

it('requires propose on sensitive and critical Actions while keeping approve optional and reads run-only', () => {
  for (const risk of ['sensitive', 'critical'] as const) {
    for (const modes of [['run'], ['approve'], ['run', 'approve']] as const) {
      expectInvalid({ ...routine(), modes, risk });
    }
    for (const modes of [
      ['run', 'propose'],
      ['run', 'propose', 'approve'],
      ['propose', 'approve'],
    ] as const) {
      expect(decode({ ...routine(), modes, risk }).modes).toEqual(modes);
    }
    expect(decode({ ...routine(), kind: 'read', risk }, readOwner).modes).toEqual(['run']);
    expect(decode({ ...routine(), fieldClass: 'public_labels', kind: 'field_read', risk }, readOwner).modes).toEqual([
      'run',
    ]);
    expectInvalid({ ...routine(), kind: 'read', modes: ['run', 'propose', 'approve'], risk }, readOwner);
    expectInvalid(
      { ...routine(), fieldClass: 'public_labels', kind: 'field_read', modes: ['run', 'propose'], risk },
      readOwner,
    );
  }
});

it('exempts admin declarations from propose while still requiring propose for approve (O43, O44)', () => {
  expect(decode({ ...routine(), kind: 'admin', risk: 'sensitive' }, readOwner).modes).toEqual(['run']);
  expect(
    decode({ ...routine(), kind: 'admin', modes: ['run', 'propose'], risk: 'critical' }, actionOwner).modes,
  ).toEqual(['run', 'propose']);
  expectInvalid({ ...routine(), kind: 'admin', modes: ['run', 'propose'], risk: 'critical' }, readOwner);
  expectInvalid({ ...routine(), kind: 'admin', modes: ['run', 'approve'], risk: 'sensitive' }, readOwner);
  expectInvalid({ ...routine(), kind: 'action', modes: ['run', 'approve'], risk: 'sensitive' });
  expectInvalid({ ...routine(), kind: 'admin', modes: ['approve'], risk: 'sensitive' }, readOwner);
});

it('waives propose for ephemeral Actions that must be exactly run-only (O22)', () => {
  for (const risk of ['sensitive', 'critical'] as const) {
    expect(decode({ ...routine(), ephemeral: true, modes: ['run'], risk }).ephemeral).toBe(true);
    expectInvalid({ ...routine(), ephemeral: true, modes: ['run', 'propose'], risk });
    expectInvalid({ ...routine(), ephemeral: true, modes: ['propose'], risk });
    expectInvalid({ ...routine(), ephemeral: true, modes: ['run', 'approve'], risk });
  }
  expectInvalid({ ...routine(), ephemeral: true, kind: 'read' }, readOwner);
  expectInvalid({ ...routine(), ephemeral: true, kind: 'export', risk: 'sensitive' }, readOwner);
});

it('permits a bounded property/index amount path on Actions only and validates lineage identities', () => {
  expect(decode({ ...routine(), amountInput: 'payment.total' }).amountInput).toBe('payment.total');
  expect(decode({ ...routine(), amountInput: 'derived.totalGross' }).amountInput).toBe('derived.totalGross');
  for (const amountInput of ['', '.amount', 'amount.', 'amount..value', 'amount[0]', ' amount', 'amount/value']) {
    expectInvalid({ ...routine(), amountInput });
  }
  expectInvalid({ ...routine(), amountInput: 'amount', kind: 'read' }, readOwner);
  for (const lineage of [
    { renamedFrom: ['bad'] },
    { splitFrom: 'bad' },
    {},
    { renamedFrom: ['party-registry.party.old', 'party-registry.party.old'] },
    { renamedFrom: ['party-registry.party.add-note'] },
    { renamedFrom: ['other-module.party.old'] },
    { renamedFrom: ['party-registry.party.old'], splitFrom: 'party-registry.party.old' },
  ]) {
    expectInvalid({ ...routine(), lineage });
  }
  expect(decode({ ...routine(), lineage: { renamedFrom: ['party-registry.party.old-note'] } }).lineage).toEqual({
    renamedFrom: ['party-registry.party.old-note'],
  });
  expect(() => decodeAccessDeclarationOrThrow({ ...routine(), risk: 'low' }, actionOwner)).toThrow(
    AccessDeclarationError,
  );
});

it('carries a declaration only on protected entrypoints that own the key', () => {
  for (const owner of [publicOwner, authenticatedOwner, backgroundOwner, capabilityOwner]) {
    expectInvalid(routine(), owner);
  }
  expectInvalid({ ...routine(), key: 'other-module.party.add-note' });
  expect(decode({ ...routine(), kind: 'read' }, readOwner).key).toBe('party-registry.party.add-note');
});

it('keeps direct entrypoints run-only and consistent with their read or write access', () => {
  expect(decode({ ...routine(), kind: 'read' }, readOwner).kind).toBe('read');
  expectInvalid({ ...routine(), kind: 'read', modes: ['run', 'propose'] }, readOwner);
  expectInvalid({ ...routine(), ephemeral: true, kind: 'read' }, readOwner);
  expectInvalid({ ...routine(), fieldClass: 'margins', kind: 'field_write', risk: 'sensitive' }, readOwner);
  expectInvalid({ ...routine(), kind: 'action' }, readOwner);
  expect(decode({ ...routine(), fieldClass: 'labels', kind: 'field_write' }, actionOwner).kind).toBe('field_write');
  expectInvalid({ ...routine(), kind: 'read' }, actionOwner);
});

const declarationFor = (key: string, overrides: Partial<AccessDeclarationInput> = {}): AccessDeclarationInput => ({
  ...routine(),
  key,
  ...overrides,
});

const entrypointFor = (moduleId: string, index: number, kind: string): TenantModuleEntrypoint =>
  kind === 'action' || kind === 'field_write'
    ? defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'explicit' },
        entrypointKey: `${moduleId}.party.${index}`,
        moduleKey: moduleId,
        role: 'action',
      })
    : defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: `${moduleId}.party.${index}`,
        moduleKey: moduleId,
        role: 'api',
      });

const moduleOf = (
  moduleId: string,
  declarations: readonly (AccessDeclarationInput | undefined)[],
): AccessCatalogModule => ({
  descriptors: declarations.flatMap((accessDeclaration, index) =>
    accessDeclaration === undefined
      ? []
      : [{ accessDeclaration, entrypoint: entrypointFor(moduleId, index, accessDeclaration.kind) }],
  ),
  moduleId,
});

const catalogError = (modules: readonly AccessCatalogModule[]) => {
  const result = collectAccessCatalog(modules);
  expect(Result.isFailure(result)).toBe(true);
  return Result.isFailure(result) ? result.failure : undefined;
};

it('collects a sorted report-only catalog across modules and keeps keys unique per module', () => {
  const catalog = Result.getOrThrow(
    collectAccessCatalog([
      moduleOf('party-registry', [declarationFor('party-registry.party.add-note'), undefined]),
      moduleOf('property-registry', [declarationFor('property-registry.property.add-note')]),
    ]),
  );
  expect(catalog.entries.map(({ accessDeclaration, moduleId }) => `${moduleId}/${accessDeclaration.key}`)).toEqual([
    'party-registry/party-registry.party.add-note',
    'property-registry/property-registry.property.add-note',
  ]);
  expect(catalog.findings).toEqual([]);
  expect(Object.isFrozen(catalog.entries)).toBe(true);
  expect(Object.isFrozen(catalog.entries[0]?.entrypoint)).toBe(true);

  const error = catalogError([
    moduleOf('party-registry', [
      declarationFor('party-registry.party.add-note'),
      declarationFor('party-registry.party.add-note'),
    ]),
  ]);
  expect(error).toBeInstanceOf(AccessCatalogError);
  expect(error?.code).toBe('access_catalog_duplicate_key');
});

it('rejects a catalog declaration, entrypoint or lineage that breaks the module boundary', () => {
  expect(catalogError([moduleOf('party-registry', [declarationFor('other-module.party.add-note')])])?.code).toBe(
    'access_catalog_declaration_invalid',
  );
  expect(
    catalogError([
      {
        descriptors: [
          {
            accessDeclaration: declarationFor('party-registry.party.add-note'),
            entrypoint: defineTenantModuleEntrypoint({
              access: 'write',
              authorization: { kind: 'action_execution', provisioning: 'explicit' },
              entrypointKey: 'property-registry.party.add-note',
              moduleKey: 'property-registry',
              role: 'action',
            }),
          },
        ],
        moduleId: 'party-registry',
      },
    ])?.code,
  ).toBe('access_catalog_foreign_entrypoint');
  expect(
    catalogError([
      moduleOf('party-registry', [
        declarationFor('party-registry.party.add-note', { lineage: { renamedFrom: ['other-module.party.old'] } }),
      ]),
    ])?.code,
  ).toBe('access_catalog_declaration_invalid');
});

it('rejects lineage cycles, renames into a live key and a key that is renamed twice', () => {
  expect(
    catalogError([
      moduleOf('party-registry', [
        declarationFor('party-registry.party.a', { lineage: { renamedFrom: ['party-registry.party.b'] } }),
        declarationFor('party-registry.party.b', { lineage: { renamedFrom: ['party-registry.party.a'] } }),
      ]),
    ])?.code,
  ).toBe('access_catalog_lineage_cycle');
  expect(
    catalogError([
      moduleOf('party-registry', [
        declarationFor('party-registry.party.add-note', { lineage: { renamedFrom: ['party-registry.party.old'] } }),
        declarationFor('party-registry.party.old'),
      ]),
    ])?.code,
  ).toBe('access_catalog_lineage_conflict');
  expect(
    catalogError([
      moduleOf('party-registry', [
        declarationFor('party-registry.party.a', { lineage: { renamedFrom: ['party-registry.party.old'] } }),
        declarationFor('party-registry.party.b', { lineage: { renamedFrom: ['party-registry.party.old'] } }),
      ]),
    ])?.code,
  ).toBe('access_catalog_lineage_conflict');
  const split = Result.getOrThrow(
    collectAccessCatalog([
      moduleOf('party-registry', [
        declarationFor('party-registry.party.a', { lineage: { splitFrom: 'party-registry.party.old' } }),
        declarationFor('party-registry.party.b', { lineage: { splitFrom: 'party-registry.party.old' } }),
      ]),
    ]),
  );
  expect(split.entries).toHaveLength(2);
});

it('reports unlisted field classes and routine terminal verbs as non-fatal findings', () => {
  const catalog = Result.getOrThrow(
    collectAccessCatalog([
      moduleOf('party-registry', [
        declarationFor('party-registry.party.archive'),
        declarationFor('party-registry.party.field', {
          fieldClass: 'commercial_activity',
          kind: 'field_read',
          risk: 'sensitive',
        }),
        declarationFor('party-registry.party.labels', { fieldClass: 'labels', kind: 'field_read' }),
      ]),
    ]),
  );
  expect(catalog.entries).toHaveLength(3);
  expect(catalog.findings.map(({ code, key }) => `${code}/${key}`)).toEqual([
    'routine_terminal_verb/party-registry.party.archive',
    'unlisted_field_class/party-registry.party.field',
    'unlisted_field_class/party-registry.party.labels',
  ]);
  expect(Object.isFrozen(catalog.findings[0])).toBe(true);
});

const parentKey = 'party-registry.party.read';

/** A valid `field_read` group; the negative controls below override exactly one rule at a time. */
const sensitiveGroup = (overrides: Partial<AccessFieldGroupInput> = {}): AccessFieldGroupInput => ({
  fieldClass: 'margins',
  fields: ['margins.amount', 'margins.currencyCode'],
  key: 'party-registry.party.read-margins',
  kind: 'field_read',
  modes: ['run'],
  placement: { group: 'parties', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
  ...overrides,
});

/** The parent declaration of the field-group fixtures: a routine read on the parent key. */
const parentDeclaration = (): AccessDeclarationInput => ({ ...routine(), key: parentKey, kind: 'read' });

const expectGroupsInvalid = (
  inputs: readonly object[],
  owner: AccessDeclarationOwner = readOwner,
  parent: string = parentKey,
): void => {
  const result = decodeAccessFieldGroups(inputs, owner, parent);
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(AccessDeclarationError);
    expect(result.failure.code).toBe('access_declaration_invalid');
  }
};

it('decodes and freezes a sensitive field group without freezing caller input', () => {
  const input = sensitiveGroup();
  const groups = Result.getOrThrow(decodeAccessFieldGroups([input], readOwner, parentKey));
  expect(groups).toHaveLength(1);
  expect(groups[0]).toEqual(input);
  expect(Object.isFrozen(groups)).toBe(true);
  expect(Object.isFrozen(groups[0])).toBe(true);
  expect(Object.isFrozen(groups[0]?.fields)).toBe(true);
  expect(Object.isFrozen(groups[0]?.modes)).toBe(true);
  expect(Object.isFrozen(groups[0]?.placement)).toBe(true);
  expect(Object.isFrozen(groups[0]?.selectors)).toBe(true);
  expect(Object.isFrozen(input)).toBe(false);
  expect(Object.isFrozen(input.fields)).toBe(false);
  expect(Result.getOrThrow(decodeAccessFieldGroups([], readOwner, parentKey))).toEqual([]);
});

it('matches the field group kind to its carrier in both directions (O58)', () => {
  expect(Result.isSuccess(decodeAccessFieldGroups([sensitiveGroup()], readOwner, parentKey))).toBe(true);
  expect(
    Result.isSuccess(
      decodeAccessFieldGroups(
        [sensitiveGroup({ key: 'party-registry.party.write-margins', kind: 'field_write' })],
        actionOwner,
        parentKey,
      ),
    ),
  ).toBe(true);
  expectGroupsInvalid([sensitiveGroup({ kind: 'field_write' })]);
  expectGroupsInvalid([sensitiveGroup({ key: 'party-registry.party.margins' })], actionOwner);
  expectGroupsInvalid([sensitiveGroup()], actionOwner);
  for (const owner of [authenticatedOwner, publicOwner, backgroundOwner, capabilityOwner]) {
    expectGroupsInvalid([sensitiveGroup()], owner);
  }
});

it('requires a field class with the O19 sensitive floor and bounded unique field paths', () => {
  const { fieldClass: declaredClass, ...withoutClass } = sensitiveGroup();
  expect(declaredClass).toBe('margins');
  expectGroupsInvalid([withoutClass]);
  expectGroupsInvalid([sensitiveGroup({ risk: 'routine' })]);
  for (const fieldClass of [
    'bank_details',
    'salaries',
    'purchase_prices',
    'credit_limits',
    'financial_amounts',
    'tax_identifiers',
    'authority_metadata',
    'personal_data',
  ]) {
    expectGroupsInvalid([sensitiveGroup({ fieldClass, risk: 'routine' })]);
  }
  const routineCommercial = Result.getOrThrow(
    decodeAccessFieldGroups(
      [sensitiveGroup({ fieldClass: 'commercial_activity', risk: 'routine' })],
      readOwner,
      parentKey,
    ),
  );
  expect(routineCommercial[0]?.risk).toBe('routine');
  expectGroupsInvalid([sensitiveGroup({ fields: [] })]);
  expectGroupsInvalid([sensitiveGroup({ fields: ['margins.amount', 'margins.amount'] })]);
  for (const path of [
    '',
    ' margins.amount',
    'margins.amount ',
    'margins.amount[0]',
    'Margins.amount',
    'margins..amount',
  ]) {
    expectGroupsInvalid([sensitiveGroup({ fields: [path] })]);
  }
  expectGroupsInvalid([{ ...sensitiveGroup(), note: 'extra' }]);
});

it('keeps a field group out of record scopes and run-only unless propose and approve are both declared', () => {
  expectGroupsInvalid([sensitiveGroup({ selectors: ['all'] })]);
  expectGroupsInvalid([sensitiveGroup({ selectors: ['assigned'] })]);
  expectGroupsInvalid([sensitiveGroup({ modes: ['run', 'propose'] })]);
  expectGroupsInvalid([sensitiveGroup({ modes: ['propose'] })]);
  const writeGroup = (modes: readonly ('approve' | 'propose' | 'run')[]) =>
    sensitiveGroup({ key: 'party-registry.party.write-margins', kind: 'field_write', modes });
  expect(Result.isSuccess(decodeAccessFieldGroups([writeGroup(['run'])], actionOwner, parentKey))).toBe(true);
  expect(
    Result.isSuccess(decodeAccessFieldGroups([writeGroup(['run', 'propose', 'approve'])], actionOwner, parentKey)),
  ).toBe(true);
  for (const modes of [['run', 'propose'], ['run', 'approve'], ['propose', 'approve'], ['propose']] as const) {
    expectGroupsInvalid([writeGroup(modes)], actionOwner);
  }
});

it('keeps the group key in its module, distinct from the parent and unique on the descriptor', () => {
  expectGroupsInvalid([sensitiveGroup({ key: parentKey })]);
  expectGroupsInvalid([sensitiveGroup({ key: 'other-module.party.read-margins' })]);
  expectGroupsInvalid([sensitiveGroup({ key: 'party-registry.read-margins' })]);
  expectGroupsInvalid([sensitiveGroup(), sensitiveGroup()]);
  expectGroupsInvalid([
    sensitiveGroup({
      fieldClass: 'commercial_activity',
      key: 'party-registry.party.read-margins.delete',
      risk: 'routine',
    }),
  ]);
  const twoGroups = Result.getOrThrow(
    decodeAccessFieldGroups(
      [sensitiveGroup(), sensitiveGroup({ fieldClass: 'salaries', key: 'party-registry.party.read-salaries' })],
      readOwner,
      parentKey,
    ),
  );
  expect(twoGroups.map((group) => group.key)).toEqual([
    'party-registry.party.read-margins',
    'party-registry.party.read-salaries',
  ]);
});

it('decodes a workload marker for an Action only and keeps its reason non-empty', () => {
  const workload = Result.getOrThrow(
    decodeAccessWorkload(
      { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
      actionOwner,
    ),
  );
  expect(workload.reason).toBe('machine provisioning only');
  expect(Object.isFrozen(workload)).toBe(true);
  for (const reason of ['', '   ', ' padded ', 'x'.repeat(401)]) {
    const rejected = decodeAccessWorkload({ reason }, actionOwner);
    expect(Result.isFailure(rejected)).toBe(true);
    expect(Result.isFailure(rejected) ? rejected.failure.code : null).toBe('access_declaration_invalid');
  }
  const missing = decodeAccessWorkload({}, actionOwner);
  expect(Result.isFailure(missing)).toBe(true);
  const excess = decodeAccessWorkload({ grantedTo: 'party-registry.party', reason: 'machine only' }, actionOwner);
  expect(Result.isFailure(excess)).toBe(true);
  for (const owner of [
    readOwner,
    backgroundOwner,
    authenticatedOwner,
    protectedPageOwner,
    protectedContributionOwner,
  ]) {
    const rejected = decodeAccessWorkload(
      { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
      owner,
    );
    expect(Result.isFailure(rejected)).toBe(true);
    if (Result.isFailure(rejected)) {
      expect(rejected.failure.reason).toContain('cannot carry accessWorkload');
    }
  }
  // O72: a governed read is a workload carrier too, alone or beside its declaration.
  expect(
    Result.getOrThrow(
      decodeAccessWorkload(
        { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
        protectedReadOwner,
      ),
    ).reason,
  ).toBe('machine provisioning only');
  const dualRead = declaredAccessCarrier({
    accessDeclaration: { ...parentDeclaration(), selectors: [] },
    accessWorkload: {
      reason: 'the machine path provisions, the human path reads',
      workloads: ['party-registry.machine-provisioner'],
    },
    entrypoint: protectedReadOwner,
  });
  expect(dualRead.accessDeclaration?.key).toBe(parentKey);
  expect(dualRead.accessWorkload?.reason).toBe('the machine path provisions, the human path reads');
});

it('spreads one validated carrier: declaration, its field groups and the workload marker (O58, O59)', () => {
  const carrier = declaredAccessCarrier({
    accessDeclaration: parentDeclaration(),
    accessFieldGroups: [sensitiveGroup()],
    entrypoint: readOwner,
  });
  expect(carrier.accessDeclaration?.key).toBe(parentKey);
  expect(carrier.accessFieldGroups?.map((group) => group.key)).toEqual(['party-registry.party.read-margins']);
  expect(carrier.accessFieldGroups?.[0]?.key).toBe('party-registry.party.read-margins');
  expect(Object.isFrozen(carrier.accessFieldGroups)).toBe(true);
  expect(carrier.accessWorkload).toBeUndefined();

  const workloadCarrier = declaredAccessCarrier({
    accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
    entrypoint: actionOwner,
  });
  expect(workloadCarrier.accessWorkload?.reason).toBe('machine provisioning only');
  expect(workloadCarrier.accessDeclaration).toBeUndefined();

  // O67-Q4: one Action may carry both, because the two paths admit disjoint principals.
  const dualCarrier = declaredAccessCarrier({
    accessDeclaration: routine(),
    accessWorkload: {
      reason: 'the machine path provisions, the human path edits',
      workloads: ['party-registry.machine-provisioner'],
    },
    entrypoint: actionOwner,
  });
  expect(dualCarrier.accessDeclaration?.key).toBe(routine().key);
  expect(dualCarrier.accessWorkload?.reason).toBe('the machine path provisions, the human path edits');

  // O62: a protected carrier must declare something; an unprotected one declares nothing.
  expect(() => declaredAccessCarrier({ entrypoint: actionOwner })).toThrow(AccessDeclarationError);
  expect(Object.keys(declaredAccessCarrier({ entrypoint: authenticatedOwner }))).toEqual([]);

  const failures: readonly (() => DeclaredAccessCarrier)[] = [
    () => declaredAccessCarrier({ accessFieldGroups: [sensitiveGroup()], entrypoint: readOwner }),
    () =>
      declaredAccessCarrier({
        accessDeclaration: parentDeclaration(),
        accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
        entrypoint: readOwner,
      }),
    () =>
      declaredAccessCarrier({
        accessDeclaration: parentDeclaration(),
        accessFieldGroups: [sensitiveGroup()],
        accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
        entrypoint: readOwner,
      }),
    () =>
      declaredAccessCarrier({
        accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
        entrypoint: readOwner,
      }),
    () =>
      declaredAccessCarrier({
        accessWorkload: { reason: '', workloads: ['party-registry.machine-provisioner'] },
        entrypoint: actionOwner,
      }),
    // A workload never carries a human field grant, not even beside a declaration.
    () =>
      declaredAccessCarrier({
        accessDeclaration: routine(),
        accessFieldGroups: [sensitiveGroup({ key: 'party-registry.party.write-margins', kind: 'field_write' })],
        accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
        entrypoint: actionOwner,
      }),
  ];
  for (const fail of failures) {
    expect(fail).toThrow(AccessDeclarationError);
  }
});

it('names the registered workloads a carrier admits and refuses a foreign module key (O73)', () => {
  const decoded = Result.getOrThrow(
    decodeAccessWorkload(
      { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
      actionOwner,
    ),
  );
  expect(decoded.workloads).toEqual(['party-registry.machine-provisioner']);
  expect(Object.isFrozen(decoded.workloads)).toBe(true);
  // A key outside the carrier's own module namespace is never admitted (O73).
  for (const workloads of [
    ['other-module.machine-provisioner'],
    ['party.registry.machine-provisioner'],
    ['machine-provisioner'],
    ['party-registry.'],
    ['Party-Registry.machine-provisioner'],
  ]) {
    expect(
      Result.isFailure(decodeAccessWorkload({ reason: 'machine provisioning only', workloads }, actionOwner)),
    ).toBe(true);
  }
  const foreign = decodeAccessWorkload(
    { reason: 'machine provisioning only', workloads: ['other-module.x'] },
    actionOwner,
  );
  expect(Result.isFailure(foreign)).toBe(true);
  if (Result.isFailure(foreign)) {
    expect(foreign.failure.reason).toContain('does not belong to the module of party-registry');
  }
  // The module root, not the full key: a dotted module owns its whole root namespace.
  expect(
    Result.isSuccess(
      decodeAccessWorkload(
        { reason: 'machine provisioning only', workloads: ['party.machine-provisioner'] },
        dottedActionOwner,
      ),
    ),
  ).toBe(true);
  expect(
    Result.isFailure(
      decodeAccessWorkload(
        { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
        dottedActionOwner,
      ),
    ),
  ).toBe(true);
});

it('requires at least one workload key and never repeats one (O73)', () => {
  for (const workloads of [[], ['party-registry.a', 'party-registry.a']]) {
    expect(
      Result.isFailure(decodeAccessWorkload({ reason: 'machine provisioning only', workloads }, actionOwner)),
    ).toBe(true);
  }
  // The reason is still required beside the keys.
  expect(
    Result.isFailure(
      decodeAccessWorkload({ reason: '', workloads: ['party-registry.machine-provisioner'] }, actionOwner),
    ),
  ).toBe(true);
});

it('accepts the v2 protected classification on an Action and on a page (CUTOVER-PLAN §4.2)', () => {
  for (const owner of [protectedActionOwner, protectedPageOwner]) {
    expect(isProtectedAccessEntrypoint(owner)).toBe(true);
    expect(missingAccessCarrierIssue({ entrypoint: owner })).toContain(
      'must declare accessDeclaration, accessWorkload or accessActor',
    );
  }
  // The role, not the kind, decides which carrier rules apply.
  expect(decodeAccessDeclarationOrThrow(routine(), protectedActionOwner).key).toBe(routine().key);
  expect(decodeAccessDeclarationOrThrow({ ...parentDeclaration(), selectors: [] }, protectedPageOwner).key).toBe(
    parentKey,
  );
  // A page never proposes, and an Action may (O42).
  expect(
    Result.isFailure(
      decodeAccessDeclaration({ ...parentDeclaration(), modes: ['run', 'propose'] }, protectedPageOwner),
    ),
  ).toBe(true);
  expect(
    Result.isSuccess(
      decodeAccessDeclaration({ ...routine(), kind: 'action', modes: ['run', 'propose'] }, protectedActionOwner),
    ),
  ).toBe(true);
  expect(Result.isSuccess(decodeAccessFieldGroups([sensitiveGroup()], protectedPageOwner, parentKey))).toBe(true);
  expect(
    Result.isSuccess(
      decodeAccessFieldGroups(
        [sensitiveGroup({ key: 'party-registry.party.write-margins', kind: 'field_write' })],
        protectedActionOwner,
        parentKey,
      ),
    ),
  ).toBe(true);
  expect(
    Result.getOrThrow(
      decodeAccessWorkload(
        { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
        protectedActionOwner,
      ),
    ).reason,
  ).toBe('machine provisioning only');
  const workloadOnPage = decodeAccessWorkload(
    { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
    protectedPageOwner,
  );
  expect(Result.isFailure(workloadOnPage)).toBe(true);
  if (Result.isFailure(workloadOnPage)) {
    expect(workloadOnPage.failure.reason).toContain('only an Action or a governed read can be a workload');
  }
  expect(
    Result.getOrThrow(
      decodeAccessWorkload(
        { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
        protectedReadOwner,
      ),
    ).reason,
  ).toBe('machine provisioning only');
});

it('requires an access carrier on every protected entrypoint and none on an unprotected one (O62)', () => {
  for (const owner of [actionOwner, readOwner, protectedActionOwner, protectedPageOwner]) {
    expect(isProtectedAccessEntrypoint(owner)).toBe(true);
    expect(missingAccessCarrierIssue({ entrypoint: owner })).toBe(
      `${owner.entrypointKey} is ${owner.authorization.kind}: a protected entrypoint must declare accessDeclaration, accessWorkload or accessActor (O62)`,
    );
  }
  expect(missingAccessCarrierIssue({ accessDeclaration: parentDeclaration(), entrypoint: readOwner })).toBeUndefined();
  expect(
    missingAccessCarrierIssue({
      accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
      entrypoint: actionOwner,
    }),
  ).toBeUndefined();
  for (const owner of [authenticatedOwner, publicOwner, backgroundOwner, capabilityOwner]) {
    expect(isProtectedAccessEntrypoint(owner)).toBe(false);
    expect(missingAccessCarrierIssue({ entrypoint: owner })).toBeUndefined();
    expect(accessCarrierIssue({ entrypoint: owner })).toBeUndefined();
  }
});

it('reports a carrier issue instead of throwing so schema filters can reuse it (O5, O62)', () => {
  expect(accessCarrierIssue({ entrypoint: actionOwner })).toContain(
    'must declare accessDeclaration, accessWorkload or accessActor',
  );
  expect(accessCarrierIssue({ accessDeclaration: parentDeclaration(), entrypoint: readOwner })).toBeUndefined();
  expect(
    accessCarrierIssue({
      accessDeclaration: { ...routine(), key: 'other-module.party.other' },
      entrypoint: actionOwner,
    }),
  ).toContain('must be party-registry.<resource>.<verb>');
  // O67-Q4 allows the dual Action carrier, so the exclusion now only guards a direct surface.
  expect(
    accessCarrierIssue({
      accessDeclaration: parentDeclaration(),
      accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
      entrypoint: readOwner,
    }),
  ).toContain('only on an Action');
  expect(
    accessCarrierIssue({
      accessDeclaration: routine(),
      accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
      entrypoint: actionOwner,
    }),
  ).toBeUndefined();
  expect(accessCarrierIssue({ accessFieldGroups: [sensitiveGroup()], entrypoint: readOwner })).toContain(
    'must declare accessDeclaration, accessWorkload or accessActor',
  );
});

it('gives an agent no policy at all on a workload Action or a missing carrier (O29, O59)', () => {
  expect(
    deriveCarrierAgentPolicy({
      accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
    }),
  ).toBe('never');
  expect(deriveCarrierAgentPolicy({})).toBe('never');
  // O67-Q4: the declaration half of a dual Action is the human and agent capability.
  expect(
    deriveCarrierAgentPolicy({
      accessDeclaration: { kind: 'action', risk: 'sensitive' },
      accessWorkload: { reason: 'machine provisioning only', workloads: ['party-registry.machine-provisioner'] },
    }),
  ).toBe('propose_only');
  expect(
    deriveCarrierAgentPolicy({
      accessDeclaration: { kind: 'action', risk: 'sensitive' },
    }),
  ).toBe('propose_only');
  expect(deriveCarrierAgentPolicy({ accessDeclaration: { kind: 'read', risk: 'routine' } })).toBe('run');
});

it('collects field groups as their own catalog entries tied to their parent declaration', () => {
  const descriptor = {
    accessDeclaration: parentDeclaration(),
    accessFieldGroups: [sensitiveGroup()],
    entrypoint: readOwner,
  };
  const catalog = Result.getOrThrow(collectAccessCatalog([{ descriptors: [descriptor], moduleId: 'party-registry' }]));
  expect(
    catalog.entries.map(({ accessDeclaration, parentKey: key }) => `${accessDeclaration.key}/${key ?? 'parent'}`),
  ).toEqual([`${parentKey}/parent`, 'party-registry.party.read-margins/party-registry.party.read']);
  expect(Object.isFrozen(catalog.entries)).toBe(true);
  expect(Object.isFrozen(catalog.entries[1])).toBe(true);

  expect(
    catalogError([
      {
        descriptors: [{ accessFieldGroups: [sensitiveGroup()], entrypoint: readOwner }],
        moduleId: 'party-registry',
      },
    ])?.code,
  ).toBe('access_catalog_declaration_invalid');
  expect(
    catalogError([
      { descriptors: [descriptor], moduleId: 'party-registry' },
      {
        descriptors: [
          {
            accessDeclaration: declarationFor('party-registry.party.read-margins', {
              kind: 'read',
              risk: 'sensitive',
            }),
            entrypoint: readOwner,
          },
        ],
        moduleId: 'party-registry',
      },
    ])?.code,
  ).toBe('access_catalog_duplicate_key');
});

/*
 * O88: the administration SURFACE. An admin page may declare that it admits a person who administers
 * access in at least one company. The marker is authored metadata like every other field, so an
 * illegal carrier must fail at definition time instead of becoming an unnoticed widening of authority.
 */
const adminPageOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'shell-super-app.page.access-people',
  moduleKey: 'shell-super-app',
  role: 'page',
});

/** A valid admin surface declaration for one module; the negative controls override one rule at a time. */
const adminSurface = (overrides: Partial<AccessDeclarationInput> = {}): AccessDeclarationInput => ({
  admitsAdminSurface: true,
  key: 'shell-super-app.access-admin.people',
  kind: 'admin',
  modes: ['run'],
  placement: { group: 'access', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
  ...overrides,
});

/** The exact authoring reason, so a negative control never passes for an unrelated cause. */
const surfaceRefusal = (input: AccessDeclarationInput, owner: AccessDeclarationOwner): string => {
  const result = decodeAccessDeclaration(input, owner);
  expect(Result.isFailure(result)).toBe(true);
  return Result.isFailure(result) ? result.failure.reason : '';
};

it('accepts the administration surface marker on an admin page and on no other carrier (O88)', () => {
  // The one legal carrier: an admin page, whose surface a company administrator may enter.
  expect(decode(adminSurface(), adminPageOwner).admitsAdminSurface).toBe(true);
  // The same page without the marker is a plain admin key, so nothing is ever inferred.
  const { admitsAdminSurface: _surface, ...withoutMarker } = adminSurface();
  expect(Object.hasOwn(decode(withoutMarker, adminPageOwner), 'admitsAdminSurface')).toBe(false);

  // Every operation and every non-admin declaration is an illegal carrier, with its own reason.
  const actionCarrier = { ...adminSurface({ key: 'party-registry.access-admin.surface' }) };
  expect(surfaceRefusal(actionCarrier, actionOwner)).toContain('only by a page carrier');
  expect(surfaceRefusal(actionCarrier, protectedActionOwner)).toContain('only by a page carrier');
  expect(surfaceRefusal({ ...parentDeclaration(), admitsAdminSurface: true }, protectedReadOwner)).toContain(
    'only by an admin declaration',
  );
  const readSurface = { ...parentDeclaration(), admitsAdminSurface: true, kind: 'admin', risk: 'sensitive' } as const;
  expect(surfaceRefusal(readSurface, protectedReadOwner)).toContain('only by a page carrier');
  expect(surfaceRefusal(readSurface, protectedContributionOwner)).toContain('only by a page carrier');
  expect(surfaceRefusal(readSurface, readOwner)).toContain('only by a page carrier');

  // The marker is exactly `true` or absent: no other value may stand in for it.
  for (const admitsAdminSurface of [false, 'true', 1, null]) {
    expect(Result.isFailure(decodeAccessDeclaration({ ...adminSurface(), admitsAdminSurface }, adminPageOwner))).toBe(
      true,
    );
  }
  expect(Result.isSuccess(decodeAccessDeclaration(adminSurface(), adminPageOwner))).toBe(true);
});

/** The Shell frame's own read, the one kind of carrier that may be baseline. */
const shellFrameOwner = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'core.shell.composition',
  moduleKey: 'core.shell',
  role: 'api',
});
const frameRead = (overrides: Partial<AccessDeclarationInput> = {}): AccessDeclarationInput => ({
  baseline: true,
  key: 'core.shell.composition.read',
  kind: 'read',
  modes: ['run'],
  placement: { group: 'shell', level: 'basic' },
  risk: 'routine',
  selectors: [],
  ...overrides,
});

it('lets only a routine, basic, unselected read of the Shell frame be baseline, so it grants no business data', () => {
  expect(decode(frameRead(), shellFrameOwner).baseline).toBe(true);
  const narrower = 'only a routine, basic read without record selectors may be baseline';
  expect(surfaceRefusal(frameRead({ placement: { group: 'shell', level: 'extended' } }), shellFrameOwner)).toContain(
    narrower,
  );
  expect(surfaceRefusal(frameRead({ risk: 'sensitive' }), shellFrameOwner)).toContain(narrower);
  expect(surfaceRefusal(frameRead({ selectors: ['assigned'] }), shellFrameOwner)).toContain(narrower);
  expect(
    surfaceRefusal(
      frameRead({ key: 'core.shell.composition.export', kind: 'export', risk: 'sensitive' }),
      shellFrameOwner,
    ),
  ).toContain(narrower);
  // Another module's read may never be baseline, however harmless it looks.
  expect(surfaceRefusal(frameRead({ key: 'party-registry.party.list' }), protectedReadOwner)).toContain(
    'only the Shell frame (core.shell) declares baseline access',
  );
  for (const baseline of [false, 'true', 1, null]) {
    expect(Result.isFailure(decodeAccessDeclaration({ ...frameRead(), baseline }, shellFrameOwner))).toBe(true);
  }
});
