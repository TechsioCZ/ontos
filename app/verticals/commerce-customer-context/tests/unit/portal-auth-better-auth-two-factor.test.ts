import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  OTP_CODE_PATTERN,
  OTP_STORAGE_IDENTIFIER_PREFIX,
  TWO_FACTOR_COOKIE_NAME,
  VERIFIED_BETTER_AUTH_VERSION,
  otpStorageIdentifierOf,
  storedOneTimeCodeOf,
} from '../../api/portal-auth/provider/better-auth-two-factor.ts';

/**
 * [E-08] Auth couples to Better Auth's two-factor internals in exactly one module (`better-auth-two-factor.ts`): the cookie that
 * names a pending challenge, the prefix a code is stored under and the `<code>:<count>` shape of the stored value. Better Auth
 * exports none of them, so this canary reads the INSTALLED plugin and fails on a Better Auth upgrade (its version, or any of the
 * four facts), instead of the one-time-code flow breaking silently. A failure here means: re-verify the facts in the adapter
 * against the new plugin source, update them and `VERIFIED_BETTER_AUTH_VERSION` together.
 */

/** This vertical's own dependency, as pnpm links it: the package the deployment actually runs. */
const betterAuthRoot = path.join(import.meta.dirname, '..', '..', 'node_modules', 'better-auth');
const pluginSource = (file: string) =>
  readFileSync(path.join(betterAuthRoot, 'dist', 'plugins', 'two-factor', file), 'utf-8');
const PackageManifestSchema = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const installedVersion = (): string =>
  Schema.decodeUnknownSync(PackageManifestSchema)(readFileSync(path.join(betterAuthRoot, 'package.json'), 'utf-8'))
    .version;

describe('The Better Auth two-factor coupling (E-08 canary)', () => {
  it('the installed Better Auth is the release the adapter was verified against', () => {
    expect(installedVersion()).toBe(VERIFIED_BETTER_AUTH_VERSION);
  });

  it('the pending-challenge cookie is still named by the plugin as the adapter says', () => {
    expect(pluginSource('constant.mjs')).toContain(`const TWO_FACTOR_COOKIE_NAME = "${TWO_FACTOR_COOKIE_NAME}";`);
  });

  it('a one-time code is still stored under the identifier prefix the adapter says, and read back as `<code>:<count>`', () => {
    const otp = pluginSource(path.join('otp', 'index.mjs'));
    expect(otp).toContain(`identifier: \`${OTP_STORAGE_IDENTIFIER_PREFIX}\${key}\``);
    expect(otp).toContain('consumed.value?.split(":")');
    expect(otp).toContain('generateRandomString(opts.digits, "0-9")');
  });

  it('the adapter reads exactly the shapes it names', () => {
    expect(otpStorageIdentifierOf('user-1!session-1')).toBe('2fa-otp-user-1!session-1');
    expect(storedOneTimeCodeOf('482913:2')).toStrictEqual({ code: '482913', failedAttempts: 2 });
    expect(storedOneTimeCodeOf('482913')).toStrictEqual({ code: '482913', failedAttempts: 0 });
    expect(OTP_CODE_PATTERN.test('482913')).toBe(true);
    expect(OTP_CODE_PATTERN.test('48291a')).toBe(false);
    expect(OTP_CODE_PATTERN.test('1234567890123')).toBe(false);
  });
});
