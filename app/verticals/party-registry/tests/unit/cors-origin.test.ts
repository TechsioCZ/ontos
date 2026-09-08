import { expect, it } from 'effect-rstest';
import {
  partyRegistryCorsAllowedOrigins,
  resolvePartyRegistryShellOrigin,
} from '../../api/read-server-support.ts';

it('Party CORS accepts only the configured nonlocal Shell origin without a localhost fallback', () => {
  const shellOrigin = 'https://operations.example.test';
  expect(partyRegistryCorsAllowedOrigins(resolvePartyRegistryShellOrigin(shellOrigin))).toEqual([
    shellOrigin,
  ]);
});
