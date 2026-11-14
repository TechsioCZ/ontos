import { Effect } from 'effect';

/** Redact credentials before retaining at most 60 lines and 4096 characters. */
export const fixtureDiagnosticTail = (value: string): string =>
  value
    .replaceAll(/\u001b\[[0-9;]*m/gu, '')
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
  Effect.forEach([...diagnostics], ([appId, diagnostic]) =>
    diagnostic.pipe(Effect.map((text) => ({ appId, diagnostic: fixtureDiagnosticTail(text) }))),
  );

export const describeFixtureDiagnostics = <Value, Failure, Requirements>(
  diagnostic: Effect.Effect<Value, Failure, Requirements>,
) =>
  diagnostic.pipe(
    Effect.match({
      onFailure: () => 'Fixture diagnostics unavailable',
      onSuccess: (value) => fixtureDiagnosticTail(JSON.stringify(value) ?? ''),
    }),
  );

export const logFixtureDiagnostics = (diagnostics: ReadonlyMap<string, Effect.Effect<string>>) =>
  collectFixtureDiagnostics(diagnostics).pipe(
    Effect.flatMap((owners) => Effect.forEach(owners, (owner) => Effect.logError(owner), { discard: true })),
  );
