// Drizzle's exactOptionalPropertyTypes-strict shape rejects `undefined`
// values; this helper strips them so a typed input with optional
// fields can pass through .insert().values() / .set() unmodified.
export function compact<T extends Record<string, unknown>>(o: T): {
  [K in keyof T]: Exclude<T[K], undefined>;
} {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}
