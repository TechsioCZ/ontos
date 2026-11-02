import { Buffer } from 'node:buffer';
import { Schema } from 'effect';

const SqlStateSchema = Schema.Literals([
  '08001',
  '08006',
  '23502',
  '23503',
  '23505',
  '23514',
  '25006',
  '25P02',
  '28000',
  '28P01',
  '3D000',
  '3F000',
  '40001',
  '40P01',
  '42501',
  '42601',
  '42703',
  '42710',
  '42883',
  '42P01',
  '42P07',
  '53300',
  '53400',
  '54000',
  '55000',
  '55P03',
  '57014',
  '57P01',
  '58030',
  'P7602',
  'P7603',
  'XX000',
]);
const CategorySchema = Schema.Literals([
  'SQL_METADATA',
  'MODULE_CONFIG_LOADER',
  'CONNECTION',
  'AUTHENTICATION',
  'PERMISSION_OWNERSHIP',
  'UNKNOWN',
  'AMBIGUOUS',
]);
const MissingOrAmbiguousSchema = Schema.Literals(['UNKNOWN', 'AMBIGUOUS']);
const ByteCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10_000_000));

/** Safe test-only receipt. Every unstructured match is a hint, never proof of the failing migration. */
export const BulkOriginalChildDiagnosticReceiptSchema = Schema.Struct({
  commandStage: Schema.Literals(['PRICING_MIGRATE', 'PRICING_VERIFY']),
  diagnosticCategory: CategorySchema,
  exitCode: Schema.Int,
  failureClass: Schema.Literal('PRICING_SETUP_CHILD_FAILURE'),
  leasedCandidate: Schema.Literal('20261019165859_bulk_original_owner_intent'),
  metadataInterpretation: Schema.Literal('UNSTRUCTURED_HINT_ONLY'),
  observedMigration: Schema.Literal('UNKNOWN'),
  position: Schema.Union([PositionSchema, MissingOrAmbiguousSchema]),
  sqlState: Schema.Union([SqlStateSchema, MissingOrAmbiguousSchema]),
  stderrBytes: ByteCountSchema,
  stderrPresent: Schema.Boolean,
  stdoutBytes: ByteCountSchema,
  stdoutPresent: Schema.Boolean,
});
type Receipt = typeof BulkOriginalChildDiagnosticReceiptSchema.Type;
type SqlState = typeof SqlStateSchema.Type;
type Category = typeof CategorySchema.Type;
const isSqlState = Schema.is(SqlStateSchema);
const isPosition = Schema.is(PositionSchema);
const sqlCategories = new Map<SqlState, Category>([
  ['08001', 'CONNECTION'],
  ['08006', 'CONNECTION'],
  ['28000', 'AUTHENTICATION'],
  ['28P01', 'AUTHENTICATION'],
  ['42501', 'PERMISSION_OWNERSHIP'],
]);
// Only standalone structured fields qualify; inline query/message substrings do not.
const sqlStateField =
  /^[\t ]*(?:code|sqlState|sqlstate|'(?:code|sqlState|sqlstate)'|"(?:code|sqlState|sqlstate)")[\t ]*:[\t ]*(?:'(?<singleCode>[A-Z0-9]{5})'|"(?<doubleCode>[A-Z0-9]{5})")[\t ]*,?[\t ]*$/u;
const positionField =
  /^[\t ]*(?:position|'position'|"position")[\t ]*:[\t ]*(?:'(?<singlePosition>[1-9]\d{0,7})'|"(?<doublePosition>[1-9]\d{0,7})"|(?<barePosition>[1-9]\d{0,7}))[\t ]*,?[\t ]*$/u;

const structuredMetadata = (text: string) => {
  const codes = new Set<SqlState>();
  const positions = new Set<number>();
  for (const line of text.split(/\r?\n/u)) {
    const codeMatch = sqlStateField.exec(line);
    const code = codeMatch?.groups?.['singleCode'] ?? codeMatch?.groups?.['doubleCode'];
    if (isSqlState(code)) {
      codes.add(code);
    }
    const positionMatch = positionField.exec(line);
    const positionText =
      positionMatch?.groups?.['singlePosition'] ??
      positionMatch?.groups?.['doublePosition'] ??
      positionMatch?.groups?.['barePosition'];
    if (positionText !== undefined) {
      const position = Number(positionText);
      if (isPosition(position)) {
        positions.add(position);
      }
    }
  }
  return { codes, positions };
};

const categoryFor = (text: string, codes: ReadonlySet<SqlState>, positions: ReadonlySet<number>): Category => {
  const categories = new Set<Category>();
  for (const code of codes) {
    categories.add(sqlCategories.get(code) ?? 'SQL_METADATA');
  }
  if (codes.size === 0 && positions.size > 0) {
    categories.add('SQL_METADATA');
  }
  if (
    /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_INVALID_MODULE_SPECIFIER)\b|(?:Cannot find (?:module|package)|Cannot find configuration file)|(?:^|\n)[\t ]*Error:[\t ]+No config path provided/u.test(
      text,
    )
  ) {
    categories.add('MODULE_CONFIG_LOADER');
  }
  if (/\bECONNREFUSED\b|connection refused/iu.test(text)) {
    categories.add('CONNECTION');
  }
  if (/password authentication failed|authentication failed for user/iu.test(text)) {
    categories.add('AUTHENTICATION');
  }
  if (/permission denied for|must be owner of/iu.test(text)) {
    categories.add('PERMISSION_OWNERSHIP');
  }
  if (categories.size > 1) {
    return 'AMBIGUOUS';
  }
  return categories.values().next().value ?? 'UNKNOWN';
};

/** Both raw streams stay internal: only fixed literals, counts and validated metadata leave this function. */
export const classifyBulkOriginalChildDiagnostics = (input: {
  readonly command: 'migrate' | 'verify';
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}): Receipt => {
  const text = `${input.stdout}\n${input.stderr}`;
  const { codes, positions } = structuredMetadata(text);
  const stdoutBytes = Buffer.byteLength(input.stdout, 'utf-8');
  const stderrBytes = Buffer.byteLength(input.stderr, 'utf-8');
  const stages = { migrate: 'PRICING_MIGRATE', verify: 'PRICING_VERIFY' } as const;
  return {
    commandStage: stages[input.command],
    diagnosticCategory: categoryFor(text, codes, positions),
    exitCode: input.exitCode,
    failureClass: 'PRICING_SETUP_CHILD_FAILURE',
    leasedCandidate: '20261019165859_bulk_original_owner_intent',
    metadataInterpretation: 'UNSTRUCTURED_HINT_ONLY',
    observedMigration: 'UNKNOWN',
    position: positions.size > 1 ? 'AMBIGUOUS' : (positions.values().next().value ?? 'UNKNOWN'),
    sqlState: codes.size > 1 ? 'AMBIGUOUS' : (codes.values().next().value ?? 'UNKNOWN'),
    stderrBytes,
    stderrPresent: stderrBytes > 0,
    stdoutBytes,
    stdoutPresent: stdoutBytes > 0,
  };
};
