// expect-count: 2
/** TSX: generic arrow + `satisfies` + `as` around the ambient clock. */
const identity = <T,>(value: T): T => value;

export function Stamp() {
	const at = identity(new Date()) satisfies Date;
	return <time dateTime={(at as Date).toISOString()}>now</time>;
}
