export type Redactor = ((text: string) => string) & { secrets?: readonly string[] };
export function redactor(values: readonly string[]): Redactor {
  const secrets = [
    ...new Set(values.filter(Boolean).flatMap((s) => [s, encodeURIComponent(s)])),
  ].sort((a, b) => b.length - a.length);
  return Object.assign(
    (text: string) => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text),
    { secrets },
  );
}
export function composeRedactors(...values: Redactor[]): Redactor {
  return Object.assign((text: string) => values.reduce((out, redact) => redact(out), text), {
    ...(values.every((v) => v.secrets !== undefined)
      ? { secrets: values.flatMap((v) => [...v.secrets!]) }
      : {}),
  });
}
// Hold suffixes that may be the beginning of a secret in a later OS pipe chunk.
// Arbitrary custom redactors without metadata cannot safely stream; only flush at EOF.
export function outputRedactor(redact?: Redactor) {
  let pending = '';
  const secrets = redact?.secrets;
  const window = Math.max(0, ...(secrets ?? []).map((s) => s.length));
  return (text: string, final = false) => {
    pending += text;
    let cut = final
      ? pending.length
      : redact && !secrets
        ? 0
        : Math.max(0, pending.length - window);
    for (let prior = -1; prior !== cut;) {
      prior = cut;
      for (const secret of secrets ?? []) {
        const start = pending.lastIndexOf(secret, cut - 1);
        if (start >= 0 && start < cut && start + secret.length > cut) cut = start;
      }
    }
    const ready = pending.slice(0, cut);
    pending = pending.slice(cut);
    // The fallback is deliberately bounded; truncated runtime output is not complete usage.
    if (pending.length > 2_000_000) pending = pending.slice(-2_000_000);
    return redact ? redact(ready) : ready;
  };
}
