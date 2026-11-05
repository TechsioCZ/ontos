import { readFileSync, readdirSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, test } from 'effect-rstest';
import { Predicate, Schema } from 'effect';

/*
 * The access-administration copy contract (authorization v2, #1343).
 *
 * Product wording lives here, never in the engine: Core emits stable reason codes and the UI renders
 * `shell.accessAdmin.reason.<code>`. This suite is the guard between the two, so a renamed code, a
 * missing Czech diacritic or a namespace drift fails a test instead of silently rendering a key.
 */

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

/** One flattened locale entry: the dotted key and the label rendered for it. */
interface LocaleEntry {
  readonly key: string;
  readonly value: string;
}

/** The package root: rstest runs through `pnpm --filter`, which sets the package directory. */
const packageRoot = process.cwd();

const readJson = (relativePath: string): JsonValue =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    readFileSync(nodePath.resolve(packageRoot, relativePath), 'utf-8'),
  );

const isJsonObject = Schema.is(Schema.JsonObject);

const flatten = (node: JsonValue, prefix: string): readonly LocaleEntry[] => {
  if (Predicate.isString(node)) {
    return [{ key: prefix, value: node }];
  }
  if (!isJsonObject(node)) {
    return [];
  }
  return Object.entries(node).flatMap(([key, child]) => flatten(child, prefix.length > 0 ? `${prefix}.${key}` : key));
};

const adminEntries = (document: JsonValue): readonly LocaleEntry[] => {
  if (!isJsonObject(document)) {
    return [];
  }
  const { shell } = document;
  if (!isJsonObject(shell)) {
    return [];
  }
  const admin = shell['accessAdmin'];
  return admin === undefined ? [] : flatten(admin, '');
};

const keysOf = (entries: readonly LocaleEntry[]): readonly string[] => entries.map((entry) => entry.key).toSorted();

const labelOf = (entries: readonly LocaleEntry[], key: string): string | undefined =>
  entries.find((entry) => entry.key === key)?.value;

const csAdmin = adminEntries(readJson('locales/cs/shell.json'));
const enAdmin = adminEntries(readJson('locales/en/shell.json'));
const csDocument = readJson('locales/cs/shell.json');
const enDocument = readJson('locales/en/shell.json');
const csTranslation = readJson('locales/cs/translation.json');
const enTranslation = readJson('locales/en/translation.json');

/** Reads one quoted literal vocabulary from the Core source that the engine actually sends. */
const coreLiteralCodes = (relativePath: string, marker: string): readonly string[] => {
  const source = readFileSync(nodePath.resolve(packageRoot, relativePath), 'utf-8');
  const start = source.indexOf(marker);
  const end = start === -1 ? -1 : source.indexOf(']', start);
  // Negative control: a moved or renamed declaration must fail loudly, not read zero codes.
  expect({ found: start !== -1 && end > start }).toEqual({ found: true });
  return [...source.slice(start, end).matchAll(/'[a-z][a-z0-9_.]*'/gu)].map((match) => match[0].replaceAll("'", ''));
};

/** The authoritative decision reason vocabulary. */
const decisionReasonCodes = (): readonly string[] =>
  coreLiteralCodes('../../packages/core-runtime/src/access/decision/contract.ts', 'DECISION_REASON_CODES = [');

/** The authoritative undo skip reasons behind "Vrácení přeskakuje … {{reason}}". */
const undoSkipReasons = (): readonly string[] =>
  coreLiteralCodes(
    '../../packages/core-runtime/src/access/changes/undo.ts',
    'UndoSkipReasonSchema = Schema.Literals([',
  );

/**
 * i18next plural suffixes. Czech has one/few/many/other, English only one/other, so a translated
 * count label is one key here and four keys there — the two locales must still agree on the base key.
 */
const PLURAL_SUFFIX = /_(?<form>one|few|many|other)$/u;
const PLURAL_FORMS = {
  cs: ['one', 'few', 'many', 'other'],
  en: ['one', 'other'],
} as const;
const pluralSuffixOf = (key: string): string | undefined => PLURAL_SUFFIX.exec(key)?.groups?.['form'];
const baseKeyOf = (key: string): string => key.replace(PLURAL_SUFFIX, '');

const placeholders = (text: string): readonly string[] =>
  [...text.matchAll(/\{\{\p{L}+\}\}/gu)].map((match) => match[0].replaceAll(/[{}]/gu, '')).toSorted();

/**
 * Czech words that are only correct with diacritics. Every entry is a form that never exists in
 * correct Czech, so the detector cannot flag legitimate copy such as "schvaluje" or "platnost".
 */
const CZECH_WITHOUT_DIACRITICS =
  /(?<!\p{L})(?:pristup\p{L}*|opravnen\p{L}*|uzivatel\p{L}*|schvaleni\p{L}*|schvaleny|schvalena|schvalene|zmena|zmeny|zmenou|zmenit|zmenil|zmenila|zmeneny|zmenena|zmenene|sprava|spravy|spravou|spravce|spravcu|pozadav\p{L}*|zamit\p{L}*|prohlednout|prohlednuti|vyprsel\p{L}*|castk\p{L}*|lhut\p{L}*|posledni|vlastnik\p{L}*|clenstv\p{L}*|prirazen\p{L}*|odebrani|odebranim|vraceni|vracenim|zadny|zadna|zadne|zadnou|zadnych|vsechn\p{L}*|muzet\p{L}*|nemuzet\p{L}*|jeste|dalsi|zrusit|ulozit|ulozen\p{L}*|zavazn\p{L}*|zadost|zadosti|nacten\p{L}*)(?!\p{L})/giu;

const diacriticsMissing = (text: string): readonly string[] =>
  [...text.matchAll(CZECH_WITHOUT_DIACRITICS)].map((match) => match[0]);

test('locates the locale namespaces on disk', () => {
  // Negative control for the loader: a wrong working directory would make every namespace
  // assertion below vacuously pass.
  expect(csAdmin.length).toBeGreaterThan(100);
  expect(enAdmin.length).toBeGreaterThan(100);
  expect(flatten(csTranslation, '').length).toBeGreaterThan(10);
  expect(flatten(enTranslation, '').length).toBeGreaterThan(10);
});

/** The logical key set: the plural forms of one label collapse into its base key. */
const baseKeysOf = (entries: readonly LocaleEntry[]): readonly string[] => [...new Set(keysOf(entries).map(baseKeyOf))];

test('aligns every Czech and English access-administration key', () => {
  expect(baseKeysOf(enAdmin)).toEqual(baseKeysOf(csAdmin));
});

test('pluralises every label that interpolates a count', () => {
  const pluralBases = [
    ...new Set(
      keysOf(csAdmin)
        .filter((key) => pluralSuffixOf(key) !== undefined)
        .map(baseKeyOf),
    ),
  ];
  // Negative control: the locale really does carry count labels.
  expect(pluralBases.length).toBeGreaterThan(2);
  for (const base of pluralBases) {
    for (const [locale, entries, forms] of [
      ['cs', csAdmin, PLURAL_FORMS.cs],
      ['en', enAdmin, PLURAL_FORMS.en],
    ] as const) {
      const present = keysOf(entries)
        .filter((key) => pluralSuffixOf(key) !== undefined && baseKeyOf(key) === base)
        .map((key) => key.slice(base.length + 1))
        .toSorted();
      expect({ base, locale, present }).toEqual({ base, locale, present: [...forms].toSorted() });
      for (const form of forms) {
        // Every plural form must keep the count placeholder, otherwise i18next renders a literal.
        expect({ base, form, locale, placeholders: placeholders(labelOf(entries, `${base}_${form}`) ?? '') }).toEqual({
          base,
          form,
          locale,
          placeholders: ['count'],
        });
      }
    }
    // A plural label must not survive as an un-suffixed base key, which i18n:boundaries rejects.
    expect({ base, suffixed: labelOf(csAdmin, base) === undefined }).toEqual({ base, suffixed: true });
    expect({ base, suffixed: labelOf(enAdmin, base) === undefined }).toEqual({ base, suffixed: true });
  }
});

test('never ships an empty or padded access-administration label', () => {
  for (const entry of [...csAdmin, ...enAdmin]) {
    expect({
      empty: entry.value.trim().length === 0,
      key: entry.key,
      padded: entry.value !== entry.value.trim(),
    }).toEqual({
      empty: false,
      key: entry.key,
      padded: false,
    });
  }
});

/**
 * O88 codes that Core publishes to the engine before `DECISION_REASON_CODES` lists them. Copy ships
 * as soon as the code is decided, so the guard compares against Core plus this list; once Core
 * carries a code the union is unchanged and the entry can simply be deleted.
 */
const REASON_CODES_AHEAD_OF_CONTRACT = ['structural.access_admin_any'];

test('maps every decision reason code to a Czech and English label', () => {
  const codes = decisionReasonCodes();
  // Negative control: an empty read would make the coverage assertion vacuous.
  expect(codes.length).toBeGreaterThan(20);
  const expected = [...new Set([...codes, ...REASON_CODES_AHEAD_OF_CONTRACT])].toSorted();
  const reasonKeys = keysOf(csAdmin)
    .filter((key) => key.startsWith('reason.'))
    .map((key) => key.slice('reason.'.length));
  // Exact both ways: a code without copy fails, and so does stale copy for a retired code.
  expect(reasonKeys).toEqual(expected);
  const missing = expected.filter(
    (code) => labelOf(csAdmin, `reason.${code}`) === undefined || labelOf(enAdmin, `reason.${code}`) === undefined,
  );
  expect(missing).toEqual([]);
});

test('names the O81 and O88 structural admission rationale', () => {
  // O81/O88 admit the owner, a company access administrator, a live delegation, or an administrator
  // of at least one company (company chosen inside the admin UI). Each basis must be explained with
  // its own sentence, never a generic allow, and never the raw code.
  expect({
    access_admin: labelOf(csAdmin, 'reason.structural.access_admin'),
    access_admin_any: labelOf(csAdmin, 'reason.structural.access_admin_any'),
    delegation: labelOf(csAdmin, 'reason.structural.delegation'),
    owner: labelOf(csAdmin, 'reason.structural.owner'),
  }).toEqual({
    access_admin: 'Spravujete přístup v této firmě',
    access_admin_any: 'Spravujete přístup alespoň v jedné firmě',
    delegation: 'Máte delegovanou správu přístupu',
    owner: 'Jste vlastník této organizace',
  });
  expect([
    labelOf(enAdmin, 'reason.structural.owner'),
    labelOf(enAdmin, 'reason.structural.access_admin'),
    labelOf(enAdmin, 'reason.structural.delegation'),
    labelOf(enAdmin, 'reason.structural.access_admin_any'),
  ]).toEqual([
    'You are the owner of this organization',
    'You administer access in this company',
    'You hold a delegated access administration',
    'You administer access in at least one company',
  ]);
});
test('covers every Core risk, mode, kind, change state and proposal state', () => {
  const model = '../../packages/core-runtime/src/access/model.ts';
  const vocabularies = [
    { marker: 'AccessRiskSchema = Schema.Literals([', prefix: 'risk.' },
    { marker: 'AccessModeSchema = Schema.Literals([', prefix: 'mode.' },
    { marker: 'AccessKindSchema = Schema.Literals([', prefix: 'kind.' },
    { marker: 'AccessChangeKindSchema = Schema.Literals([', prefix: 'changes.kind.' },
    { marker: 'AccessChangeItemStatusSchema = Schema.Literals([', prefix: 'changes.status.' },
    { marker: 'ProposalStatusSchema = Schema.Literals([', prefix: 'approvals.status.' },
  ];
  for (const { marker, prefix } of vocabularies) {
    const codes = coreLiteralCodes(model, marker);
    // Negative control: an unread vocabulary must not pass as "no missing labels".
    expect({ found: codes.length > 0, prefix }).toEqual({ found: true, prefix });
    const missing = codes.filter(
      (code) =>
        labelOf(csAdmin, `${prefix}${code}`) === undefined || labelOf(enAdmin, `${prefix}${code}`) === undefined,
    );
    expect({ missing, prefix }).toEqual({ missing: [], prefix });
  }
});

test('maps every undo skip reason to a Czech and English label', () => {
  const reasons = undoSkipReasons();
  // Negative control: the vocabulary must be found, not read as empty.
  expect(reasons.length).toBeGreaterThan(4);
  const expected = reasons.map((reason) => `changes.skipReason.${reason}`).toSorted();
  expect(keysOf(csAdmin).filter((key) => key.startsWith('changes.skipReason.'))).toEqual(expected);
  expect(keysOf(enAdmin).filter((key) => key.startsWith('changes.skipReason.'))).toEqual(expected);
  // The UI renders a named reason, never the Core code.
  for (const reason of reasons) {
    expect(labelOf(csAdmin, `changes.skipReason.${reason}`)).not.toBe(reason);
  }
});

test('keeps the reason wording product-owned, not the raw code', () => {
  for (const entry of csAdmin) {
    if (entry.key.startsWith('reason.')) {
      expect(entry.value).not.toBe(entry.key.slice('reason.'.length));
    }
  }
  expect(labelOf(csAdmin, 'reason.deny.insufficient_grant')).toBe('Na tuto akci nemáte oprávnění.');
  expect(labelOf(enAdmin, 'reason.deny.insufficient_grant')).toBe('You do not have permission for this action.');
});

test('uses the agreed Czech terminology and action wording', () => {
  expect({
    approvals: labelOf(csAdmin, 'navigation.approvals'),
    changes: labelOf(csAdmin, 'navigation.changes'),
    execute: labelOf(csAdmin, 'approvals.actions.execute'),
    fullAccess: labelOf(csAdmin, 'role.fullAccess'),
    people: labelOf(csAdmin, 'navigation.people'),
    roles: labelOf(csAdmin, 'navigation.roles'),
    title: labelOf(csAdmin, 'navigation.label'),
    why: labelOf(csAdmin, 'navigation.why'),
  }).toEqual({
    approvals: 'Ke schválení',
    changes: 'Novinky v oprávněních',
    execute: 'Schválit a provést mými právy',
    fullAccess: 'Plný přístup',
    people: 'Lidé',
    roles: 'Role',
    title: 'Správa oprávnění',
    why: 'Proč?',
  });
  expect(labelOf(enAdmin, 'role.fullAccess')).toBe('Full access');
  expect(labelOf(enAdmin, 'approvals.actions.execute')).toBe('Approve and execute with my access');
});

test('provides route metadata copy for every administration route', () => {
  // Each UI lane declares a private `defineRouteMeta` title/description; the description must not
  // fall back to a missing key.
  for (const section of ['role', 'people', 'changes', 'approvals', 'why', 'agents']) {
    expect({ czech: labelOf(csAdmin, `${section}.seo.description`), key: `${section}.seo.description` }).toEqual({
      czech: expect.any(String),
      key: `${section}.seo.description`,
    });
    expect(labelOf(enAdmin, `${section}.seo.description`)).toEqual(expect.any(String));
    expect(labelOf(csAdmin, `${section}.seo.title`)).toEqual(expect.any(String));
    expect(labelOf(enAdmin, `${section}.seo.title`)).toEqual(expect.any(String));
  }
});

test('keeps allowed, denied, needs-approval and unavailable visibly distinct', () => {
  const czech = [
    labelOf(csAdmin, 'outcome.allowed'),
    labelOf(csAdmin, 'outcome.denied'),
    labelOf(csAdmin, 'outcome.needsApproval'),
    labelOf(csAdmin, 'outcome.unavailable'),
  ];
  expect(czech).toEqual(['Povoleno', 'Zamítnuto', 'Čeká na schválení', 'Dočasně nedostupné']);
  // Denial is not unavailability, and neither may collapse into the other.
  expect(new Set(czech).size).toBe(czech.length);
  expect(czech[1]).not.toBe(czech[3]);
});

test('keeps the same interpolation placeholders in both locales', () => {
  const withPlaceholders = csAdmin.filter(
    (entry) => entry.value.includes('{{') && pluralSuffixOf(entry.key) === undefined,
  );
  // Negative control: the placeholder contract must be exercised, not silently skipped.
  expect(withPlaceholders.length).toBeGreaterThan(5);
  for (const entry of withPlaceholders) {
    expect({ key: entry.key, placeholders: placeholders(entry.value) }).toEqual({
      key: entry.key,
      placeholders: placeholders(labelOf(enAdmin, entry.key) ?? ''),
    });
  }
});

test('writes every Czech label with correct diacritics', () => {
  // Negative controls: the detector must fire on stripped Czech, and never on correct Czech.
  expect(diacriticsMissing('Pristup zamitnut, zmena ulozena.')).toEqual(['Pristup', 'zamitnut', 'zmena', 'ulozena']);
  expect(diacriticsMissing('Přístup zamítnut, změna uložena.')).toEqual([]);
  expect(diacriticsMissing('Schvaluje a potvrzuje platnost.')).toEqual([]);
  const broken = csAdmin
    .map((entry) => ({ key: entry.key, missing: diacriticsMissing(entry.value) }))
    .filter(({ missing }) => missing.length > 0);
  expect(broken).toEqual([]);
});

const csEntriesAreIdenticalTo = (entry: LocaleEntry, sharedByDesign: ReadonlySet<string>): boolean =>
  !sharedByDesign.has(entry.key) && entry.value === labelOf(enAdmin, entry.key);

test('never leaves English copy in a Czech label', () => {
  // Loanwords and product words that are legitimately identical in both locales.
  const sharedByDesign = new Set([
    'common.tenantContext',
    'kind.export',
    'people.role',
    // Format string only: capability/mode/kind/risk arrive as already-localized tokens.
    'role.dangerousEffectDescription',
    'why.sideAgent',
  ]);
  const same = csAdmin.filter((entry) => csEntriesAreIdenticalTo(entry, sharedByDesign)).map((entry) => entry.key);
  expect(same).toEqual([]);
});

const ADMIN_KEY_PREFIX = 'shell.accessAdmin.';

/** Every `shell.accessAdmin.*` reference the UI source actually uses. */
const referencedKeys = (): readonly string[] => {
  const files = readdirSync(nodePath.resolve(packageRoot, 'src'), { recursive: true }).filter(
    (file): file is string => Predicate.isString(file) && /\.[jt]sx?$/u.test(file),
  );
  return [
    ...new Set(
      files.flatMap((file) =>
        [
          ...readFileSync(nodePath.resolve(packageRoot, 'src', file), 'utf-8').matchAll(
            /shell\.accessAdmin\.[\p{L}\p{N}_.]*/gu,
          ),
        ]
          .map((match) => match[0])
          .filter((reference) => reference.length > ADMIN_KEY_PREFIX.length),
      ),
    ),
  ].toSorted();
};

test('resolves every access-administration key the UI references', () => {
  const references = referencedKeys();
  // Negative control: the UI must reference the namespace, otherwise this guard proves nothing.
  expect(references.length).toBeGreaterThan(50);
  const missing = references.filter((reference) => {
    const relative = reference.slice(ADMIN_KEY_PREFIX.length).replace(/\.$/u, '');
    // A section is referenced either as a label or as a key prefix (`${prefix}.title`,
    // `changes.status.${state}`); both must exist, a misspelling must not.
    const resolves = (entries: readonly LocaleEntry[]): boolean =>
      labelOf(entries, relative) !== undefined ||
      entries.some((entry) => entry.key.startsWith(`${relative}.`)) ||
      // A count label is referenced by its plural base; i18next picks the form from `count`.
      (labelOf(entries, `${relative}_one`) !== undefined && labelOf(entries, `${relative}_other`) !== undefined);
    return !resolves(csAdmin) || !resolves(enAdmin);
  });
  expect(missing).toEqual([]);
});

test('does not repeat the access-administration copy in the legacy translation namespace', () => {
  // shell.json and translation.json overlap today; a second copy of these keys would be shadowed
  // depending on the load order (the documented duplicate-namespace risk).
  for (const document of [csTranslation, enTranslation]) {
    expect(keysOf(flatten(document, '')).filter((key) => key.includes('accessAdmin'))).toEqual([]);
  }
});

test('keeps keys shared by shell.json and translation.json identical in both locales', () => {
  const documents = [
    { legacy: csTranslation, locale: 'cs', shell: csDocument },
    { legacy: enTranslation, locale: 'en', shell: enDocument },
  ];
  for (const { legacy, locale, shell } of documents) {
    const shellEntries = flatten(shell, '');
    const legacyEntries = flatten(legacy, '');
    const divergent = shellEntries
      .filter((entry) => legacyEntries.some((legacyEntry) => legacyEntry.key === entry.key))
      .filter((entry) => labelOf(legacyEntries, entry.key) !== entry.value)
      .map((entry) => `${locale}:${entry.key}`);
    expect(divergent).toEqual([]);
  }
});
