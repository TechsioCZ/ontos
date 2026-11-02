function nestedCredentialQuery(value: string, depth: number): boolean {
  try {
    return hasCredentialQuery(new URL(value, "https://return.invalid"), depth);
  } catch {
    return true;
  }
}

/** Do not pass accidental credential queries into Next's router, error pages or request diagnostics. */
export function hasCredentialQuery(url: URL, depth = 0): boolean {
  return [...url.searchParams].some(
    ([key, value]) =>
      /password|passwd|pwd|secret|credential|api[-_]?key|^(?:access_token|refresh_token|id_token|authorization|confirmation)$/i.test(
        key,
      ) ||
      (key.toLowerCase() === "returnto" && (depth >= 4 || nestedCredentialQuery(value, depth + 1))),
  );
}
