import assert from "node:assert/strict";
import { it } from "node:test";
import { typeormSemanticsSuite } from "./support/typeorm-semantics-suite.ts";

/*
 * The same suite against the real TypeORM 0.3.17 package (installed under the
 * name `typeorm-0.3.17`, for development only), so that every value goes
 * through that version's own persistence and hydration code.
 */
const version = await typeormSemanticsSuite("typeorm-0.3.17");

it("ran against TypeORM 0.3.17 itself", () => {
  assert.equal(version, "0.3.17");
});
