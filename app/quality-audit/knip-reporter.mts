import { Result, Schema } from 'effect';
import type { ReporterOptions } from 'knip';

// Knip's stock JSON reporter omits coverage. This second NDJSON record preserves
// the analyzer's own counters without deriving success from its exit status.
export default function reportCoverage({
  configurationHints,
  counters,
  includedWorkspaceDirs,
}: ReporterOptions): void {
  const source = Result.getOrThrow(
    Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))({
      configurationHints,
      coverage: counters,
      findingCounts: Object.fromEntries(
        Object.entries(counters).filter(
          ([category]) => category !== 'processed' && category !== 'total'
        )
      ),
      workspaces: includedWorkspaceDirs,
    })
  );
  process.stdout.write(`${source}\n`);
}
