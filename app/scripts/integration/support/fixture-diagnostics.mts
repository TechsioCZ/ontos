import { stripVTControlCharacters } from 'node:util';

import { Effect, Schema } from 'effect';

const encodeDiagnosticJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json));
export const encodeFixtureOwnerDiagnostics = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ diagnostic: Schema.String, owner: Schema.String }))),
);

/** Redact credentials before retaining at most 60 lines and 4096 characters. */
export const fixtureDiagnosticTail = (value: string): string =>
  stripVTControlCharacters(value)
    .replaceAll(
      /\b[\w-]*(?:authorization|cookie|password|passwd|pwd|secret|token|credential|connection[_-]?string|database[_-]?(?:admin[_-]?)?url|api[_-]?key|preshared[_-]?key|private[_-]?key)[\w-]*\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/giu,
      '[redacted credential]',
    )
    .replaceAll(/\bBearer\s+[^\s"',;}\]]+/giu, 'Bearer [redacted]')
    .replaceAll(/\b(?:set-cookie|cookie)\b[^\r\n]*/giu, '[redacted cookie]')
    .replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)}\]]+/giu, '[redacted URL]')
    .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, '[redacted token]')
    .split(/\r?\n/u)
    .slice(-60)
    .join('\n')
    .slice(-4096);

export const collectFixtureDiagnostics = (diagnostics: ReadonlyMap<string, Effect.Effect<string>>) =>
  Effect.forEach(
    [...diagnostics],
    ([appId, diagnostic]) =>
      diagnostic.pipe(Effect.map((text) => ({ diagnostic: fixtureDiagnosticTail(text), owner: appId }))),
    { concurrency: 1 },
  );

export const describeFixtureDiagnostics = <Value, Failure, Requirements>(
  diagnostic: Effect.Effect<Value, Failure, Requirements>,
) =>
  diagnostic.pipe(
    Effect.flatMap(encodeDiagnosticJson),
    Effect.match({
      onFailure: () => 'Fixture diagnostics unavailable',
      onSuccess: fixtureDiagnosticTail,
    }),
  );

export const logFixtureDiagnostics = (diagnostics: ReadonlyMap<string, Effect.Effect<string>>) =>
  collectFixtureDiagnostics(diagnostics).pipe(
    Effect.flatMap((owners) =>
      Effect.forEach(owners, (owner) => Effect.logError(owner), { concurrency: 1, discard: true }),
    ),
  );
