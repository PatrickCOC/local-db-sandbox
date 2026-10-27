# Architecture

## Principle

The core domain must stay portable. npm is a delivery mechanism, not an architectural dependency.

The package has three runtime dependencies, each loaded on first use by the one file that may import it (checked by `packages/cli/test/boundaries.test.ts`): `libpg-query`, PostgreSQL's parser (`packages/import-postgres/src/parser.ts`, D-034); `postgres`, the client that `init-pg` reads a server's catalog with (`packages/import-postgres/src/pg-client.ts`, D-049); and `@dagrejs/dagre`, the layout of Studio's ER diagram (`packages/studio/src/diagram.ts`, D-053). Their licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Layers

### Core

Responsibilities:
- database state model;
- CRUD operations;
- normalized queries;
- validation of core operations;
- operation events;
- row counts;
- timing hooks.

The core must not know about HTTP, CLI parsing, VS Code, or file paths.

### Storage Adapter

Initial implementation: JSON file storage.

Suggested contract:

```ts
export interface StorageAdapter {
  load(): Promise<DatabaseState>;
  save(state: DatabaseState): Promise<void>;
}
```

Future implementations may include memory or SQLite storage without changing the core API.

A JSON database has two formats behind the same interface (`DatabaseStorage`): a single file, written as a whole, and a directory with one file per table. In a directory, a file that is part of the database is never modified. A save writes new files for the tables whose rows differ, named after the save's generation, and then replaces the manifest that names every table's file; that one rename is the save. Readers need no lock, and get one generation. See D-025.

How a database is laid out has a format version, stored in the database and counted per kind of storage (single file: 1; directory: 4, earlier 2 and 3). It is not the package version. One function (`assessFormat`) decides from it what a build does with a database: the current format is read and written, an earlier one that has a migration is read and never written, a later one is refused unless it says that this build's readers can read it. Nothing upgrades a database as a side effect of opening or saving it.

A migration is a step from one format to the next, kept in a registry (`FORMAT_MIGRATIONS`). It only says what the database consists of in the target format. The engine takes the save lock, writes the new files beside the old ones, reads the result back and compares it with the source, and publishes it the way a save is published, by replacing the manifest. `inspectDatabase` reports a database's format from the manifest alone, without loading tables and without writing. See `docs/FORMAT.md` and D-028.

### Server Adapter

Responsibilities:
- start/stop HTTP server;
- map REST requests to core commands;
- convert core results to HTTP responses;
- apply configured fake latency/errors/status overrides;
- emit request-level timing events.

Server logic should not own persistence rules.

### CLI Adapter

Responsibilities:
- parse command-line options;
- construct storage/server/core instances;
- display human-readable startup and request logs;
- handle process shutdown.

### Relational Runtime (experimental)

A second execution path, used by ORM integrations. The JSON file is a portable fixture and snapshot; execution happens in a disposable embedded SQLite database.

```text
sandbox.db.json -> load -> SQLite (in memory) <- SQL <- ORM (its own SQLite dialect)
                <- save at commit -
```

```ts
export interface RelationalRuntime {
  readonly schema: readonly TableSchema[];
  execute(sql: string, parameters?: SqlValue[], options?: ExecuteOptions): ExecuteResult; // rows, affectedRows, lastInsertId
  prepare(sql: string, options?: ExecuteOptions): PreparedStatement;
  run(query: Query, options?: ExecuteOptions): ExecuteResult; // shared Query IR, compiled to SQL
  begin(): void;
  commit(): void;
  rollback(): void;
  subscribe(listener: SqlEventListener): () => void;
  snapshot(): DatabaseState;
  close(): void;
}
```

Responsibilities:
- create tables from a `TableSchema[]`, with their keys, unique constraints, indexes, enumerated values, and computed defaults (D-033), and insert the fixture's rows;
- execute SQL and transactions on the engine, without emulating either. The engine is given a few functions of other databases as functions of its own (`compatibility-functions.ts`: `TO_CHAR` for dates); the SQL that calls them is not read or rewritten;
- emit one structured `SqlEvent` per executed statement;
- with `json` persistence, save through a `SnapshotStorage` before each commit that changed data: the tables the commit changed when the storage can store single tables (`saveTablesSync`), otherwise the complete state (`saveSync`).

Which tables a commit changed is not read from its statements. The runtime asks the engine, which records the rows it changes (SQLite's session extension, one session per table). The storage decides what that means for files; the runtime knows nothing about files.

Consumers so far: the NestJS + TypeORM mode, the SQL console (`local-db-sandbox sql`), which executes statements typed by the user on the same runtime, the PostgREST endpoint, and the runtime's access, through which Local DB Studio looks into a runtime that one of them has open (below, and D-042). For that, one call can say that it must change nothing, how many rows it wants at most, and what it runs for (`ExecuteOptions`); nothing of it outlasts the call.

A column has a storage type in the runtime (`ColumnSchema.type`: how its values are held in SQLite and in the fixture) and, kept as information, the type its source declared (`declaredType`). What the values are to an application is the ORM integration's business: the TypeORM integration decides it in one place (`column-semantics.ts`), gives TypeORM's SQLite dialect a type whose own conversion fits, and leaves the application's declarations as they were. Raw query results are not converted. See D-026.

What SQL does to the tables (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`) changes SQLite's tables, not the definitions the runtime was opened with, and is not saved. `SqliteRuntime.readCatalog` reads it back from SQLite's catalog as table definitions (`packages/runtime/src/sqlite-catalog.ts`): tables made and dropped, columns added and dropped, and a table SQL did not change as it was given; anything else is refused with what it is. `stateOf` gives the rows of tables so read. Neither changes the runtime's `schema` or what it saves. Their consumer is `simulate` (D-045), which runs a script on a database read with saving off and writes what it left as a new database with the storage's `createDatabase`; the database it read is never opened to write.

`SqliteRuntime` (Node's `node:sqlite`) is the only implementation. ORM integrations are translation layers: they turn entity metadata into a `TableSchema[]` and hand the runtime SQL, preferably SQL the ORM generated itself. They do not implement data access. The runtime does not know about any ORM, HTTP, or the CLI, and depends on the core only for the fixture model (`DatabaseState`) and the size-limit error.

The standalone REST mode still uses the core `Database` over the JSON state. `docs/COMPATIBILITY.md` is the contract of the runtime path.

### Side Effects (experimental)

What an application does besides using its database. It is a package of its own (`packages/side-effects`), next to the relational runtime and unknown to it:

```text
Application
   |- database -> RelationalRuntime -> SQLite
   |- mail     -> its own mail library -> local SMTP capture (nothing is sent on)
   `- network  -> net / dns of Node    -> network hook (allow, warn, block)
```

Responsibilities:
- a local SMTP server that accepts mail and keeps it in memory (`SmtpCaptureServer`, `MailCapture`), with a reader for the messages (`parseMail`);
- the environment variables that lead the application's own mail settings to it (`smtpEnvironment`); nothing of the application is rewritten;
- a hook on the TCP connections and name look-ups of the application's process (`installNetworkHook`);
- one structured `SideEffectEvent` per captured message and per connection, with the request it belongs to; log lines are formatted from them;
- what was started, as a structured status (`SideEffects.status`: whether mail is captured and the application led to the capture, and what the guard does), and the lines that say what of it is not kept on this machine (`formatUnguardedSideEffects`). The package prints none of them itself; the NestJS adapter does, each time it starts, before the application is loaded (D-043);
- a local, token-protected HTTP endpoint through which the `mail` command reads the mailbox of a running sandbox (`startMailControl`, `MailClient`).

It depends on nothing but Node: not on the core, the runtime, an ORM, or a web framework. Whoever runs an application calls `startSideEffects` in the application's process before the application is loaded, and passes a function that names the request the caller is running for. The NestJS adapter passes the one its request correlation already has, so a captured message carries the same request ID as the SQL of that request.

Two processes can be involved. With watch mode, the application's process is restarted on every source change, so the mail capture lives in the watcher (`startSharedMailCapture`): it listens for as long as `npm run sandbox` runs, and captured mail survives restarts. The application's process then starts no capture; it gets the capture's address in its environment and tells the watcher, over the channel that already connects them, which request each of its connections to the capture is for. The network hook is always in the application's process, since that is where the connections are made. Without watch mode there is one process, and it has both.

Nothing here emulates a service. A cache, an object store, an HTTP API, or a queue that the application uses is either reached, reported, or refused. See D-029.

### PostgreSQL Migration Collector and Bootstrap (experimental)

From a project's schema source to a sandbox database, without a running database:

```text
supabase/migrations/*.sql
   v  ordered by version (migrations.ts)
libpg-query                         PostgreSQL 18's own parser (WebAssembly); a runtime dependency, loaded on first use
   v  parse trees, byte positions
collector (packages/import-postgres)   applies each statement to a model of the public schema;
   |                                   one report entry per statement: applied, seeded, retained,
   |                                   not-reproduced, no-effect, unsupported
   v  canonical schema (tables with provenance, enumerated types) + seed rows + report
bootstrapDatabase (packages/cli)    loads them into SqliteRuntime in memory (tables, keys, computed defaults),
   v                                then writes the runtime's snapshot as a new database directory
sandbox.db (directory format 5)  ->  postgrest / sql / any runtime consumer, and diff-schema
```

Boundaries:
- Reading PostgreSQL stays in `packages/import-postgres`: its parse tree, type names, default functions, naming rules, and catalog rules. (Writing PostgreSQL is the migration generator's, `packages/migration/src/postgres`, below; it imports neither the collector nor the parser.) What leaves it is the sandbox's canonical schema (`TableSchema[]` and `SchemaTypes`, D-033 and D-036), seed rows as fixture values, and a structured report. The runtime, the storage, the PostgREST endpoint, and the schema diff know nothing of PostgreSQL, and do not import the collector. A test checks the import graph (`packages/cli/test/boundaries.test.ts`): what each source imports, followed through. It cannot see a module loaded under a name worked out at run time, so those packages may not load anything that way (`import()` or `require()` of a value, `createRequire`).
- The parser (`libpg-query`) is imported in one file, `parser.ts`, with `import()` on first use. It is loaded when migrations are collected (`init`, and `diff-schema`, `plan-migration`, or `generate-migration` given migrations), when `generate-migration` gives the SQL it generated to the parser before it prints it (`sql-check.ts`, D-039), and by no other command. The same test starts the CLI in a process of its own that records every module it resolves, runs the other commands there (the two that serve included), and finds the parser resolved by none of them.
- The collector does not write files; `bootstrapDatabase` does not know where definitions came from; `init` (CLI) composes the two and formats terminal lines from the report.

From a running PostgreSQL database (`init-pg`, D-049), the same way, with the catalog in place of the migration files:

```text
PostgreSQL server (the host the user names)
   v  one connection, one READ ONLY transaction, SELECTs of pg_catalog only, rolled back (pg-client.ts)
postgres (postgres.js)              the client; a runtime dependency, loaded on first use by init-pg alone
   v  catalog rows
catalog-scan.ts                     writes the catalog as the statements that would create it, with PostgreSQL's own
   |                                format_type / pg_get_expr / pg_get_constraintdef / pg_get_indexdef; notes what it leaves out
   v  schema-scan.sql (in memory)
collector (packages/import-postgres)   as above: canonical schema + report; no rows
   v
bootstrapDatabase (packages/cli)  ->  sandbox.db
```

- Reading a server is in `packages/import-postgres` too (rule 8a): the client is imported in one file, `pg-client.ts`, with `import()` on first use, and no other command loads it (the same import-graph test). The connection string is taken apart there and never handed on whole.
- There is one way into the canonical schema: what the catalog holds goes through the collector, so a scanned schema and a migrated one mean the same things.
- A database directory does not store definitions that its own reader would refuse: the schema document is read back before anything is written (D-036). A source of definitions with a defect fails at the save, not at the next start.
- Where each object comes from is part of the definitions themselves (D-036), and so is stored with the database. The report keeps a summary and the migrations' hashes.

See D-033 to D-035 and docs/COMPATIBILITY.md, "PostgreSQL migrations".

### Canonical Schema (experimental)

The sandbox's table definitions are its canonical schema (D-033, D-036): `DatabaseSchema` is `tables` and `types`. It is the runtime's own model (`packages/runtime/src/runtime.ts`, `canonical-type.ts`), not a model of any dialect. Every source of definitions maps into it, and every consumer reads it and nothing else.

```text
PostgreSQL migrations --collector--+
schema.json (stored)  --storage----+--> DatabaseSchema --+--> runtime (creates the tables)
written by hand, TypeORM entities -+                     +--> storage (schema.json, directory format 5)
                                                         +--> PostgREST endpoint (types and keys of a request)
                                                         +--> schema diff (what differs between two of them)
                                                                 +--> migration plan (how that is carried out)
                                                                         +--> PostgreSQL migration (the statements PostgreSQL does it with)
```

What it holds:
- Tables with their columns in order; the primary key as a constraint (name, columns in the key's order); unique constraints; foreign keys of one or several columns with their actions; indexes; all enforced by SQLite. Check constraints, index expressions and conditions, and source default expressions, kept as information. Constraint and index names are kept.
- A column's type four ways: the storage type (`type`: how the runtime holds the values, and the only one the runtime acts on), the declared type (`declaredType`: the source's spelling), the canonical type (`canonicalType`: what the type is; `integer` and `int4` are one), and the source dialect's name for it (`sourceDialectType`).
- The schema's enumerated types (`types.enums`), each once, with its values in order. A column names its type; the values on a column are that type's, resolved when a schema is read.
- Provenance on every object: `origin` (the statement that created it, with its file's hash) and `renames` (the renames the source states, oldest first). It is information: two definitions never differ because of it. Two objects with the same origin are the same object, which is what a rename is told by.
- What an index, a key, and a constraint are beyond their columns (D-040): how an index is built (`method`), its keys in their order with each key's direction, place of NULLs, operator class, and collation (`keys`, there only when `columns` and `expressions` do not say the index), the columns a key or an index carries along (`include`), `nullsNotDistinct`, and whether a key or a foreign key is deferrable (`deferrable`). The runtime creates what it always created; this is what the schema says of the database it describes. What a source says that the model has no place for is kept as text (`sourceClauses`), so that the object is never taken for one without it.
- What the text of an expression names (D-040): `names` on a check and on an index with an expression or a condition, `defaultNames` on a column. Each name is as the text has it, with what its thing is called now when that is something else (`ExpressionName`); a text is stale by such a name. A schema that does not know what a text names says nothing, or, once a rename may have reached the text, says that (`mayBeStale`). The code that follows a rename in a list of names is the schema's own (`packages/runtime/src/expression-names.ts`), beside `canonical-type.ts` and `index-definition.ts`: the three are all of the runtime that the schema diff and the migration package load.

Rules:
- It is extended when a consumer needs it, and stays dialect-neutral. A type of one dialect without a canonical meaning is kept as that dialect's type (`other`), never given a meaning by guessing.
- A schema need not have canonical types or provenance: one written by hand may have neither, and so may say nothing of what its expressions name. The runtime and the PostgREST endpoint do not need them; the schema diff then compares what was declared and says so.
- Every source maps its own types into the one type model. PostgreSQL's are mapped in `packages/import-postgres`. Those of TypeORM entities are mapped in `packages/nest-typeorm/src/canonical-types.ts` (D-040), which reads a declaration as TypeORM's own PostgreSQL driver does; `databaseSchema` gives the canonical schema of entities, with their enumerated types. That file knows TypeORM's metadata and nothing of PostgreSQL's parser, catalog, or SQL, and the generator knows nothing of TypeORM: it reads canonical types.
- A storage says whether it holds canonical types and the schema's enumerated types (`storesCanonicalSchema`): a directory does, a single file does not. `describe(schema, types)` gives a storage the definitions and the types they name.

### Schema Diff (experimental)

What differs between two canonical schemas, as data (`packages/schema-diff`, D-037).

```text
<before>  --+                     +--> formatSchemaDiff     lines for people
            +--> diffSchemas --> SchemaDiff IR
<after>   --+   (headless)        +--> stringifySchemaDiff  JSON, the same bytes for the same schemas

a side is: a database (its stored definitions), a schema file, PostgreSQL migrations, or TypeORM entities;
`diff-schema` (packages/cli) reads each into a DatabaseSchema and prints the result
```

Responsibilities:
- compare two `DatabaseSchema` values by meaning: types by canonical type, defaults by what they are, foreign key actions with `NO ACTION` explicit;
- tell a rename from a drop and an add by explicit evidence only (the same origin, and recorded renames from one name to the other); nothing is matched by similarity;
- never take a dropped object for the one that takes its name: a key over a dropped column and the same key over a column renamed to that name are two keys;
- tell two indexes and two constraints apart by all they are (D-040): the method, the keys in their order with what each says, what is carried along, deferrability, and what the schema only says is there;
- compare two expressions that read alike by what the schemas say their texts name, so that the same text over a renamed column and over the column that took its name are two expressions, and a text that a rename left behind in one object is that object's still;
- list the changes as a `SchemaDiff` (`{ diffVersion, changes }`), in one fixed order that does not depend on how the schemas list their objects, and in which a diff can be carried out: what goes (named as the before side names it), then the renames, then what comes and what changes (named as the after side names it);
- format a diff as lines, and write it as JSON with every object's keys in a fixed order.

It says what changed, not how to change it: it has no SQL and no dialect, and it changes nothing. It depends on the runtime's schema model alone (when it runs, on its own files and the schema model's own code: `runtime/src/canonical-type.ts`, `expression-names.ts`, and `index-definition.ts`); it reads no files and knows no storage, no PostgreSQL, and no CLI. `diff-schema` composes it with the storage, the collector, and the entity collection, all of which it only reads. Entities are a side through the collection of `import-typeorm` and the canonical schema `init-nest` stores for it (`packages/cli/src/project-entities.ts`, D-044): nothing of an application is started, and the diff does not know where a schema came from. What a side of entities does not say (indexes, constraints, and what the collection did not read) is a rule of the commands (`packages/cli/src/unsaid-changes.ts`): such a change is noted, and `generate-migration` writes no SQL for it; the diff, the planner, and the generator are not changed for it.

Not implemented: applying a diff to a database. How a diff is carried out is the migration plan's (below), and the SQL for it the PostgreSQL generator's (further below); the diff has neither in it.

### Migration Planning (experimental)

A diff applied to a schema, and the plan that carries a diff out (`packages/migration`, D-038).

```text
canonical schema --> schema diff --> migration plan --> PostgreSQL migration (the next section; no other database has a generator)
                     what changed    how it is carried out   how PostgreSQL does it

                                 +--> applyDiff      the schema the diff makes of a schema (what the diff means)
SchemaDiff + the schema it is of -+
                                 +--> planMigration  MigrationPlan: steps that can each be taken when its turn comes
                                                       +--> applyPlan / validatePlan  the plan carried out step by step,
                                                                                       under the rules a database has on the way
```

Responsibilities:
- apply a diff to a canonical schema, and refuse a diff that does not fit it (a change that is not whole, an object that is not there, a rename of another object than its evidence is of, a `before` that the schema does not have);
- plan a diff: put its changes in an order in which each can be carried out, and add the steps that such an order needs, namely a temporary name where names go round, and a foreign key dropped ahead of tables that go together;
- say what a step may not do when its turn comes (`rules.ts`): drop what a foreign key refers to, drop a column that a key is over or carries along or that a check or an index's expression names, take a name that is taken, use a type or a value that is not there yet;
- follow a rename in what the texts it reaches name (D-040): the schema a plan leaves says of each expression what it names, exactly where the schema it started from said it, and that the text may be stale where it did not;
- carry a plan out on a schema under those rules, and refuse one that cannot be, or that does not arrive at the schema it is for: this is the validator.

The line between the two IRs: a `SchemaDiff` says what changed, and a `MigrationPlan` how it is carried out. Whatever is only there so that a step can be taken is in the plan, never in the diff. The schema diff is not changed for the plan's sake, and does not know of it.

It depends on the runtime's schema model and on the schema diff, and on nothing else: no collector, no parser, no storage, no HTTP, no ORM, and no syntax of any database. What is PostgreSQL's is in `src/postgres` (the next section), which nothing else of the package imports. A test checks the import graph. `plan-migration` (packages/cli) reads two schemas as `diff-schema` does and prints the plan; it carries nothing out.

Not implemented: applying a plan to a database, and keeping rows through a change of schema. A plan has no SQL in it: that is a generator's.

### PostgreSQL Migration Generation (experimental)

A migration plan as the statements PostgreSQL carries it out with (`packages/migration/src/postgres`, D-039).

```text
SchemaDiff           what changed
   v  planMigration
MigrationPlan        in which steps it is carried out, in any database
   v  generatePostgresMigration(before, plan, options)   the steps in their order, each on the schema as it is then
PostgresGeneration   every step with its safety class, and, when no step is refused:
   PostgresMigration { version, dialect, segments }
      segment    { mode: transaction | autocommit, reason?, statements }
      statement  { kind and its parts, step, because?, safety, assumes?, dropsData?, expressions?, sql }
   v  renderPostgresMigration / stringifyPostgresGeneration
an SQL script (BEGIN and COMMIT from the segments' modes), or JSON: the same bytes for the same schema and plan
```

Its parts:
- `statements.ts`: the kinds of statement, and the one function that writes a statement's text from its parts;
- `sql.ts` and `types.ts`: names (always quoted), constants, and types, which are written from canonical types and never from a source's spelling;
- `type-changes.ts`: what a change of a column's type does to the values;
- `safety.ts`: the four classes and their reasons;
- `migration.ts`: segments, the script, and the JSON;
- `generator.ts`: carries the plan out on a model of the schema, as the validator of plans does, and writes each step when it is taken.

Responsibilities:
- write each step of a plan as PostgreSQL's statements, in the plan's order, and never from the diff;
- add the statements PostgreSQL asks for beyond a plan, each with its step and its reason (`because`): a foreign key that goes ahead of the key it rests on and comes back, an enumerated type made again, a type renamed out of the way of a table's name, a default or a numbering taken off across a change of type. No step is put in another place;
- class every step (`safe`, `requiresDataMigration`, `requiresExplicitCast`, `unsupported`) and write a migration only when no step is refused. What rests on the rows is written only on the caller's word, and marked; a conversion or a value for rows is never made up;
- say where transactions are, as data: a value added to an enumerated type stands in a segment of its own, outside a transaction, and the script's `BEGIN` and `COMMIT` are written from the segments;
- write what the schema holds of an index and a constraint (D-040: the method, the keys with what each says, `INCLUDE`, `DEFERRABLE`), and refuse what it only says is there (`sourceClauses`);
- write an expression only when its text is what PostgreSQL would read as it was meant: one that a rename has left behind is refused, also when it is a default that is put back on the way. No expression is rewritten.

It reads plans and canonical schemas and writes text: it imports no collector, no parser, and no module. Nothing else of the migration package imports it, and the schema diff, the runtime, the storage, and the PostgREST endpoint know nothing of it. A test checks the import graph.

What it generates is given to PostgreSQL's own parser by whoever composes the two. `checkSqlStatements` (`packages/import-postgres/src/sql-check.ts`) says whether each statement is one statement, and each expression that was copied from a schema one expression. The package's tests do that for every statement they generate, and have the collector apply it: the migration from A to B, applied to A, has to mean B. `generate-migration` (packages/cli) does it before it prints, which is why that command loads the parser when it has statements.

Not implemented: carrying a migration out on a database, migrations backwards, converting or filling in rows, and a generator for any other database. See D-039 and docs/COMPATIBILITY.md, "PostgreSQL migration".

### PostgREST Endpoint (experimental)

An HTTP adapter for applications that reach their database through PostgREST (Supabase's `supabase-js`), in a browser or in Deno, where the runtime cannot run. They are pointed at it by their Supabase URL; their code is not changed.

```text
supabase-js (browser, Deno, Node)
   |  HTTP /rest/v1/<table>
   v
PostgrestServer (node:http)        loopback, CORS, request IDs, other Supabase services -> 501
   v
handlePostgrestRequest             headless: allowlist, PostgREST grammar -> Query IR,
   |                               values <-> stored values through the runtime's column codec
   v
RelationalRuntime / SQLite         one transaction per request, saved before commit
```

Responsibilities, in `packages/postgrest`:
- read a request with an allowlist (the v0 subset) and refuse everything else by name (`501 SANDBOX_POSTGREST_UNSUPPORTED`);
- build Query IR (`select`, `upsert`, `delete` with `eq`/`gte`/`lt`) from the runtime's `TableSchema[]` alone;
- convert filter values, request bodies, and returned rows with the runtime's codec (`toStoredValue`/`fromStoredValue`), adding only PostgREST's wire spellings;
- answer as PostgREST does, including its error codes;
- number each request's statements (`PostgrestRequestCorrelation`) and emit one `PostgrestRequestEvent` per request, without header values.

The runtime knows nothing about PostgREST; the translator knows nothing about HTTP, files, or the CLI; `startPostgrestSandbox` composes storage, runtime, and server. The supported subset is `docs/COMPATIBILITY.md`, "PostgREST endpoint". See D-030 (Query IR), D-031 (codec), D-032 (endpoint and scope).

### Local DB Studio (experimental)

A page that looks into a sandbox database, and the two things under it that are not Studio's alone: who has a database open, and how a runtime that a process has open is asked from outside that process. See D-042.

```text
browser page (one document; no framework, nothing loaded)
   |  HTTP on 127.0.0.1, with the key of the session
   v
Studio server (packages/studio)          GET /api/status, POST /api/access/<operation>, POST /api/request (the API tab)
   v
StudioSession                            which way the database is open:
   |
   +-- standalone ----------------------> LocalRuntimeAccess --> RelationalRuntime / SQLite --> storage
   |    (a directory no process has: claimed, loaded, saved)
   |
   +-- attached --> AttachedRuntimeAccess --> ControlClient
                         |  HTTP on 127.0.0.1, with the owner's token
                         v
                    control server, in the process that has the database open
                         v
                    LocalRuntimeAccess --> that process's RelationalRuntime (the application's own)
```

**Who has a database open** (`packages/storage-json/src/writer-owner.ts`). One process has a database open to write at a time. It says so in a record beside the database (`<database>.owner.json`: process, since when, a name for this one claim, what kind of sandbox it is, the database's canonical path, and where it serves its runtime). The record is not part of the database, and no format knows it. A database is claimed before it is read; a live owner's record is never taken; one whose process is gone, or whose owner no longer answers where it served, is taken over. The REST sandbox, the PostgREST endpoint, the NestJS sandbox module, the `sql` command when it may save, and a standalone Studio claim; what a script opens for a moment through the library does not. `init --force` claims the database it replaces for as long as it replaces it (kind `init`, D-043), so that it is refused one that a process has open, and no process opens the database meanwhile; it serves nothing, and its record is gone when the command ends. The other commands that write a database (`convert`, `import-typeorm`, `init-nest`, `migrate`) ask no record. A sandbox that is refused a database which a Studio has to itself is told how the database is handed over, and so is whoever started that Studio (a notice of the session, which the command prints and the page shows): the user stops Studio, starts the sandbox, and starts Studio again. No process lets go of a database because another asked, and none starts another.

**The runtime's access** (`packages/runtime-access`). What is asked of a runtime that someone has open, as data: `RuntimeAccess`, with eleven operations (`info`, `schema`, `browse`, `row`, `insert`, `update`, `delete`, `sql`, `events`, `clear`, D-051: every row of chosen tables, deleted in one transaction, refused when a table that is not chosen refers to one that is; and `snapshot`, D-050: the definitions of chosen tables and, when asked for, all their rows, whole, read at one moment, bounded by `maxSnapshotBytes`).

- `LocalRuntimeAccess` is the one implementation, on a `RelationalRuntime` that stays whoever's it is. Rows are read and changed through the Query IR and the column codec; the console hands whole statements to the runtime. It executes nothing itself, and nothing else executes for it.
- One call to the runtime can say that it must change nothing, how many rows it wants at most, and what it runs for (`ExecuteOptions`): a runtime that an application has open is not opened a second time for someone who only wants to look. While the application has a transaction open, the access does nothing and says that the runtime is busy.
- Every answer is bounded (`AccessLimits`), and every refusal is an `AccessError` with a code.
- The control (`control-server.ts`, `control-client.ts`) serves an access to other processes of the machine: HTTP on 127.0.0.1, a random token that is in the owner's record alone, the eleven operations and nothing else. `serveRuntime` is what an owner calls. `ControlClient` is made for one owner; it sends nothing twice, and tells apart a request that was not sent, one whose outcome is not known, and an answer that is not the owner's.
- `AttachedRuntimeAccess` is access to a database for as long as some process has it open: it finds the owner by the record, checks that what answers is that owner with that database, and finds the next owner after a restart. A request that changes nothing is asked again of the new owner; a change is sent once, to the owner it is attached to, and never again. It never claims a database.
- `ReadOnlyAccess` stands before an access through which nothing may be changed.

**Studio** (`packages/studio`): `openStudioSession` decides how a database is open (standalone, attached, or to look only) and gives a `RuntimeAccess` and a status; `startStudioServer` serves the page and, behind it, the status and the operations of that access, answered by the same function the control answers with (`answerAccessRequest`). `studio` (packages/cli) parses options and prints lines formatted from the status. The API tab (D-046) is the one thing Studio's server sends itself: `sendApiRequest` (`packages/studio/src/api-request.ts`, on `node:http` alone) sends one request for the page to an API on this machine, by the URL's host as written (`127.0.0.1`, `localhost`, `[::1]`; no name is looked up), follows no redirect, bounds the time and the body, and logs and keeps nothing. It knows no database and no session: what the request changed is seen through the access, as anything else is.

Boundaries, checked by the import-graph test:

- The access reaches the runtime, the storage's record of the owner, and the SQL console's statement splitter. It knows no adapter: no HTTP server of an application, no ORM, no CLI.
- Studio's own files import the access, the storage, and the one function that opens a database on the runtime (`SqlConsole.open`). They import no runtime, and nothing that serves an application.
- Only the CLI imports Studio. The processes that own a database know the access, and not who looks through it. The PostgREST package reaches the runtime, the storage, and the core as before: it claims its database, and the `postgrest` command serves its runtime.
- Neither package loads the PostgreSQL parser. The access adds no dependency. Studio has one: the layout of the ER diagram (`@dagrejs/dagre`, D-053), imported in `diagram.ts` alone, on first use; the page loads no library.

The Export tab (D-050) is composed the same way. Studio's server takes a snapshot of the chosen tables through the access and hands it to an exporter that whoever started Studio gave it; Studio knows no SQL dialect. The CLI gives `exportSqlForStudio` (`packages/cli/src/sql-export.ts`): the script is written by `exportPostgresSql` (`packages/migration/src/postgres/export.ts`), whose definitions are the PostgreSQL generator's migration from an empty schema and whose rows are the generator's constants, and the definitions are given to PostgreSQL's parser before the script is offered.

```text
Studio's page  -- POST /api/export -->  Studio's server  -- snapshot -->  the runtime's access (local, or the owner's through the control)
                                              |
                                              v  exporter (given by the CLI)
                                        exportPostgresSql  ->  checkSqlStatements (parser)  ->  the script, as a .sql file in the page
```

The ER Diagram tab (D-053) reads the same snapshot, without rows. Studio's server turns the tables' canonical definitions into boxes and foreign keys (`diagramOf`, `packages/studio/src/diagram.ts`), and places the boxes with Dagre, which that file alone imports, on first use (`layoutDiagram`). The page gets the diagram with its places and draws it as SVG with its own script: lines from column to column, zoom, pan, search, and dragging are the page's, and nothing of them is sent back.

```text
Studio's page  -- POST /api/diagram { tables } -->  Studio's server  -- snapshot (rows: false) -->  the runtime's access
      ^                                                    |
      |                                                    v  diagramOf (TableSchema -> tables, foreign keys)  ->  layoutDiagram (Dagre)
      +------------------ the diagram, with places --------+
```

Not implemented: anything that changes a table's definition, a page for the runtime's events, attaching to the REST sandbox (which has no relational runtime), and access from another machine.

## Internal Query Model

Avoid coupling query behavior directly to HTTP syntax.

```ts
export interface QuerySpec {
  collection: string;
  filters?: FilterSpec[];
  sort?: SortSpec[];
  offset?: number;
  limit?: number;
}
```

REST requests are translated into this model by the server adapter. Future adapters can translate other inputs into the same model.

## Events

```ts
export interface OperationEvent {
  operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  collection: string;
  statement?: string;
  rows: number;
  localExecutionMs: number;
}

export interface RequestEvent {
  method: string;
  path: string;
  status: number;
  rows?: number;
  localExecutionMs?: number;
  simulatedDelayMs?: number;
  totalMs: number;
}
```

Keep raw events structured. Terminal logs, a future VS Code panel, and future performance summaries should all consume the same event stream.

## JSON Format

Phase 1 keeps the format intentionally small:

```json
{
  "$meta": { "version": 1 },
  "$config": { "server": {}, "defaults": {}, "routes": {} },
  "data": { "users": [] }
}
```

Do not overload Phase 1 with a full cross-database schema language.

## SQL-like Logging

Phase 1 operations may produce readable SQL-like diagnostics, for example:

```sql
SELECT * FROM users WHERE active = true;
```

This is diagnostic output only. Do not build a SQL parser or promise database-dialect compatibility in Phase 1.

## Future Integration

The canonical schema (tables, column types, keys, indexes, constraints, enumerated types) is the runtime's own model since D-036, because the sandbox needed it itself. A separate `db-schema-core` package that both Local DB Sandbox and a future DB Documentation/Migration product depend on is still possible: the schema's types refer to nothing of the runtime's engine and could be moved as they are. Nothing needs that yet.
