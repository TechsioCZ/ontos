// expect-count: 2
/** Emitted text living inside a JSX expression container. */
export const Preview = ({ id }: { id: string }): JSX.Element => (
	<pre data-id={id}>{`const flags = JSON.parse(process.env.ONTOS_FEATURE_FLAGS ?? '{}');`}</pre>
);
