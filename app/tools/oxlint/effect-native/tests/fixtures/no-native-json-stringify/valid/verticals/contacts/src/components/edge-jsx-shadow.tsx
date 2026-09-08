// A TSX component whose serializer arrives as a prop, plus a shadowing local named `JSON`.
interface Props {
	readonly value: Record<string, unknown>;
	readonly JSON: { readonly stringify: (value: unknown) => string };
}

export function Serialized({ value, JSON }: Props) {
	return <pre>{JSON.stringify(value)}</pre>;
}
