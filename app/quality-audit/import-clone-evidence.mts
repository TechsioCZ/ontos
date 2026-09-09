import { Effect, FileSystem, Path, Schema } from 'effect';
import { parseSync } from 'oxc-parser';

const CloneLocation = Schema.Struct({
  end: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  name: Schema.String,
  start: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
});
const CloneReport = Schema.fromJsonString(
  Schema.Struct({
    duplicates: Schema.Array(
      Schema.Struct({
        firstFile: CloneLocation,
        secondFile: CloneLocation,
      }),
    ),
  }),
);

/** Static binding declarations do not duplicate implementation behavior. */
export const containsOnlyImportBindings = (source: string): boolean => {
  const parsed = parseSync('clone.ts', source);
  return (
    parsed.errors.length === 0 &&
    parsed.program.body.length > 1 &&
    parsed.program.body.every((statement) => statement.type === 'ImportDeclaration' && statement.specifiers.length > 0)
  );
};

export const importCloneEvidence = Effect.fn('QualityAudit.importCloneEvidence')(function* collectImportCloneEvidence(
  root: string,
  source: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const report = yield* Schema.decodeUnknownEffect(CloneReport)(source);
  const provesBindings = Effect.fn('QualityAudit.provesImportBindings')(function* proveImportBindings(
    location: typeof CloneLocation.Type,
  ) {
    const relative = path.relative(root, location.name);
    if (
      location.end === undefined ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      location.end < location.start
    ) {
      return false;
    }
    const text = yield* fs.readFileString(path.join(root, relative));
    const lines = text.split('\n');
    return (
      location.end <= lines.length &&
      containsOnlyImportBindings(lines.slice(location.start - 1, location.end).join('\n'))
    );
  });
  const evidence = [];
  for (const pair of report.duplicates) {
    if ((yield* provesBindings(pair.firstFile)) && (yield* provesBindings(pair.secondFile))) {
      evidence.push(pair);
    }
  }
  return evidence;
});
