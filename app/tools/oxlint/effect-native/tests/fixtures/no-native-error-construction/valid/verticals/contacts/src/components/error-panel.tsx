// Type positions only: annotations, an interface heritage clause and a `typeof` type query never
// construct or inspect a value, so they are not this rule's business.
import type { ReactNode } from "react";

export interface HttpProblem extends Error {
	readonly status: number;
}

export type NativeErrorConstructor = typeof Error;

export type Stack = Error["stack"];

export function ErrorPanel({ problem }: { readonly problem: HttpProblem }): ReactNode {
	return <p role="alert">{problem.status}</p>;
}

export function describe(fallback: Error): string {
	return fallback.message;
}
