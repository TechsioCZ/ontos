/** Test-only TSX fixture: a fixed instant rendered into markup is not a wall-clock read. */
export function FixtureStamp() {
	const at = new Date("2026-01-01T00:00:00Z");
	return <time dateTime={at.toISOString()}>fixture</time>;
}
