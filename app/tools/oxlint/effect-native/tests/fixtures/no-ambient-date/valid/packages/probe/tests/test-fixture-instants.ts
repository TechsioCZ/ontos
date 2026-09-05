/** D tier: frozen fixture instants, fixture formatting and fixture durations stay legal in tests. */
const FIXTURE_ISO = "2026-01-01T00:00:00Z";
const LEASE_MILLISECONDS = 5 * 60 * 1000;

export function fixture(): { readonly at: Date; readonly iso: string; readonly leaseMs: number } {
	const at = new Date(FIXTURE_ISO);
	return { at, iso: at.toISOString(), leaseMs: LEASE_MILLISECONDS };
}
