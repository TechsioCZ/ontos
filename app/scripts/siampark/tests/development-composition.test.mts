import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  decodeDevelopmentArtifactText,
  DevelopmentCompositionError,
  validateDevelopmentArtifactUrl,
  validateDevelopmentDatabase,
} from '../development-composition.mts';

const urls = {
  DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin-secret@127.0.0.1:5432/siampark_demo',
  DATABASE_URL: 'postgresql://ontos_runtime:runtime-secret@127.0.0.1:5432/siampark_demo',
};

it.effect('accepts only distinct native identities on the isolated loopback demo database', () =>
  Effect.gen(function* acceptsDemo() {
    const pair = yield* validateDevelopmentDatabase('development', urls);
    expect(pair.admin.database).toBe('siampark_demo');
    expect(pair.runtime.database).toBe('siampark_demo');
    expect(pair.runtime.user).not.toBe(pair.admin.user);
  }),
);

it.effect('rejects production, the original database, remote hosts and mismatched endpoints without secrets', () =>
  Effect.gen(function* rejectsUnsafeTargets() {
    for (const [environment, input] of [
      ['production', urls],
      ['development', { ...urls, DATABASE_ADMIN_URL: urls.DATABASE_ADMIN_URL.replace('siampark_demo', 'ontos') }],
      ['development', { ...urls, DATABASE_URL: urls.DATABASE_URL.replace('127.0.0.1', 'example.com') }],
      ['development', { ...urls, DATABASE_URL: urls.DATABASE_URL.replace('5432', '5433') }],
      ['development', { ...urls, DATABASE_URL: urls.DATABASE_ADMIN_URL }],
      ['development', { ...urls, DATABASE_ADMIN_URL: 'not-a-url-admin-secret' }],
    ] as const) {
      const failure = yield* validateDevelopmentDatabase(environment, input).pipe(Effect.flip);
      expect(Schema.is(DevelopmentCompositionError)(failure)).toBe(true);
      expect(failure.reason).not.toContain('admin-secret');
      expect(failure.reason).not.toContain('runtime-secret');
    }
  }),
);

it.effect('accepts loopback HTTP artifacts and refuses remote or credential-bearing artifact URLs', () =>
  Effect.gen(function* restrictsArtifacts() {
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      yield* validateDevelopmentArtifactUrl(new URL(`http://${hostname}:4111/mf-manifest.json`));
    }
    for (const url of [
      'https://127.0.0.1:4111/mf-manifest.json',
      'http://example.com:4111/mf-manifest.json',
      'http://user:secret@127.0.0.1:4111/mf-manifest.json',
      'http://127.0.0.1:4111/mf-manifest.json?token=secret',
      'http://127.0.0.1:4111/mf-manifest.json#fragment',
    ]) {
      const failure = yield* validateDevelopmentArtifactUrl(new URL(url)).pipe(Effect.flip);
      expect(Schema.is(DevelopmentCompositionError)(failure)).toBe(true);
      expect(failure.reason).not.toContain('secret');
    }
  }),
);

it.effect('invalid UTF-8 is an expected tagged failure instead of a runtime defect', () =>
  Effect.gen(function* rejectsBrokenArtifactBytes() {
    const url = 'http://127.0.0.1:4111/.well-known/ontos-module-manifest.json';
    expect(yield* decodeDevelopmentArtifactText({ bytes: new TextEncoder().encode('{}'), url })).toBe('{}');
    const failure = yield* decodeDevelopmentArtifactText({ bytes: new Uint8Array([0xff]), url }).pipe(Effect.flip);
    expect(Schema.is(DevelopmentCompositionError)(failure)).toBe(true);
  }),
);
