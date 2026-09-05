// expect-count: 2
/** `Date.prototype.<method>.call` is the same hand serialisation. */
export function encode(value: Date): readonly [string, number] {
	return [Date.prototype.toISOString.call(value), Date.prototype.getTime.call(value)];
}
