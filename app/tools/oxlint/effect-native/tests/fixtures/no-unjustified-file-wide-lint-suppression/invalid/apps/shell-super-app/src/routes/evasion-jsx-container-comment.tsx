// expect-count: 1
// A directive smuggled into a JSX expression container is a real suppression (verified: it silences
// `typescript(no-explicit-any)` for the rest of the file).
export const View = (props: { readonly value: unknown }): JSX.Element => (
	<div>
		{/* oxlint-disable typescript/no-explicit-any -- Framework props arrive untyped at this seam. */}
		<span>{String(props.value)}</span>
	</div>
);
