// Pathological input: JSX-only module with no imports at all.
export function EmptyPanel() {
  return (
    <>
      <span title={`nothing`}>no client here</span>
    </>
  );
}
