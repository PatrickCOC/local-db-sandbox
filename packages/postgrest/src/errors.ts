/*
 * Errors of the PostgREST endpoint, in the shape PostgREST answers them:
 * `{ code, details, hint, message }`. supabase-js hands that object to the
 * application as `error`.
 *
 * Two kinds of codes are used:
 *
 * - PostgREST's and PostgreSQL's own (`PGRST116`, `42703`, `23505`, ...) for
 *   what PostgREST would refuse as well, with its status. An application's
 *   handling of these errors can be exercised against the sandbox.
 * - `SANDBOX_POSTGREST_UNSUPPORTED` (status 501) for a request PostgREST
 *   would accept but the sandbox does not implement. It is never answered
 *   with something close: the message names what is not supported.
 */

export const UNSUPPORTED = "SANDBOX_POSTGREST_UNSUPPORTED";

export class PostgrestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(status: number, code: string, message: string, details: string | null = null, hint: string | null = null) {
    super(message);
    this.name = "PostgrestError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }

  get body(): { code: string; details: string | null; hint: string | null; message: string } {
    return { code: this.code, details: this.details, hint: this.hint, message: this.message };
  }
}

/** A request PostgREST would serve, but this sandbox does not. */
export function unsupported(what: string, hint: string | null = null): PostgrestError {
  return new PostgrestError(
    501,
    UNSUPPORTED,
    `${what} is not supported by the local sandbox's PostgREST endpoint.`,
    "The sandbox implements a stated subset of PostgREST; see docs/COMPATIBILITY.md, \"PostgREST endpoint\".",
    hint,
  );
}

/** PostgREST's answer to a query string it cannot parse. */
export function parseFailure(what: string, details: string): PostgrestError {
  return new PostgrestError(400, "PGRST100", `"failed to parse ${what}"`, details);
}
