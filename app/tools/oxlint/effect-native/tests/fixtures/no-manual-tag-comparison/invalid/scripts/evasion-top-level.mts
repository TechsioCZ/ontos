// expect-count: 4
interface Failure {
  readonly _tag: string;
}

declare const load: () => Promise<Failure>;

const failure = await load();

if (failure._tag === "ScaffoldTemplateMissingError") process.exitCode = 1;

export const isScaffold = (candidate: Failure): boolean => candidate._tag.startsWith("Scaffold");

export const hasTag = (value: object): boolean => `_tag` in value;

export const wroteBadly = (candidate: Failure): boolean => candidate?.["_tag"] === "ScaffoldWriteError";
