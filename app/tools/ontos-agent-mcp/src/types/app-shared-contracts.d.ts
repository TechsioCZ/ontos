// sales-insights/shared/metrics.ts imports only the type of CalendarDateWireSchema from @app/shared-contracts,
// and only to name the CalendarDay type (a string on the wire). This ambient declaration lets this package
// typecheck that file without depending on the workspace package. Runtime never loads it (type-only import).
declare module '@app/shared-contracts' {
  export const CalendarDateWireSchema: { readonly Type: string; readonly Encoded: string };
}
