export function classify(response: { readonly status: number }, record: () => void) {
  switch ((record(), response.status)) {
    case 400: return "bad";
    case 404: return "missing";
    default: return "other";
  }
}
