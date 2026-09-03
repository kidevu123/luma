// SIMPLIFY-B — raw zod messages ("Number must be greater than 0") next to a
// button, with no field named, blocked real closeouts (6337-46). Name the
// field. First issue only — one clear error beats a wall of them.

import type { ZodError } from "zod";

export function formatZodError(
  error: ZodError,
  labels: Record<string, string> = {},
): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid input.";
  const key = issue.path[0] != null ? String(issue.path[0]) : "";
  if (!key) return issue.message;
  const label = labels[key] ?? key;
  return `${label}: ${issue.message}`;
}
