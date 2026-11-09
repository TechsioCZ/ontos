import { Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { packagedStartupFailureReason } from '../support/server-owner-relay-native-fixture.ts';

it('reports the native exit and known startup failure without exposing child output', () => {
  const reason = packagedStartupFailureReason(1, [
    Redacted.make('Error [ERR_UNKNOWN_FILE_EXTENSION]: private/path/component.tsx'),
    Redacted.make('Bearer test-private-credential'),
  ]);
  expect(reason).toBe(
    'Packaged application exited before readiness (exit=1; diagnostic codes=ERR_UNKNOWN_FILE_EXTENSION)',
  );
});

it('deduplicates fixed error categories while withholding configuration values', () => {
  const reason = packagedStartupFailureReason(2, [
    Redacted.make('ConfigError: postgresql://private-user:private-password@private-host/database'),
    Redacted.make('ConfigError: private-signing-key'),
    Redacted.make('SchemaError: private-account@example.test'),
  ]);
  expect(reason).toBe(
    'Packaged application exited before readiness (exit=2; diagnostic codes=ConfigError, SchemaError)',
  );
});

it('still refuses a clean exit before readiness when no known error is present', () => {
  expect(packagedStartupFailureReason(0, [Redacted.make('private arbitrary child output')])).toBe(
    'Packaged application exited before readiness (exit=0; diagnostic codes=not reported)',
  );
});
