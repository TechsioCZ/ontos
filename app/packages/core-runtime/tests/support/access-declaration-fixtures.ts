import { Schema } from 'effect';

import { AccessDeclarationError } from '../../src/authorization/access-declaration-error.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';

/**
 * O62 makes an access carrier mandatory on every protected entrypoint. Runtime tests exercise
 * mechanics rather than authorization metadata, so they declare one routine carrier per fixture and
 * never assert on it.
 */
export const fixtureActionAccess = (moduleKey: string): AccessDeclarationInput => ({
  key: `${moduleKey}.fixture.action`,
  kind: 'action',
  modes: ['run'],
  placement: { group: 'fixtures', level: 'basic' },
  risk: 'routine',
  selectors: [],
});

export const fixtureReadAccess = (moduleKey: string): AccessDeclarationInput => ({
  key: `${moduleKey}.fixture.read`,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'fixtures', level: 'basic' },
  risk: 'routine',
  selectors: [],
});

/**
 * The actionable reason of the tagged carrier error a definition-time call throws. A tagged error
 * carries no `message`, so a message assertion reads `reason` instead.
 */
export const accessCarrierErrorReason = (run: () => object): string => {
  try {
    run();
    return 'no error';
  } catch (error) {
    return Schema.is(AccessDeclarationError)(error) ? error.reason : 'unexpected error';
  }
};
