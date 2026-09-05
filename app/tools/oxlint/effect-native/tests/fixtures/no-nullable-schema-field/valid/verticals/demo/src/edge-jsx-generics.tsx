// JSX + a generic arrow + a template literal: parser edge cases with no Schema import at all.
const identity = <T,>(value: T): T => value;

export function Page() {
  return (
    <div className="x">
      {identity('a' as string)}
      <span>{`${1 < 2}`}</span>
    </div>
  );
}
