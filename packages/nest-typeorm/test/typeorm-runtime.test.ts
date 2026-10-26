import { typeormRuntimeSuite } from "./support/typeorm-runtime-suite.ts";

/*
 * The TypeORM version this repository develops against. Since 0.3.28,
 * TypeORM's better-sqlite3 driver constructs its connection with
 * `new driver(database, options)`.
 *
 * typeorm-0.3.17.test.ts runs the same suite against a version that calls
 * `driver(database, options)` instead.
 */
await typeormRuntimeSuite("typeorm");
