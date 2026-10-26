import { typeormValuesSuite } from "./support/typeorm-values-suite.ts";

/*
 * How values are converted between JavaScript and the runtime, on the TypeORM
 * version this repository develops against.
 *
 * typeorm-values-0.3.17.test.ts runs the same suite against the version of
 * the application the regression was seen in.
 */
await typeormValuesSuite("typeorm");
