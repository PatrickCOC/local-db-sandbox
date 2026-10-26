import { typeormSemanticsSuite } from "./support/typeorm-semantics-suite.ts";

/*
 * What an application gets back for each kind of column, on the TypeORM
 * version this repository develops against.
 *
 * typeorm-semantics-0.3.17.test.ts runs the same suite against the version of
 * the application these differences were first seen in.
 */
await typeormSemanticsSuite("typeorm");
