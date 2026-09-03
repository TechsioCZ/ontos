import assert from 'node:assert/strict';
import test from 'node:test';
import {
  partyRegistryCorsAllowedOrigins,
  resolvePartyRegistryShellOrigin,
} from '../../api/read-server-support.ts';

test('Party CORS accepts only the configured nonlocal Shell origin without a localhost fallback', () => {
  const shellOrigin = 'https://operations.example.test';
  assert.deepEqual(partyRegistryCorsAllowedOrigins(resolvePartyRegistryShellOrigin(shellOrigin)), [
    shellOrigin,
  ]);
});
