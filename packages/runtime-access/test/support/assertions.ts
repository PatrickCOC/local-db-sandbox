import assert from "node:assert/strict";
import { AccessError } from "../../src/index.ts";
import type { AccessErrorCode } from "../../src/index.ts";

/** Rejects with an `AccessError` of that code, whose message matches. Resolves with the error. */
export async function refused(promise: Promise<unknown>, code: AccessErrorCode, message: RegExp = /./): Promise<AccessError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    assert.ok(error instanceof AccessError, `not an AccessError: ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.match(error.message, message);
    return true;
  });
  return caught as AccessError;
}
