// JSX attributes and children are values, not declared channels.
interface RowProps {
	readonly id: string;
}

export const Row = ({ id }: RowProps) => <span correlationId={id} data-trace-id={id} />;

export const Spread = (props: RowProps) => <Row {...props} correlationId={props.id} />;

export const Text = ({ id }: RowProps) => <p>{`correlationId: ${id}`}</p>;
