import { describe, expect, it } from 'effect-rstest';

import { hasGeneratedActionKeyIdentity } from '../generated-governed-http-boundary.mts';

const expectedKey = 'commerce.catalog.rename-attribute-definition';

describe('generated Action key identity', () => {
  it('accepts the generated inline identity', () => {
    expect(hasGeneratedActionKeyIdentity(`defineAction({ actionKey: '${expectedKey}' });`, expectedKey)).toBe(true);
  });

  it('accepts a matching immutable local alias in explicit and shorthand properties', () => {
    expect(
      hasGeneratedActionKeyIdentity(
        `const ACTION_KEY = '${expectedKey}' as const; defineAction({ actionKey: ACTION_KEY });`,
        expectedKey,
      ),
    ).toBe(true);
    expect(
      hasGeneratedActionKeyIdentity(
        `const actionKey = '${expectedKey}' as const; defineAction({ actionKey, });`,
        expectedKey,
      ),
    ).toBe(true);
  });

  it('rejects a mismatched or dynamic alias', () => {
    expect(
      hasGeneratedActionKeyIdentity(
        `const ACTION_KEY = 'commerce.catalog.other-action' as const; defineAction({ actionKey: ACTION_KEY });`,
        expectedKey,
      ),
    ).toBe(false);
    expect(
      hasGeneratedActionKeyIdentity(
        `const ACTION_KEY = getActionKey(); defineAction({ actionKey: ACTION_KEY });`,
        expectedKey,
      ),
    ).toBe(false);
    expect(
      hasGeneratedActionKeyIdentity(`let actionKey = '${expectedKey}'; defineAction({ actionKey });`, expectedKey),
    ).toBe(false);
  });
});
