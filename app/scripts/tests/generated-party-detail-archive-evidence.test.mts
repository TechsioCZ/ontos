import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { hasCompleteGeneratedModuleRead } from '../generated-governed-http-boundary.mts';

// The Party Registry detail read may publish one extra history-only evidence array: the Party's archived
// display names. That evidence is not a fact assertion, so it is accepted only when the read's own contract
// declares it, the read factory binds it to an owner-local archive helper called with the read's own trusted
// `(transaction, scope.tenantId, partyId)` pair, that helper runs one tenant-scoped SELECT over the owner's
// real schema table, and its decoder publishes exactly the properties the owner's own carrier declares.
// These tests pin the real source and the tampering shapes that must stay rejected: a dropped or substituted
// tenant predicate, a foreign table or import, a shadowed helper, a decoder or result adapter over foreign
// data, a fake archive member, and an archive bound to a foreign transaction or tenant.
const root = path.resolve(import.meta.dirname, '../..');
const excluded = new Set(['.git', '.modern', '.output', 'coverage', 'dist', 'node_modules']);
const sources = new Map<string, string>();
const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excluded.has(entry.name)) {
      collect(file);
    } else if (entry.isFile() && /\.(?:ts|mts|json)$/u.test(file)) {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
};
collect('verticals');

const owner = 'verticals/party-registry';
const readFile = `${owner}/src/api/party-detail.read.ts`;
const serviceFile = `${owner}/src/services/party-detail-persistence.service.ts`;
const archiveProof = 'alias detail archive evidence';
const archiveMemberCall = 'findPartyHistoricalNameAssertions(transaction, scope.tenantId, partyId)';
const tenantPredicate =
  'and(eq(partyHistoricalNameAssertions.tenantId, tenantId), eq(partyHistoricalNameAssertions.partyId, partyId))';

const accepts = (changed: ReadonlyMap<string, string>, diagnostics?: string[]): boolean =>
  hasCompleteGeneratedModuleRead(changed, readFile, owner, 'party.registry', 'party-detail', diagnostics);

const changed = (file: string, before: string, after: string): ReadonlyMap<string, string> => {
  const source = sources.get(file);
  expect(source, file).toBeDefined();
  const mutated = (source ?? '').replace(before, after);
  expect(mutated, `${file}: ${before}`).not.toBe(source);
  expect(parseSync(file, mutated).errors).toEqual([]);
  return new Map([...sources, [file, mutated]]);
};

it('proves the real party-detail archive-evidence read', () => {
  const diagnostics: string[] = [];
  expect(accepts(sources, diagnostics), `${readFile}\n${diagnostics.join('\n')}`).toBe(true);
});

// `archiveProof` marks the tampering shapes the archive-evidence provenance proof itself must reject; the
// others still have to be rejected, but a foreign factory or module makes the load unreachable first.
for (const [name, file, before, after, archiveProofScope] of [
  // The archive member is only the read factory's own owner-local helper, called with its own trusted pair.
  [
    'fake archive helper member',
    readFile,
    archiveMemberCall,
    'foreignArchiveHelper(transaction, scope.tenantId, partyId)',
    false,
  ],
  [
    'foreign archive tenant',
    readFile,
    archiveMemberCall,
    'findPartyHistoricalNameAssertions(transaction, foreignTenant, partyId)',
    false,
  ],
  [
    'foreign archive transaction',
    readFile,
    archiveMemberCall,
    'findPartyHistoricalNameAssertions(foreignTransaction, scope.tenantId, partyId)',
    false,
  ],
  [
    'swapped archive arguments',
    readFile,
    archiveMemberCall,
    'findPartyHistoricalNameAssertions(transaction, partyId, scope.tenantId)',
    false,
  ],
  [
    'foreign archive module',
    readFile,
    "} from '../services/party-detail-persistence.service.ts';",
    "} from '../services/foreign-persistence.service.ts';",
    false,
  ],
  // The evidence stays history-only, declared as the owner's own carrier, and published when requested.
  [
    'unconditional archive read',
    readFile,
    'const historicalNameEvidence = includeFactHistory',
    'const historicalNameEvidence = true',
    false,
  ],
  [
    'replaced archive carrier element',
    readFile,
    'Option.none<readonly PartyHistoricalNameAssertion[]>()',
    'Option.none<readonly ForeignHistoricalNameAssertion[]>()',
    true,
  ],
  [
    'archive evidence dropped from the response type',
    readFile,
    "Omit<PartyDetailResponse, 'factHistory' | 'historicalNameEvidence'>",
    "Omit<PartyDetailResponse, 'factHistory'>",
    false,
  ],
  [
    'archive evidence never published',
    readFile,
    '{ ...withFactHistory, historicalNameEvidence: historicalNameEvidence.value }',
    '{ ...withFactHistory }',
    false,
  ],
  [
    'weakened contract return type',
    readFile,
    'Effect.Effect<readonly PartyHistoricalNameAssertion[], PartyPersistenceUnavailableError, never>',
    'Effect.Effect<readonly ForeignHistoricalNameAssertion[], PartyPersistenceUnavailableError, never>',
    true,
  ],
  // The helper's own SELECT keeps its explicit tenant predicate and the owner's real schema table.
  [
    'substituted tenant predicate',
    serviceFile,
    'eq(partyHistoricalNameAssertions.tenantId, tenantId)',
    'eq(partyHistoricalNameAssertions.tenantId, foreignTenant)',
    true,
  ],
  [
    'dropped tenant predicate',
    serviceFile,
    tenantPredicate,
    'eq(partyHistoricalNameAssertions.partyId, partyId)',
    true,
  ],
  ['foreign archive table', serviceFile, '.from(partyHistoricalNameAssertions)', '.from(foreignAssertions)', true],
  [
    'foreign table module',
    serviceFile,
    "import { partyFactAssertions, partyHistoricalNameAssertions } from '../db/schema.ts';",
    "import { partyFactAssertions, partyHistoricalNameAssertions } from '../db/foreign-schema.ts';",
    false,
  ],
  // The decode stays over the preserved original rows and publishes the owner's own carrier properties.
  [
    'decoder over foreign rows',
    serviceFile,
    'decodePartyHistoricalNameAssertions(tenantId, partyId, rows)',
    'decodePartyHistoricalNameAssertions(tenantId, partyId, foreignRows)',
    true,
  ],
  [
    'decoder result adapter over foreign data',
    serviceFile,
    'value: original.normalized_value',
    'value: foreignValue',
    true,
  ],
  [
    'decoder maps a foreign carrier',
    serviceFile,
    '): PartyHistoricalNameAssertion => ({',
    '): ForeignHistoricalNameAssertion => ({',
    true,
  ],
  [
    'foreign decoded schema',
    serviceFile,
    'Schema.decodeUnknownEffect(ArchivedNameAssertionSchema)',
    'Schema.decodeUnknownEffect(ForeignArchivedNameSchema)',
    true,
  ],
  // The owner helper must stay a native Effect.fn from the owner's own service module.
  [
    'non-native archive helper',
    serviceFile,
    'export const findPartyHistoricalNameAssertions = Effect.fn(',
    'export const findPartyHistoricalNameAssertions = foreignEffectFn(',
    false,
  ],
] as const) {
  it(`rejects the party-detail archive evidence with a ${name}`, () => {
    const diagnostics: string[] = [];
    expect(accepts(changed(file, before, after), diagnostics), `${name}\n${diagnostics.join('\n')}`).toBe(false);
    expect(
      diagnostics.some((diagnostic) => diagnostic.startsWith(archiveProof)),
      `${name}\n${diagnostics.join('\n')}`,
    ).toBe(archiveProofScope);
  });
}

for (const [name, file, tail, archiveProofScope] of [
  ['reassigned archive helper', readFile, '\nfindPartyHistoricalNameAssertions = fake;', false],
  ['shadowed archive helper', readFile, '\nfunction shadow(findPartyHistoricalNameAssertions: unknown) {}', false],
  ['shadowed archive table', serviceFile, '\nconst partyHistoricalNameAssertions = foreignTable;', true],
] as const) {
  it(`rejects the party-detail archive evidence with a ${name}`, () => {
    const source = sources.get(file) ?? '';
    const mutated = `${source}\n${tail}`;
    expect(mutated, `${file}: ${tail}`).not.toBe(source);
    expect(parseSync(file, mutated).errors).toEqual([]);
    const diagnostics: string[] = [];
    expect(accepts(new Map([...sources, [file, mutated]]), diagnostics), `${name}\n${diagnostics.join('\n')}`).toBe(
      false,
    );
    expect(
      diagnostics.some((diagnostic) => diagnostic.startsWith(archiveProof)),
      `${name}\n${diagnostics.join('\n')}`,
    ).toBe(archiveProofScope);
  });
}
