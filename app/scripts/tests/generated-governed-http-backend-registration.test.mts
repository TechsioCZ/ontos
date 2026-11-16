import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';
import {
  hasValidGovernedHttpCompositionRoot,
  hasValidGovernedHttpCompositionRootStaged,
} from '../generated-governed-http-boundary.mts';

/*
 * An owner composition root may bind that owner's own backend-only registration: exactly
 * `<owner>BackendRegistration`, imported from the owner's own `../vertical.runtime-declaration.ts`. Pricing's real
 * root is rebound to it here; every other owner's name, every other file and a foreign registration renamed to the
 * owner's name must be refused.
 */
const root = path.resolve(import.meta.dirname, '../..');
const owner = 'verticals/pricing';
const shared = readFileSync(path.join(root, owner, 'shared/api.ts'), 'utf-8');
const handler = readFileSync(path.join(root, owner, 'api/index.ts'), 'utf-8');
const context = { ownerPath: owner, sources: new Map<string, string>() };
const ownerBackend = 'pricingBackendRegistration';
const registrationImport = "import { pricingRegistration } from '../vertical.registration.ts';";
/** Pricing's real root with its registration replaced by this import, bound under `local`. */
const rebound = (importSpecifier: string, modulePath: string, local: string) =>
  handler
    .replace(registrationImport, `import { ${importSpecifier} } from '${modulePath}';`)
    .replaceAll('ultramodernDeliveryUnit, pricingRegistration)', `ultramodernDeliveryUnit, ${local})`);
const accepts = (source: string) => ({
  plain: hasValidGovernedHttpCompositionRoot(shared, source, context),
  staged: hasValidGovernedHttpCompositionRootStaged(shared, source, ownerBackend),
});
const runtimeDeclaration = '../vertical.runtime-declaration.ts';

it('binds the owner its own backend-only registration, also under a local alias', () => {
  expect(handler).toContain(registrationImport);
  expect(accepts(handler)).toEqual({ plain: true, staged: true });
  expect(accepts(rebound(ownerBackend, runtimeDeclaration, ownerBackend))).toEqual({ plain: true, staged: true });
  expect(accepts(rebound(`${ownerBackend} as pricingRegistration`, runtimeDeclaration, 'pricingRegistration'))).toEqual(
    { plain: true, staged: true },
  );
});

it('needs the owner context to bind a backend-only registration', () => {
  const source = rebound(ownerBackend, runtimeDeclaration, ownerBackend);
  expect(hasValidGovernedHttpCompositionRoot(shared, source)).toBe(false);
  expect(hasValidGovernedHttpCompositionRootStaged(shared, source)).toBe(false);
});

it.each([
  ["another owner's registration name", 'crmBackendRegistration', runtimeDeclaration, 'crmBackendRegistration'],
  [
    "another owner's registration renamed to the owner's name",
    `crmBackendRegistration as ${ownerBackend}`,
    runtimeDeclaration,
    ownerBackend,
  ],
  [
    "another owner's registration renamed to a registration-shaped alias",
    'crmBackendRegistration as pricingRegistration',
    runtimeDeclaration,
    'pricingRegistration',
  ],
  ["the owner's name from the owner's registration module", ownerBackend, '../vertical.registration.ts', ownerBackend],
  [
    "the owner's name from a sibling owner's runtime declaration",
    ownerBackend,
    '../../crm/vertical.runtime-declaration.ts',
    ownerBackend,
  ],
  ["the owner's name from a same-directory path", ownerBackend, './vertical.runtime-declaration.ts', ownerBackend],
  ["the owner's name from a bare specifier", ownerBackend, 'vertical.runtime-declaration.ts', ownerBackend],
  ["the owner's name from a package", ownerBackend, '@app/pricing/vertical.runtime-declaration', ownerBackend],
  [
    "the owner's name from a nested runtime declaration",
    ownerBackend,
    '../shared/vertical.runtime-declaration.ts',
    ownerBackend,
  ],
  [
    'a look-alike name with a suffix',
    'pricingBackendRegistrationV2',
    runtimeDeclaration,
    'pricingBackendRegistrationV2',
  ],
] as const)('rejects a foreign backend-only registration: %s', (_name, specifier, modulePath, local) => {
  const source = rebound(specifier, modulePath, local);
  expect(source).not.toBe(handler);
  expect(accepts(source)).toEqual({ plain: false, staged: false });
});
