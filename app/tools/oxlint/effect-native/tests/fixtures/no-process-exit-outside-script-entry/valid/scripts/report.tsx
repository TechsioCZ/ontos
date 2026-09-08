import { Effect, Exit } from "effect";

const Row = ({ label }: { label: string }) => <li>{label}</li>;

export const Report = ({ labels }: { labels: readonly string[] }) => (
	<ul>
		{labels.map((label) => (
			<Row key={label} label={label} />
		))}
	</ul>
);

const outcome = await Effect.runPromiseExit(Effect.succeed(0));
process.exitCode = Exit.match(outcome, { onFailure: () => 1, onSuccess: () => 0 });
