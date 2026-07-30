/*
 * Errors the CLIENT caused, as opposed to faults of ours.
 *
 * Everything the engine and auth threw for bad input was a plain Error, and
 * dispatch only knew how to map HttpError - so "pick an endpoint and model",
 * "that username already exists" and "session not found" all came back as 500.
 * A 500 says "the server is broken, retrying might help", which sent the reader
 * looking for a bug in the app instead of a typo in their request, and made a
 * misbehaving client indistinguishable from a real fault in the logs.
 *
 * This lives apart from router.ts so engine.ts and auth.ts can report the class
 * of a failure without either of them depending on the HTTP layer.
 */
export class InputError extends Error {
  status: number;
  /** 400 unless the failure is more specific: 404 missing, 409 wrong state. */
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Require a non-empty string from request input.
 *
 * Optional chaining does not cover this: `text?.trim()` guards null and
 * undefined but a JSON number reaches `.trim` and throws TypeError, which
 * escaped as a 500. Coerce nothing silently - a number where a message belongs
 * is a mistake worth reporting.
 */
export function requireText(value: unknown, label: string, max = 200_000): string {
  if (typeof value !== 'string') throw new InputError(`${label} must be text`);
  const trimmed = value.trim();
  if (!trimmed) throw new InputError(`${label} is empty`);
  if (trimmed.length > max) throw new InputError(`${label} is too long (limit ${max} characters)`);
  return trimmed;
}
