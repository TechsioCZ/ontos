#!/usr/bin/env node
// Computed keys, default exports, overload signatures and curried async arrows.
export {};

const members = {
	async ["computed" + "Key"](): Promise<void> {},
	async [Symbol.asyncIterator](): Promise<void> {},
};

export default async function (): Promise<void> {}

export async function overloaded(value: string): Promise<void>;
export async function overloaded(value: number): Promise<void>;
export async function overloaded(value: unknown): Promise<void> {
	void value;
}

const curried = async () => async () => async (): Promise<number> => 1;

void members;
void curried;
