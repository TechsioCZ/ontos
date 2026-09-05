// expect-count: 2
/** Browser render path building and serialising an ambient instant. */
export function Stamp() {
	const now = new Date();
	return <time dateTime={now.toISOString()}>rendered</time>;
}
