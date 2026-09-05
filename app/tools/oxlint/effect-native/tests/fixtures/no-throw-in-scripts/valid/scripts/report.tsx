/** A TSX script with no throw statements: native array ops and JSON.stringify are D tier. */
import { Effect, Schema } from "effect";

class LabelMissing extends Schema.TaggedError<LabelMissing>()("LabelMissing", { index: Schema.Number }) {}

export const renderRow = (label: string | undefined, index: number) =>
	label === undefined
		? Effect.fail(new LabelMissing({ index }))
		: Effect.succeed(<span data-label={label}>{label}</span>);

export const renderAll = (labels: readonly string[]) =>
	Effect.forEach(labels, (label, index) => renderRow(label, index), { concurrency: "unbounded" });

export const serialise = (labels: readonly string[]): string =>
	JSON.stringify(labels.map((label) => label.trim()).filter((label) => label.length > 0));
