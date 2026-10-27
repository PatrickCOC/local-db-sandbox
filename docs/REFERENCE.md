# Local DB Sandbox Reference

Every command, option, file format, and limit, in English. This is the reference part of what used to be the README; the README is now the entry point, and the task-oriented guide is [USER_GUIDE.md](USER_GUIDE.md) (Traditional Chinese). What the relational runtime does exactly is in [COMPATIBILITY.md](COMPATIBILITY.md).

A command that loads SQLite (`init`, `sql`, `simulate`, `postgrest`, a standalone Studio, the NestJS sandbox) prints Node's `ExperimentalWarning: SQLite is an experimental feature` once; it is harmless, and is left out of the examples below.

## A JSON File as a Mock REST API

Create `db.json` in your project:

```json
{
  "data": {
    "users": [
      { "id": 1, "name": "Patrick", "active": true }
    ],
    "orders": []
  }
}
```

Start the sandbox:

```sh
npx local-db-sandbox db.json
```

```text
Local DB Sandbox running at http://127.0.0.1:4783
  file:        db.json
  collections: users, orders
  Press Ctrl+C to stop.
```

Use `http://127.0.0.1:4783` as your frontend's API base URL. Press Ctrl+C to stop; requests in progress finish first.

To try it from this repository without installing anything elsewhere:

```sh
npm start -- examples/basic/db.json
```

The routes, the file format, and the rules for simulated delays and errors follow below.

## CLI

```text
local-db-sandbox <file.json> [options]
local-db-sandbox import-typeorm <path> [options]
local-db-sandbox init-nest [entry] [options]
local-db-sandbox sql <database> ["<SQL>"] [options]
local-db-sandbox convert <database> --out <path> [options]
local-db-sandbox inspect <database> [options]
local-db-sandbox migrate <database> [options]
local-db-sandbox mail list | show <id> | clear [options]
local-db-sandbox postgrest <database> [options]
local-db-sandbox init [project-or-migrations] [options]
local-db-sandbox init-pg <connection-url> [options]
local-db-sandbox diff-schema <before> <after> [options]
local-db-sandbox plan-migration <before> <after> [options]
local-db-sandbox generate-migration <before> <after> --dialect postgres [options]
local-db-sandbox simulate <database> <script.sql> [options]
local-db-sandbox studio [database] [options]

  -p, --port <number>  Port to listen on (default: $config.server.port or 4783; 0 = any free port)
  -H, --host <name>    Host to bind (default: $config.server.host or 127.0.0.1)
      --max-file-size <MB>  Largest database file to accept (default: 150; at most 250)
  -v, --verbose        Also log each local operation and CORS preflight requests
  -q, --quiet          Do not log requests
  -h, --help           Show this help
      --version        Show the version
```

Command-line options take precedence over `$config.server`.

## Routes

Every key under `data` becomes a collection with these routes:

```text
GET    /                 list collection names
GET    /users            list rows
GET    /users/:id        read one row
POST   /users            insert (an integer id is assigned when omitted)
PUT    /users/:id        replace all fields
PATCH  /users/:id        merge fields
DELETE /users/:id        delete
```

List requests accept:

| Query | Meaning |
|---|---|
| `active=true` | Equality filter on a field. Several filters must all match. |
| `_sort=name,-age` | Sort by `name` ascending, then `age` descending. |
| `_limit=10&_offset=20` | Pagination. The match count before pagination is in the `X-Total-Count` header. |

Errors are returned as `{ "error": { "code": "ROW_NOT_FOUND", "message": "..." } }` with a 4xx or 5xx status. CORS is open to any origin.

## Database File Format

```json
{
  "$meta": { "version": 1 },
  "$config": {
    "server": { "host": "127.0.0.1", "port": 4783 },
    "limits": { "maxFileSizeMb": 50 },
    "defaults": { "delayMs": 150 },
    "routes": {
      "GET /orders": { "empty": true },
      "POST /orders": { "error": { "status": 503, "code": "UNAVAILABLE", "message": "Try later." } },
      "/users/:id": { "delayMs": 0, "status": 202 }
    }
  },
  "data": {
    "users": [],
    "orders": []
  }
}
```

- `data` (required): collection name to array of row objects. Rows are identified by `id`.
- `$meta.version` (optional): the format version of a single-file database, `1`. A file without `$meta` is format 1 as well, and gets the key with its next save. See [Format Versions and Migration](#format-versions-and-migration).
- `$config` (optional): everything in it is optional. Unknown keys are rejected at startup.
  - `server.host`, `server.port`: where to listen.
  - `limits.maxFileSizeMb`: lowers the largest allowed database file size; see [Size Limits](#size-limits).
  - `defaults`: a simulation rule applied to every request.
  - `routes`: simulation rules per route, keyed by `"/path"` or `"METHOD /path"`. A `:name` segment matches any value.

A simulation rule can set:

| Field | Effect |
|---|---|
| `delayMs` | Wait before handling the request. |
| `status` | Respond with this status code. The operation still runs and its body is kept. |
| `error` | Respond with this error (`status` defaults to 500) and do not run the operation. |
| `empty` | List requests return `[]`. |

When several routes match, only the most specific one applies (more literal path segments, then a named method). Its fields replace `defaults` one by one; use `0`, `false`, or `null` to switch a default off for that route. `error` wins over `empty` and `status`.

The sandbox rewrites the file on every change and keeps `$config` as it was.

### Database directory

A database can also be a directory, with one file per table. `init-nest` creates one for a new project, and `local-db-sandbox convert sandbox.db.json --out sandbox.db` makes one from a single file (and back).

```text
sandbox.db/
  manifest.json            format version, configuration, generation, and the file of every table
  schema.json              table definitions
  tables/users.json        the rows of one table
  tables/orders.g7.json    the rows of a table that was saved again, in generation 7
```

- **The manifest says which file holds a table.** In a new database a table's file is named after the table. When a table's rows change, they are written to a new file named after that save's generation (`orders.g7.json`), and `manifest.json` is then replaced, in one step, by a manifest that names it. A file that is part of the database is never modified.
- **A change writes the tables it changed, and the manifest.** Every other table keeps its file. In the NestJS + TypeORM mode and the SQL console, which tables a commit changed is taken from SQLite's own record of the rows it changed: rows changed by a trigger or by a foreign key's `ON DELETE` action count, and rows of a transaction or savepoint that was rolled back do not. A transaction that only reads, or is rolled back, writes nothing.
- **A table without a usable primary key turns that off for its database.** SQLite's record goes by primary key and passes over a table that has none, or whose key can be NULL. A database with such a table is saved by reading every table at each commit; the files that are written are still only those whose content differs.
- **Any number of processes may read while one saves.** A reader reads the manifest and then the files it names. It gets one generation, never tables of two. The files a save replaced are deleted about a second later (sooner when saves follow each other so quickly that dozens are waiting), so that a reader which was already reading them finishes; one that comes too late starts over.
- **One process saves at a time.** A sandbox process says that it has a database open, in a file beside it (`sandbox.db.owner.json`), and a second one that would write is refused when it starts; see [Local DB Studio](#local-db-studio-experimental). Behind that, the storage itself still holds: a process whose database was saved by another one since it loaded it is refused at its next save (`... was saved by something else since it was loaded here`). Stop the sandbox before you change its database with the SQL console or `convert`, and start it again afterwards.
- **Whatever the manifest does not name is not part of the database.** A save that is interrupted before the manifest is replaced changes nothing; what it wrote is removed by the next save. To edit a table by hand, stop the sandbox and edit the file the manifest names. To add one, add its file and list it under `tables`; a plain `.json` file in `tables/` that is not listed is reported as an error.
- **The size limit** applies to the files of the current generation (manifest, schema, and tables), not to what else is in the directory.
- **`schema.json` is the database's schema.** Tables and their columns, with how each column is stored; and, when the definitions have them, keys, constraints, and indexes with their names, the schema's enumerated types, what each column's type is independent of its spelling, the statement each object comes from, how an index is built and what its keys are, whether a constraint is deferrable, and what the text of an expression names. Definitions that `init` makes from migrations have all of it; a directory of TypeORM entities has each column's type and the enumerated types. `docs/FORMAT.md` describes the document.
- **This is directory format 5.** Format 4 is the same layout with a `schema.json` that says less of indexes, constraints, and expressions; format 3 one that holds less still; and format 2 had no generations. A directory of an earlier format is read as it is and is not written to: migrate it once with `local-db-sandbox migrate sandbox.db`. See [Format Versions and Migration](#format-versions-and-migration).

A single-file database is not affected by any of this: it is one file, and is written as a whole.

### Format Versions and Migration

How a database is laid out on disk has a version number, stored in the database: `formatVersion` in a directory's `manifest.json`, `$meta.version` in a single file. It is not the version of this package. A single file has format 1; a directory has format 5, and earlier versions of this package wrote formats 2, 3, and 4.

```sh
npx local-db-sandbox inspect sandbox.db            # what format it has; changes nothing
npx local-db-sandbox migrate sandbox.db --dry-run  # what a migration would change; changes nothing
npx local-db-sandbox migrate sandbox.db            # bring it to the current format
```

```text
Database: sandbox.db
Storage: directory
Format version: 2
Current supported version: 5
Migration required: yes
Migration path: 2 -> 3 -> 4 -> 5
Tables: 41
Logical size: 383.1 KB (392,294 bytes)
This build reads the database as it is and does not change it. To bring it to format 5: local-db-sandbox migrate sandbox.db
```

- **Nothing is migrated automatically.** A database of an earlier format is read as it is, and a sandbox that would save to it does not start: it prints the `migrate` command to run. `migrate` is the only thing that changes a database's format.
- **A database of a later format is refused**: `Database format 6 is newer than this build supports (max 5). Upgrade local-db-sandbox.` Nothing of it is interpreted.
- **A migration step is published at once.** It is published by replacing `manifest.json`, like a save. Until then the database is the old format, complete; after it, the new one, complete. One that fails or is interrupted leaves the format it started from, and can be run again. A process that reads meanwhile gets one or the other. From format 2 there are two steps, each published on its own.
- **Before it is published, the result is read back** and compared with the database: every row, the table definitions, and the configuration.
- **No copy is made, and there is no way back.** Both steps so far replace only `manifest.json`; the rows and the table definitions stay in their files. To keep a database for an older version of this package, copy the directory before migrating.
- `inspect --json` and `migrate --json` print their result as JSON.

`docs/FORMAT.md` has the details: the formats, what each build reads and writes, and what happens when a migration is interrupted.

## Size Limits

The sandbox keeps the whole database in memory and rewrites the whole file on every change, so it is meant for small development fixtures. File size, not row count, is what is limited (1 MB = 1,048,576 bytes).

| File size | What happens |
|---|---|
| below 25 MB | Nothing. |
| 25 MB to below 75 MB | A warning. |
| 75 MB up to the limit | A strong warning. |
| above the limit (default 150 MB) | The file is refused. |

- **Loading:** the size is checked before the file is opened. A file above the limit is not read or parsed, and the sandbox does not start.
- **Saving:** the new content is measured before anything is written. A change that would take the file above the limit is refused with HTTP status 507 and error code `SANDBOX_SIZE_LIMIT`; the file and the in-memory data stay as they were.
- **Raising the limit:** only from outside the file, with `--max-file-size <MB>` on the command line or `maxFileSizeMb` passed to `startSandbox` / `JsonStorageAdapter`, up to 250 MB. Nothing inside the file can raise it, because the file is never read to find out whether it may be read.
- **Lowering the limit:** set `$config.limits.maxFileSizeMb` in the file, or pass a smaller value from outside. The lowest of the two applies. A lower limit from `$config` takes effect after the file has been parsed, so it can only reject files that were already within the outside limit.
- **Invalid values:** a limit that is not a number, is 0 or less, or is above 250 makes startup fail, wherever it is set. The warning thresholds are fixed.

Warnings are printed to the terminal by the CLI. From code, pass `onSizeWarning` to `startSandbox` (or to `JsonStorageAdapter`) to receive them as objects (`level`, `phase`, `sizeBytes`, `thresholdBytes`, `limitBytes`); a refused load or save throws `SandboxLimitError` with `sizeBytes` and `limitBytes`. A warning is reported when the file is loaded and again when a save moves it into a higher band, not on every save.

If you reach these limits, reduce the dataset or split it into several database files.

## Logs

Each request prints one line:

```text
12:41:03 GET   /users?active=true  200  18 rows  local=2.4ms total=6.8ms
12:41:08 PATCH /users/12  200  1 row  local=1.8ms total=4.1ms
12:41:09 POST  /orders  503  delay=150.3ms total=151.0ms  UNAVAILABLE  simulated=delay,error
```

- `local` is time spent in the sandbox's own operation, including writing the file.
- `delay` is simulated latency.
- `total` is the whole request, including `delay`.

With `--verbose`, each local operation is shown under its request:

```text
12:41:03 GET   /users?active=true  200  18 rows  local=2.4ms total=6.8ms
    SELECT  18 rows  local=2.4ms  SELECT * FROM users WHERE active = 'true'
```

The SQL-like text only describes what the sandbox did. No SQL is parsed or executed, and the timings say nothing about how a real database would perform.

## Use as a Library

For integration tests, start and stop the sandbox from code:

```js
import { startSandbox } from "local-db-sandbox";

const sandbox = await startSandbox({ file: "db.json", port: 0 });
const users = await (await fetch(`${sandbox.url}/users`)).json();
await sandbox.stop();
```

`startSandbox` also accepts `host` and `onRequest` (one structured event per request). The package additionally exports the building blocks: `Database`, `JsonStorageAdapter`, `SandboxServer`, and the log formatters.

## Import from TypeORM (experimental)

In a project that already has TypeORM entities, create the database file from them instead of writing it by hand:

```sh
npx local-db-sandbox import-typeorm src/entities
npx local-db-sandbox db.json
```

```text
Imported 3 TypeORM entities from src/entities
  users (User): id, createdAt, name, email
  post (Post): id, title, authorId -> users.id
Not imported exactly (1):
  [unsupported] Post.tags: Many-to-many relations need a join table, which is not generated.
Wrote db.json (empty collections).
Start it with: local-db-sandbox db.json
```

- `<path>` is an entity file or a folder. Only files that mention `typeorm` and an entity decorator are loaded. Loading runs those files' top-level code, as starting your application would. No database connection is made.
- TypeScript entities are compiled on the fly with the project's own `typescript` package; compiled JavaScript entities work too. Imports are resolved with the nearest `tsconfig.json` at or above the given path (`baseUrl`, `paths`, `moduleResolution`, including `extends`), so Nest-style imports such as `src/api/...` and path aliases work without being rewritten. Without a tsconfig, only relative imports and installed packages are resolved.
- Each entity becomes a collection named after its table. Collections are empty unless you pass `--sample-rows`, which adds one fixed placeholder row per collection.
- `--out <file>` chooses the output file (default `db.json`); an existing file is only replaced with `--force`.
- Columns, primary and generated columns, nullable, static defaults, enums, what a declared type takes beyond its name (a length, the digits of a decimal, that it is an array, the name of an enumerated type), and the key fields of `@ManyToOne` / owning `@OneToOne` relations are read. Everything that is skipped or cannot be determined is listed under "Not imported exactly".
- The sandbox identifies rows by a field named `id`. Entities with a different or composite primary key are imported, with a warning that `/:id` routes will not find their rows.

Column details are shown in the summary and available from the library (`importTypeorm(path)`); the database file itself only contains collections and rows. This is an import aid, not a migration, schema, or documentation tool.

## Use Behind a NestJS + TypeORM Backend (experimental)

Instead of serving its own REST API, the sandbox can sit behind an existing NestJS backend. Controllers, routes, services, and the frontend API contract stay as they are. Only the database is replaced: TypeORM runs against an embedded SQLite database that is created from the JSON database when the server starts.

```text
existing controller -> existing service -> TypeORM -> SQLite (in memory) <-> sandbox.db (JSON)
```

The JSON database (a directory, `sandbox.db`, for a new project; a single file, `sandbox.db.json`, for one that already has it) is the portable fixture and snapshot. It is loaded into SQLite at startup and written at each commit; queries are not run against it. `docs/COMPATIBILITY.md` describes exactly what this runtime supports and how SQLite differs from PostgreSQL or MySQL.

### A second server next to the original one

Set it up once, in the NestJS project:

```sh
npx local-db-sandbox init-nest src/main.ts
```

```text
Nest entry point: src/main.ts
  root module: AppModule (./app.module)
  TypeORM root: src/app.module.ts
Imported 2 TypeORM entities from src
  category (Category): code, label
  users (User): id, name, active, createdAt
Not imported exactly (2):
  [note] User.createdAt: @CreateDateColumn is imported as a plain field; the sandbox does not set or update it.
  [ambiguous] Category: The sandbox identifies rows by a field named "id", but the primary column is: code. Routes such as /category/:id will not find rows by that key.
Wrote sandbox.db (database directory: an empty file per table, and their definitions).
Wrote .local-db-sandbox/sandbox.server.ts
Wrote .local-db-sandbox/sandbox.config.json
Sandbox port: 3001
Added the "sandbox" script to package.json.
Start the sandbox with: npm run sandbox   (restarts when the application's sources change)
Start it once, without watching: node .local-db-sandbox/sandbox.server.ts
The application's own sources and start command are unchanged.
```

Then run either server, or both at once:

```sh
npm run start:dev   # the original application: its own port, its real database
npm run sandbox     # the same application on 127.0.0.1:3001, on SQLite loaded from sandbox.db
```

- No source file of the application is edited. `init-nest` writes the database file, two small files under `.local-db-sandbox/`, and the `sandbox` script (`node .local-db-sandbox/sandbox.server.ts --watch`) in `package.json`. A script of that name that the project wrote itself is left alone and the command is printed instead.
- The sandbox process runs the application's own entry point, so the global prefix, CORS, pipes, filters, interceptors, middleware, Swagger setup, and everything else `main.ts` does are the same code, not a copy. TypeScript is compiled on the fly with the project's own `typescript` and `tsconfig.json`.
- Before the entry point is loaded, `TypeOrmModule.forRoot()` / `forRootAsync()` are replaced, so the application's database options are never read. The `DataSource` the application receives is a real TypeORM `DataSource` using TypeORM's SQLite dialect, connected to the sandbox's runtime. Repositories, the entity manager, transactions, relations, and QueryBuilder are TypeORM's own and generate the SQL themselves. Any other `DataSource` that tries to connect fails with an error instead of connecting.
- `app.listen(...)` is redirected to the sandbox port, whatever port the entry point asks for, and to `127.0.0.1`, whatever host it asks for (`app.listen(port)` alone would listen on every interface): the sandbox is reached from this machine only. Where the server then listens is checked, and a sandbox that is not on `127.0.0.1` is stopped with an error rather than run. The port is stored in `.local-db-sandbox/sandbox.config.json`; change it there or with `init-nest --port <number>`. The original server's port, host, and configuration are not touched.
- A table is created for every entity class the application loads. Run `init-nest` again after adding entities; existing data is kept. Before that, `local-db-sandbox diff-schema sandbox.db .` shows what the changed entities change in the database, and writes nothing; see [TypeORM entities as a side](#typeorm-entities-as-a-side).
- `init-nest` options: `--port`, `--out <path>` (the database: a directory, or a single file when the path ends in `.json`; default the project's database, or the directory `sandbox.db` in the project root), `--entities <path>` (where to read entities from, default the entry point's folder).
- `.local-db-sandbox/sandbox.config.json` also accepts `"persistence": "memory"` (discard changes when the server stops; default `"json"`), `"sqlLog"` (see [SQL logs](#sql-logs)), `"watch"` (see [Hot reload](#hot-reload)), `"maxFileSizeMb"`, `"smtp"` (see [Mail capture](#mail-capture)), and `"network"` (see [Network guard](#network-guard)).

Refused, with a message, rather than started half-configured:

- an entry point that does not itself call `NestFactory.create(<RootModule>)` and `app.listen()` (for example one that delegates to another file), or that creates a microservice;
- a project without `TypeOrmModule.forRoot()` / `forRootAsync()`, or one that creates its own `DataSource`;
- named or multiple data sources;
- an entity column type with no SQLite counterpart, and a JSON file whose rows do not fit the entities (unknown fields, missing required values, broken references).

Not replaced: anything other than TypeORM that the application connects to (caches, message brokers, other HTTP services), and whatever the entry point does at startup. `connectMicroservice()` is reported as a warning. Mail can be captured locally, and connections that leave the machine can be reported or refused, when the configuration asks for it; see [Mail capture](#mail-capture) and [Network guard](#network-guard).

**Only the database is replaced, and the sandbox says so.** Each time it starts, before the application is loaded, it says what else is kept on this machine. With nothing configured, that is nothing:

```text
Local DB Sandbox: SMTP capture is off. The application sends its mail wherever its own settings say.
Local DB Sandbox: network guard is off ("allow"). TCP connections that leave this machine are opened, and are not reported.
Warning: nothing keeps this application from real services. Its mail and its calls to other services go where its own settings say, and may reach real ones.
  To keep mail on this machine: "smtp": { "mode": "capture", "env": { "SMTP_HOST": "{host}", "SMTP_PORT": "{port}" } }, with the names your application reads.
  To report connections that leave this machine, or to refuse them: "network": { "mode": "warn" } or { "mode": "block" }.
  Both are set in .local-db-sandbox/sandbox.config.json. The network guard is a development aid, not a security boundary.
```

- The warning stays for as long as mail or connections can reach real services, at every start and after every restart. It is gone when the guard is `block`: what leaves this machine is then refused, a mail server included. The hosts that `allow` lets through are still reached; the guard's own line names them.
- With mail captured and the guard at `allow`, it says that the application's calls to other services are still real. With `warn`, it says that such connections are reported and still opened. A capture that no environment variable leads the application to (`smtp.env` is empty) counts as mail that is not kept here.
- It turns nothing on. The sandbox changes neither your `.env` nor what the application may connect to unless `sandbox.config.json` says so.

### Hot reload

`npm run sandbox` runs `node .local-db-sandbox/sandbox.server.ts --watch`: a small watcher that runs the sandbox server as a child process and restarts it when the application's source changes.

```text
[sandbox] watching src for changes; the sandbox restarts when a source file changes
Local DB Sandbox: application running at http://127.0.0.1:3001
[sandbox] src/users/users.service.ts changed; restarting
Local DB Sandbox: application running at http://127.0.0.1:3001
```

- A restart stops the old process, waits until it has exited (so the port is free), and starts a new one. There is never more than one sandbox process; a burst of changes is collected for 150 ms and leads to one restart.
- Each start loads the current sources and rebuilds the SQLite database from the current database (`sandbox.db`). Every committed change was already saved to it, so the data survives. The database is never regenerated or cleared by a restart. With `"persistence": "memory"`, each restart starts again from the file.
- Watched: the entry point's folder (for example `src/`), recursively, and `package.json`, `nest-cli.json`, `tsconfig*.json`, and `.env*` in the project root. Add other folders, relative to the config file, with `"watch": ["../libs"]` in `sandbox.config.json`.
- A restart needs a real change: a watched file was added or removed, or its modification time or size is different. Reading or opening a file does not restart the sandbox, although Windows reports the first read of a file in about an hour as a change (NTFS writes the last-access time). Setting a new modification time without changing the content (`touch src/main.ts`) does restart; use it to ask for a restart. A tool that rewrites a file to the same size and then restores the old modification time is not noticed.
- Ignored: the database itself (a file or a directory) and its owner record, `node_modules`, `.git`, `dist`, `build`, `coverage`, `.local-db-sandbox`, `.idea`, `.vscode`, and editor leftovers. Changing `sandbox.config.json` or the database by hand does not restart the sandbox; stop and start it.
- If the application fails to start (for example a syntax error), the watcher keeps running and starts it again with the next change.
- Ctrl+C (SIGINT) or SIGTERM stops the watcher and the sandbox process. If the watcher is killed outright, the sandbox process notices and exits by itself.
- The sandbox process has its database to itself while it runs, and says so in a small file beside it (`sandbox.db.owner.json`, which the watcher ignores). To look into the database of the running sandbox, start [Local DB Studio](#local-db-studio-experimental) on it: `npx local-db-sandbox studio sandbox.db`. Studio asks the sandbox process, and finds the new one after every restart.
- Without watching, for CI and tests: `node .local-db-sandbox/sandbox.server.ts`. It starts the sandbox once, in that process.

### SQL logs

In this mode the log shows the SQL that SQLite actually executed. Choose how much with `"sqlLog"` in `sandbox.config.json`, or for one run with `npm run sandbox -- --sql-log=verbose`.

| Mode | Output |
|---|---|
| `off` | Nothing about SQL. |
| `summary` (default) | One line per statement: request, number within the request, time, operation, tables, rows. |
| `verbose` | A block per statement with the SQL text, the bound parameters, the row counts, the returned rows, the time, and the error; and one line per finished HTTP request. |

```text
# summary
[3f9c2a1e #1] 0.3ms SELECT users,user_settings,roles rows=1
[3f9c2a1e #2] 0.2ms SELECT products rows=4

# verbose
[3f9c2a1e #1] SELECT users,user_settings,roles
sql: SELECT u.id AS "userId", r."name" AS "role" FROM "users" "u" LEFT JOIN "user_settings" "us" ON us."userId" = u.id LEFT JOIN "roles" "r" ON r.id = us."roleId" WHERE u.id = ?
params: [1]
rows: 1
result: [{"userId":1,"role":null}]
time: 0.3ms
[3f9c2a1e #2] SELECT products
sql: SELECT ... FROM "products" "p"
params: []
rows: 153
showing: 20
result: [{"id":1,"name":"North"}, ...]
time: 0.2ms
[3f9c2a1e] GET /api/dashboard 403 sqlCount=2 sqlTime=0.5ms total=6.1ms
```

- **One entry per statement.** Entries are never merged or deduplicated. Each carries `[request #n]`, where `n` counts the statements of that request from 1. Several tables on one entry mean one statement that names them all, such as a join: in the example above, entry #1 is a single SELECT with two LEFT JOINs.
- **Nothing is left out.** Every statement TypeORM sends to the runtime is logged, including transaction statements (`BEGIN TRANSACTION`, `COMMIT`, `ROLLBACK`, savepoints), relation-loading queries, QueryBuilder queries, and raw queries; the tests compare the log with TypeORM's own query log. The request line's `sqlCount` is the number of entries printed for that request. Not logged are the sandbox's own bookkeeping statements: loading the file at startup, reading the tables to save the JSON file, and the transaction it wraps around a single statement that is not in one.
- **`background`.** SQL that does not run while handling an HTTP request, such as TypeORM's connection setup, startup queries, and scheduled jobs, is logged with the request `background` and its own numbering.
- **Rows.** `rows` is the number of rows returned and `affected` the number of rows changed. `result` shows the returned rows of SELECT and RETURNING statements as SQLite returned them (booleans as `1`/`0`, dates as text), at most 20 rows; `showing` appears when there were more. Change the limit with `"sqlPreviewRows"` in the config or `--sql-preview-rows=<n>`; `0` shows no row values. Whole result sets are never printed, and text longer than 200 characters is shortened.
- **Requests.** Every HTTP request gets an ID, shared by all SQL it executes, also when requests overlap. A client can supply it in the `x-request-id` header; otherwise a short one is generated. In verbose mode a finished request prints its method, path, status, `sqlCount`, summed SQL time, and total time. The response body is not shown: the sandbox does not intercept responses, so that the application's behaviour is not changed.
- **Verbose logs print bound parameters and returned row values, which are your application's data: passwords, tokens, and personal data included.** Nothing is redacted. Use `verbose` only where that is acceptable. (From code, `redactSqlParameters` and `redactSqlRows` of `startNestSandbox` can replace them before they are printed.)
- Tables are recognized by pattern (after `FROM`, `JOIN`, `INTO`, `UPDATE`), not by parsing SQL, and only when they are tables of the sandbox. A statement whose tables cannot be recognized is shown without them.
- Times are local SQLite execution times, including saving the JSON file at a commit. They say nothing about production database performance.
- The same information is available as structured events: `onSql` and `onRequest` of `startNestSandbox`, or `runtime.subscribe(...)`.

The standalone REST mode is not affected: its log lines remain SQL-like descriptions of operations (see [Logs](#logs)), not executed SQL.

### Mail capture

An application in the sandbox still sends mail through whatever SMTP server its settings name. To keep that mail on your machine, turn on the capture in `.local-db-sandbox/sandbox.config.json`:

```json
{
  "entry": "../src/main.ts",
  "database": "../sandbox.db",
  "port": 3001,
  "smtp": {
    "mode": "capture",
    "port": 2525,
    "env": { "SMTP_HOST": "{host}", "SMTP_PORT": "{port}", "SMTP_SECURE": "false" }
  }
}
```

```text
Local DB Sandbox: SMTP capture on 127.0.0.1:2525. Mail is kept in memory and sent to no one; see it with "local-db-sandbox mail list".
  set for the application, to lead its mail to 127.0.0.1:2525: SMTP_HOST, SMTP_PORT, SMTP_SECURE
Local DB Sandbox: application running at http://127.0.0.1:3001
[3f9c2a1e] SMTP captured id=mail-1 to=test@example.com subject="Verify account"
[background] SMTP captured id=mail-2 to=ops@example.com subject="Nightly report"
```

- **What it is.** A small SMTP server on `127.0.0.1` that accepts whatever the application sends and keeps it in memory. It has no way to send a message on: every address is accepted, nothing is delivered, and the application's mail library is told so (`250 OK: captured as mail-1; not sent to anyone`). The application's code is not changed; it uses its mail library as always.
- **`mode`.** `off` (the default, also when there is no `smtp` at all): the sandbox does nothing about mail, and the application sends it wherever its own settings say; the sandbox says so each time it starts (`SMTP capture is off.`, and a warning unless the network guard refuses what leaves this machine). `capture`: the server is started.
- **`env`.** The capture only helps if the application sends its mail there. `env` names the environment variables to set for the application, under the names *your* application reads; nothing is set that is not listed, and no name is assumed. A capture with no `env` listens, and the sandbox warns at its start that nothing leads the application to it. In a value, `{host}`, `{port}`, and `{url}` (`smtp://127.0.0.1:2525`) stand for where the capture listens; anything else is used as it is. They replace values from the shell and from `.env` (a `.env` loader does not overwrite a variable that is already set). If your application turns on TLS or implicit SSL through a setting, set that to off here as well: the capture speaks plain SMTP.
- **`host`, `port`.** Where it listens: `127.0.0.1:2525` by default; `0` for any free port. Only a loopback address is accepted. The application runs in the sandbox's own process on this machine, so nothing else needs to reach it.
- **Credentials.** The capture does not offer AUTH, so a mail library that has a user and a password configured sends its mail without ever transmitting them. For a client that insists on logging in, `"auth": "accept"` offers AUTH and accepts anything; what is sent is not checked, kept, logged, or used.
- **What is kept.** Sender and recipients as given to the server (so Bcc recipients too), subject, every header, the plain-text and HTML bodies, the time, and for each attachment its name, type, and size. Attachment content is measured and dropped. Nothing in a message is fetched, rendered, or run. At most 500 messages are kept (`"maxMessages"`), the newest; a message may be up to 25 MB.
- **Requests.** Each message carries the ID of the HTTP request the application was handling when it sent it, the same ID the SQL log shows, or `background` for mail that no request sent (startup, scheduled jobs). This is exact for a mail library that opens a connection per message, which is Nodemailer's default. On a connection that is kept open (a pooled transport), only the first message has a request; later ones are `unknown`, because what such a transport does on its connection cannot be told apart by request.

```sh
npx local-db-sandbox mail list             # what was captured
npx local-db-sandbox mail show mail-1      # one message
npx local-db-sandbox mail clear            # forget them
```

```text
ID      Captured                 From             To                    Subject         Request
mail-1  2026-10-06 08:15:30 UTC  app@example.com  test@example.com      Verify account  3f9c2a1e
mail-2  2026-10-06 08:16:02 UTC  app@example.com  ada@example.com (+3)  Your invoice    9b01c7d4
(2 messages)

ID:        mail-2
Captured:  2026-10-06 08:16:02 UTC
Request:   9b01c7d4
From:      The App <app@example.com>
To:        ada@example.com, bo@example.org
Cc:        cy@example.net
Subject:   Your invoice
Envelope:  app@example.com -> ada@example.com, bo@example.org, cy@example.net, hidden@example.com
Size:      28.4 KB (29,102 bytes)
Attachments:
  invoice.pdf  application/pdf  20.0 KB (20,480 bytes)
Text:
  Hello Ada,
  ...
HTML:      1.2 KB (1,204 bytes) (print it with --html)
```

- Run the command in the project (it finds `.local-db-sandbox/sandbox.config.json` there or above), or name the configuration with `--config`. It talks to the running sandbox; mail is not written to disk.
- `show` prints the first 20 lines of the text body; `--text` and `--html` print a whole body, `--headers` adds every header, and `--json` prints everything that was kept. Attachment content is not kept, so it is never printed. Control characters in a message are shown as `\x1b` and not sent to the terminal.
- **Restarts.** With `npm run sandbox` (watch mode) the capture belongs to the watcher, not to the application's process. When a source change restarts the application, the capture keeps listening on the same port, the captured mail stays, and the numbering goes on: no message is lost and none is captured twice. A message whose transfer was cut off by the restart was never accepted and is not there. The mailbox ends when you stop `npm run sandbox`. Without `--watch`, it ends with that one process.
- Changing `smtp` in the configuration needs `npm run sandbox` to be stopped and started.

### Network guard

Mail is one way out of a sandbox. A payment API, a cache, or the production database of a second data source are others. The guard looks at every TCP connection the application's process opens:

```json
{ "network": { "mode": "block", "allow": ["search.internal:9200", "*.svc.test"] } }
```

| `mode` | A connection that leaves this machine is |
|---|---|
| `allow` (default) | opened. Nothing is looked at. The sandbox says at its start that the guard is off, and warns that the application's calls to other services are real. |
| `warn` | opened, and reported in the log. The warning at the start stays: a connection that is reported is still opened. |
| `block` | refused before it is opened. The application gets an error with the code `ESANDBOXNETWORK`. |

```text
Local DB Sandbox: network guard "block": TCP connections that leave this machine are refused, except to search.internal:9200, *.svc.test. It is a development aid, not a security boundary.
[3f9c2a1e] NETWORK blocked: the connection to api.payments.example:443 (https) was refused before it was opened
[9b01c7d4] NETWORK blocked: the name smtp.mail-provider.example was not looked up, so nothing connects to it
```

- **This machine is always allowed:** `localhost`, `127.x.x.x`, `::1`. So are the hosts listed in `allow`, as `host`, `host:port`, or `*.domain`.
- **Refused means nothing left the process.** The connection is stopped while it is still a call. In `block` mode a name that could not be connected to is not looked up either, so a request fails at once and does not wait for a server that cannot be reached.
- **Each report says** the host, the port, what usually speaks on that port (a hint from the port number), and the request that tried.
- **It is a development aid, not a security boundary.** It covers what goes through Node's own `net` and `dns` modules in the application's process: `http`, `https`, `fetch`, TLS, and the clients built on them. It does not cover UDP, DNS queries other than the look-ups of `dns` (`lookup`, `resolve`, `resolve4`, `resolve6`), worker threads, child processes, or native code that opens sockets itself, and code that means to get around it can. Do not rely on it to contain code you do not trust.
- It emulates nothing. A blocked Redis, S3, or HTTP API is an error for the application, not a stand-in.

### What to expect from the SQLite runtime

- It is SQLite, not your production database. SQL generated by TypeORM is generated for SQLite and works. SQL you wrote by hand for PostgreSQL or MySQL (`ILIKE`, `::` casts, `now()`, JSON operators other than `->` and `->>`, which SQLite has with its own rules, `FOR UPDATE`) is not translated: it fails with `SandboxDialectUnsupportedError`. Raw SQL defaults such as `default: () => "now()"` fail the same way on insert. There are two exceptions, both in docs/COMPATIBILITY.md. The spelling of parameters: `$1`, `$2`, ... in hand-written SQL are bound to the parameter array as on PostgreSQL ("Parameter placeholders"). And one function: `TO_CHAR(date, 'YYYY-MM-DD')` works for dates and date-times with numeric patterns, so that reports grouped by day or month run ("TO_CHAR for dates"); other patterns, and numbers, are refused.
- Common PostgreSQL and MySQL column types (`timestamptz`, `jsonb`, `enum`, `uuid`, `bytea`, arrays, ...) are mapped to SQLite ones, and entities come back with the values your application gets in production: booleans, `Date`s, JSON values, `bigint` and `decimal` as text, binary data as a `Buffer`. Raw results (`DataSource.query`, `getRawOne`, `getRawMany`) are not converted on any database and hold SQLite's values here: `1` / `0`, date-time text, JSON text. Decimals are floating point (about 15 significant digits), `LIKE` is case-insensitive, and there are no row locks or isolation levels. The table of every type is in docs/COMPATIBILITY.md, "Column types and values".
- Primary keys of any name, composite keys, `NOT NULL`, static defaults, and foreign keys are real constraints. Unique constraints and indexes are not created. Many-to-many join tables, embedded columns, views, and table inheritance have no tables.
- Transactions are SQLite transactions. The JSON file is written just before each commit; a commit that would take the file above the size limit is refused and rolled back.
- The application's naming strategy, subscribers, and migrations are not used.
- Timings in SQL logs are local SQLite timings and say nothing about production database performance.

### Switching in the root module instead

The same replacement is available as a module, for projects that prefer an explicit switch in code. Create the file once (`npx local-db-sandbox import-typeorm src --out sandbox.db.json`), then, in the one place where the database connection is configured:

```ts
import { SandboxModule } from "local-db-sandbox";

@Module({
  imports: [
    process.env.DB_SANDBOX === "1"
      ? SandboxModule.forRoot({ file: "./sandbox.db.json", entities: [User, Order] })
      : TypeOrmModule.forRoot({ /* the real database */ }),
    UsersModule,
  ],
})
export class AppModule {}
```

- Feature modules keep `TypeOrmModule.forFeature([User])` and services keep `@InjectRepository(User) private users: Repository<User>`. `SandboxModule` is global and provides TypeORM's `DataSource` and `EntityManager`, connected to the SQLite runtime, and a repository under each `@InjectRepository` token (default data source only).
- `entities` lists the entity classes to create tables for. `typeorm` is loaded from the current working directory, or pass it as `typeorm: require("typeorm")`.
- The runtime is injectable as `SANDBOX_RUNTIME`, for example to subscribe to SQL events.
- Without NestJS: `const { dataSource } = await createSandboxDataSource({ file, entities }); dataSource.getRepository(User)`.
- The application starts as it always does, so it listens where its own `app.listen(...)` says: the module replaces the database, not the server. Give `app.listen` the host `127.0.0.1` to keep it on this machine; the generated sandbox server (`init-nest`) does that by itself.

NestJS, TypeORM, and TypeScript are not dependencies of this package; the application's own copies are used. SQLite is Node's built-in `node:sqlite`.

## SQL Console (experimental)

Inspect or change a database file with SQL, without touching application code:

```sh
npx local-db-sandbox sql sandbox.db.json                          # interactive console
npx local-db-sandbox sql sandbox.db.json "SELECT * FROM users"    # run and exit
npx local-db-sandbox sql sandbox.db.json --file query.sql         # run a file and exit
```

```text
sql> SELECT id, name, active FROM users
...> WHERE active = 1;
id  name  active
--  ----  ------
1   Ada   1
(1 row, 0.2 ms)
sql> UPDATE users SET name = 'Ada L.' WHERE id = 1;
1 row affected (0.9 ms)
sql> .tables
table   rows  columns from
------  ----  ------------
users   2     entities
orders  1     entities
```

The file is loaded into the same SQLite runtime the NestJS mode uses, and the SQL is executed by SQLite. It is real SQLite SQL: joins, aggregates, subqueries, and SQLite's functions work; other dialects are not translated.

- **Statements** end with a semicolon and may span several lines. In a file or a one-shot argument, several statements run in order and running stops at the first error (exit code 1); the last one does not need a semicolon. In the console, an error is printed and the console stays open.
- **Console commands:** `.tables`, `.schema [table]`, `.help`, `.exit` / `.quit`. They are written on a line of their own.
- **Saving:** each statement outside a transaction is committed and saved to the file on its own. `BEGIN` ... `COMMIT` saves once, at the commit; `ROLLBACK`, or leaving with a transaction still open, saves nothing and leaves the file byte-identical. The file is replaced atomically, `$config` is kept, and the [size limits](#size-limits) apply: a change that would take the file above the limit is refused and rolled back.
- **Output:** queries print column headers, rows, the row count, and the local execution time. INSERT, UPDATE, and DELETE print the rows affected. Values are shown as SQLite holds them: booleans as `1`/`0`, dates as `YYYY-MM-DD HH:MM:SS.SSS` text, JSON as text. The file keeps its JSON values.

| Option | Effect |
|---|---|
| `--file <file>` | Run the statements in a file. |
| `--read-only` | Refuse every statement that would change data or schema (enforced by SQLite). |
| `--no-save` | Allow changes, but discard them when the command ends. |
| `--json` | Print each result as one line of JSON (`columns`, `rows`, `rowCount`, `affectedRows`, `localExecutionMs`, or `error`). |
| `--sql-log <mode>` | Also log executed statements to stderr: `off` (default), `summary`, `verbose`. |
| `--entities <path>` | Take table definitions from the TypeORM entities in a file or folder. |
| `--no-entities` | Work the table definitions out from the data only. |
| `--max-file-size <MB>` | Largest database file to accept. |

Where the tables' columns come from:

- **From TypeORM entities**, when the file is the database of a project set up with `init-nest` (found through `.local-db-sandbox/sandbox.config.json` next to the file or in the current directory), or when `--entities` is given. Columns, types, keys, and foreign keys are then the ones the NestJS sandbox uses, and empty collections are fully usable. This loads the entity files, as `import-typeorm` does.
- **From the data** otherwise: one column per key that appears in the rows, typed from the values (objects and arrays become JSON text). `id` is the primary key when every row has a different one. An empty collection has no keys to look at and gets an `id` column only, so rows cannot be inserted into it with other columns.

Limits:

- Schema changes (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`) last until the console closes. Only the rows of the tables that were loaded are saved. To keep them, in a copy, use [`simulate`](#try-a-sql-script-on-a-copy-experimental).
- After a write, every row of a table is saved with all of the table's columns, so a key that some rows did not have appears as `null`.
- Statements are split at semicolons with strings, quoted names, and comments taken into account, but SQL is not parsed: a statement with semicolons of its own, such as `CREATE TRIGGER`, is not supported. Columns with the same name in one result (`SELECT a.id, b.id`) need aliases.
- A database that a sandbox has open is that sandbox's: the console is refused it, and is told who has it, since the sandbox holds its own copy and the two would write over each other. With `--read-only` or `--no-save` the console writes nothing to the database, asks no one, and reads the rows as they are stored. To look into the rows of a running sandbox, and change them there, use [Local DB Studio](#local-db-studio-experimental). While a console that may save is open, the database is the console's in the same way.
- Times are local SQLite times and say nothing about production database performance.

## Try a SQL Script on a Copy (experimental)

`simulate` runs a SQL script on a copy of a database, with the rows it has, and leaves the database as it was:

```sh
npx local-db-sandbox simulate ./sandbox.db ./sandbox-scripts/migration.sql
npx local-db-sandbox studio ./sandbox-preview.db
```

```text
OK (0.1 ms)
1 row affected (0.1 ms)
OK (0.1 ms)
1 row affected (0.0 ms)
Simulated: the 4 statements of ./sandbox-scripts/migration.sql ran on a copy of ./sandbox.db. ./sandbox.db was not changed.
Copy: ./sandbox-preview.db
Tables of the copy: column "users"."age" added; table "tags" made.
To look at it:   local-db-sandbox studio ./sandbox-preview.db
                 local-db-sandbox sql ./sandbox-preview.db
To compare:      local-db-sandbox diff-schema ./sandbox.db ./sandbox-preview.db
To discard it:   delete ./sandbox-preview.db
```

The script is run by the sandbox's SQLite, as `sql --file` runs one, and stops at the first error; SQL is not translated. The copy keeps rows, tables made and dropped, and columns added and dropped. Any other change of a table's definition (an index, a view, a trigger, a rename, a CHECK constraint, a type such as `serial` or `timestamptz`) fails its statement, which then changes nothing. When a statement fails, the copy is still written with what the statements before it changed, the command says that it is partial and which statements ran, and exits with 1; a transaction that was not committed is not in it. The copy is `<name>-preview` beside the database, or `--out <path>`; one that is there is not written over without `--replace`, and not while a process has it open. Delete the copy when you are done with it. Keep such scripts in a folder of their own (`sandbox-scripts/` above), not in the project root or a migrations folder: a directory that holds `.sql` files itself is read as migrations by `init` and the schema commands. The rules are in [docs/COMPATIBILITY.md](COMPATIBILITY.md#sql-script-simulation-simulate).

## From PostgreSQL Migrations (experimental)

A project whose schema is a chain of PostgreSQL migrations (Supabase, Flyway, or plain `.sql` files) gets a sandbox database without writing table definitions by hand and without a running database:

```sh
npx local-db-sandbox init .                       # finds supabase/migrations, migrations, db/migrations, ...
npx local-db-sandbox init path/to/migrations --out sandbox.db
```

```text
Read 7 migrations (21 statements) from /project/supabase/migrations
Created /project/.local-db-sandbox/sandbox.db
  assets: 3 columns, 0 rows
  asset_rates: 8 columns, 0 rows
  pair_snapshots: 7 columns, 0 rows
  job_state: 6 columns, 1 row
Statements: 16 applied, 1 inserting rows, 1 kept as information, 9 not reproduced, 0 without effect, 0 unsupported
Not reproduced locally, on purpose:
  row level security and policies: 6 statements
  extensions: 2 statements
  scheduled jobs: 1 statement
Kept as information, not enforced:
  0003_snapshots_and_state.sql:10: Check constraint "job_state_singleton" (id = 1) is kept as information and not enforced locally.
Report: /project/.local-db-sandbox/sandbox.db.report.json
Added to .gitignore: /.local-db-sandbox/sandbox.db/ /.local-db-sandbox/sandbox.db.owner.json /.local-db-sandbox/sandbox.db.owner.lock /.local-db-sandbox/sandbox-preview.db/ /.local-db-sandbox/sandbox.db.report.json
Next steps:
  local-db-sandbox studio                                   look into the rows, and change them
  local-db-sandbox postgrest .local-db-sandbox/sandbox.db   serve the database to supabase-js clients
```

Without an argument, `init` reads the current directory. In a NestJS project, or a directory without migrations, the error says which command is for it (`init-nest`, `init-pg`).

The migrations are read with PostgreSQL's own parser (`libpg-query`) and applied in the order of their version numbers. The database gets the tables they leave: columns, primary and foreign keys, unique constraints, indexes, enumerated types, defaults (including `now()`, computed when a row is written), and the rows the migrations insert. It is a database directory like any other: serve it with `postgrest`, open it with `sql`.

Its `schema.json` also keeps what a later comparison needs: what each column's type is, however the migration spelled it (`integer` and `int4` are one type); the names PostgreSQL gives the keys, constraints, and indexes that a migration does not name (`notes_pkey`, `notes_author_id_fkey`); and the statement each object comes from, with every rename a migration states. See [Schema Diff](#schema-diff-experimental).

What a local database does not hold is reported, never passed over: row level security and policies, roles and grants, extensions, functions, triggers, scheduled jobs (`pg_cron`), and other schemas (`auth`, `storage`) are **not reproduced**; check constraints, index expressions, and defaults such as `gen_random_uuid()` are **kept as information** and not enforced; views, `UPDATE`s in migrations, and similar are **unsupported** and listed (`--strict` refuses them). The full list is in [docs/COMPATIBILITY.md](COMPATIBILITY.md#postgresql-migrations-init); the report file has an entry for every statement, with its file and line.

| Option | Effect |
|---|---|
| `-o`, `--out <directory>` | Database to create (default `.local-db-sandbox/sandbox.db` in the project). |
| `--report <file>` | Where the report goes (default `<database>.report.json`). |
| `--force` | Replace an existing database; its rows are lost. Refused while a process has the database open (a sandbox, an endpoint, Studio): stop that process first. |
| `--strict` | Fail, writing nothing, when a statement is unsupported. |

After adding a migration, `diff-schema` shows what it changes in the database. Applying those changes to a database while keeping its rows is not implemented: re-run `init --force`, which replaces the database.

`init --force` does not replace a database under a process that has it open. A sandbox, an endpoint, or a Studio that runs on the database would go on serving rows that are stored nowhere any more, and could not save. So it is refused, says which process has the database, and changes nothing:

```text
Error: .local-db-sandbox/sandbox.db is open in the PostgREST endpoint (pid 4242, since ...). One process has a database open to write at a time: stop that one first. Nothing was replaced: the database is as it was.
```

Stop that process, and run the command again. There is no switch that replaces the database anyway. A record that a killed process left beside the database is no obstacle: it is taken over, as every sandbox takes it over.

## From a Running PostgreSQL Database (experimental)

When the database itself is the best statement of the schema (a project with entities and migrations both, or a migration history that is not complete), `init-pg` reads the schema from a running PostgreSQL server and creates a sandbox database from it. No migrations and no ORM are needed, and no row is copied.

```sh
PGPASSWORD=... npx local-db-sandbox init-pg postgresql://reader@127.0.0.1:5432/app
npx local-db-sandbox init-pg postgresql://reader@127.0.0.1:5432/app --schema billing --out billing.db
npx local-db-sandbox studio .local-db-sandbox/sandbox.db
```

```text
Read schema "public" of PostgreSQL 18.1 at 127.0.0.1:5432 (database "app", user "reader"): 7 tables, 1 enumerated type
Created /project/.local-db-sandbox/sandbox.db
  customers: 8 columns, 1 unique constraint, 0 rows
  order_lines: 4 columns, 1 unique constraint, 0 rows
  orders: 5 columns, 2 indexes, 0 rows
  products: 6 columns, 1 index, 0 rows
  stock_levels: 4 columns, 0 rows
  tags: 2 columns, 0 rows
  warehouses: 3 columns, 1 unique constraint, 0 rows
  enumerated types: order_state
No rows were read from PostgreSQL: the tables are empty.
Kept as information, not enforced:
  customers.external_id: The default of "customers"."external_id" (gen_random_uuid()) is kept as information: the sandbox does not generate UUIDs, so a row written without one gets none.
  products.products_stock_check: Check constraint "products_stock_check" (stock >= 0) is kept as information and not enforced locally.
  orders_open_idx: Index "orders_open_idx" on "orders" where state <> 'shipped'::order_state is kept as information and not created locally.
  products_title_lower_idx: Unique index "products_title_lower_idx" on "products" over expressions (lower(title)) is kept as information and not created locally; its uniqueness is not enforced.
Report: /project/.local-db-sandbox/sandbox.db.report.json
Added to .gitignore: /.local-db-sandbox/sandbox.db/ /.local-db-sandbox/sandbox.db.owner.json /.local-db-sandbox/sandbox.db.owner.lock /.local-db-sandbox/sandbox-preview.db/ /.local-db-sandbox/sandbox.db.report.json
Next steps:
  local-db-sandbox studio                                   look into the tables, and add rows
  local-db-sandbox postgrest .local-db-sandbox/sandbox.db   serve the database to supabase-js clients
```

`<connection-url>` is `postgresql://<user>@<host>[:<port>]/<database>`, with `?sslmode=disable|prefer|require|verify-ca|verify-full` when needed (default `prefer`: TLS when the server offers it). Give the password in `PGPASSWORD`. One in the URL (`postgresql://reader:secret@...`) is taken too, and the command then says that your shell may keep it in its history. No other parameter of the URL is taken, and no other environment variable chooses the server.

What is read: the tables of the schemas asked for (`public` unless `--schema` says otherwise), their columns with types, nullability, and defaults, `serial` and identity numbering, primary keys, foreign keys, unique constraints, check constraints, indexes, and enumerated types. They go into the database's `schema.json` exactly as `init` puts migrations there: the scan writes the catalog as the statements that would create it, with PostgreSQL's own functions (`format_type`, `pg_get_expr`, `pg_get_constraintdef`, `pg_get_indexdef`), and gives them to the same collector. So types, defaults, keys, and the report mean what they mean for `init`; the statements are in the report (`script`), and its entries refer to their lines.

**Safe by construction.**

- Only the system catalog (`pg_catalog`) is read, with `SELECT`s, in one transaction that is `READ ONLY` (PostgreSQL itself refuses to write in it) and is rolled back. No table of the database is read, so no row leaves it. Nothing is written to PostgreSQL, and no migration or DDL is run there.
- Connecting may take 10 seconds (`--connect-timeout`), and each catalog query 30 (`--query-timeout`); the server is told the same limit (`statement_timeout`, `lock_timeout`), and the command closes the connection itself when the server does not answer.
- The connection string and the password are never printed, logged, or written into the database or the report. Messages and the report name the host, port, database, and user.
- Use a read-only role. It needs to connect to the database and to use the schemas it reads (`USAGE`, which gives no access to rows), and nothing else. The scan reads `pg_catalog`, not `information_schema`, because `information_schema` hides constraints from a role that has no privileges on their tables, which would leave tables without keys:

```sql
CREATE ROLE sandbox_reader LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE app TO sandbox_reader;
GRANT USAGE ON SCHEMA public TO sandbox_reader;   -- every role has this on public by default
```

**One namespace.** A sandbox database has no schemas: tables are named without theirs. With several `--schema`, two schemas that have an object of the same name (a table, an index, an enumerated type) are refused, and every such name is listed; read them one at a time into databases of their own. What refers outside the schemas that are read is said, not followed: a foreign key to a table that is not read is not reproduced, and a type of a schema that is not read is kept as PostgreSQL's own and stored as given.

**Left out, and said so:** PostgreSQL's own schemas (`pg_catalog`, `information_schema`, `pg_*`; asking for one is refused), objects that belong to an extension, views and materialized views, foreign tables, partitions (a partitioned table is created as one ordinary table), row level security, triggers, and indexes that are not valid. Exclusion constraints are unsupported; types the sandbox does not know (`point`, ranges, domains) are kept as information and stored as given. `--strict` refuses to write when anything is unsupported.

| Option | Effect |
|---|---|
| `-s`, `--schema <name>` | A schema to read; repeat for more (default `public`). |
| `-o`, `--out <directory>` | Database to create (default `.local-db-sandbox/sandbox.db` in the current directory). |
| `--report <file>` | Where the report goes (default `<database>.report.json`). |
| `--force` | Replace an existing database; its rows are lost. Refused while a process has the database open. A scan that fails replaces nothing. |
| `--strict` | Fail, writing nothing, when part of the schema is unsupported. |
| `--connect-timeout <seconds>` | How long connecting may take (default 10). |
| `--query-timeout <seconds>` | How long each catalog query may take (default 30). |
| `--max-file-size <MB>` | Largest database to accept. |

Limits: targets PostgreSQL 12 and later, and has been tested on PostgreSQL 18.6 only (see [docs/COMPATIBILITY.md](COMPATIBILITY.md#postgresql-catalog-scan-init-pg)); `sslmode=require` against a server without TLS fails with a message that says so; TCP only (no Unix socket), one host; no rows (there is no option to copy them); a scanned database is not kept in step with its source, so run `init-pg --force` again after the source changed. The rules are in [docs/COMPATIBILITY.md](COMPATIBILITY.md#postgresql-catalog-scan-init-pg).

## The Project's .gitignore

After `init`, `init-pg`, or `init-nest` succeeds, the paths it generated are added to the `.gitignore` at the root of the project's Git repository, so that local databases are not committed by mistake:

```text
# Local DB Sandbox: local databases and runtime files (added by local-db-sandbox)
/.local-db-sandbox/sandbox.db/
/.local-db-sandbox/sandbox.db.owner.json
/.local-db-sandbox/sandbox.db.owner.lock
/.local-db-sandbox/sandbox-preview.db/
/.local-db-sandbox/sandbox.db.report.json
```

- Only what the command generated: the database (a directory or a single file, wherever `--out` put it), the record of the process that has it open (`.owner.json`, `.owner.lock`), the copy `simulate` writes beside it, and the report of `init` and `init-pg`. Each rule is the path from the repository's root, so no other `.db`, `.json`, or `.sql` file is matched. The sandbox's configuration (`.local-db-sandbox/sandbox.config.json`, `sandbox.server.ts`) is not ignored: you may want to share it.
- Your file is kept as it was: its comments, rules, and line ends. The rules go at its end, under one comment line, or under that line when an earlier run wrote it. A rule is not added twice, and not at all when Git ignores the path already by a rule of your own (asked of Git with `git check-ignore`, when Git is installed).
- Nothing is written when the project is not in a Git repository, when the database is outside the project's repository, when the command failed, or with `--no-gitignore`; the command says which. A `.gitignore` that cannot be written is a warning: the database is made.
- A generated path that Git tracks already is named, with the command that stops tracking it (`git rm -r --cached <path>`); nothing is taken out of Git for you.

## Schema Diff (experimental)

`diff-schema` says what differs between two schemas. It only reads: neither side is changed, and no SQL is generated.

```sh
npx local-db-sandbox diff-schema .local-db-sandbox/sandbox.db .   # the database, and what the project's migrations make now
npx local-db-sandbox diff-schema old/migrations new/migrations    # two sets of migrations
npx local-db-sandbox diff-schema sandbox.db other.db --json       # the diff as JSON
npx local-db-sandbox diff-schema sandbox.db .                     # a NestJS project: its database, and what its entities are now
```

```text
Before: old/migrations (PostgreSQL migrations, 3 files)
After:  new/migrations (PostgreSQL migrations, 7 files)
10 changes:
  ~ column asset_rates.rate renamed to reference_rate (0004_liquidity.sql:6)
  + column asset_rates.high_ratio numeric
  + column asset_rates.input_volume numeric not null default 0
  + column asset_rates.low_ratio numeric
  + column asset_rates.output_volume numeric not null default 0
  + column job_state.label text
  + column job_state.label_found_at timestamp with time zone
  + column job_state.label_source text
  + column pair_snapshots.stock_a numeric not null default 0
  + column pair_snapshots.stock_b numeric not null default 0
```

Each side is one of:

| Given | Compared |
|---|---|
| a database directory (its `manifest.json` states a format), or a single-file database | the table definitions it stores (a database without any is refused: they are not worked out from rows) |
| a schema file | a schema document, such as a database directory's `schema.json` or a copy of it |
| a directory of `.sql` migrations, or a project that has one where `init` looks | the schema those PostgreSQL migrations leave, collected as `init` collects it. Migrations are read as a whole: one `.sql` file is refused. A directory that holds `.sql` files itself is read as migrations, whatever else is in it: a stray `.sql` file in a project root makes the root the migrations |
| a NestJS + TypeORM project, a folder of entity files, or one entity file | the schema of those TypeORM entities, collected as `init-nest` collects it; see [TypeORM entities as a side](#typeorm-entities-as-a-side) |

What it compares, and how:

- **Tables, columns, types, nullability, defaults, primary keys, unique constraints, foreign keys with their actions, indexes, check constraints, and enumerated types with their values.**
- **By meaning, not by spelling.** `integer` and `int4` are one type, `varchar(50)` and `varchar(100)` are not; `now()` and `current_timestamp` are one default. Where a schema does not say what a type is (one written by hand, or made from TypeORM entities), the declared spellings are compared, and the line says so.
- **A rename is a rename only when the schemas say so.** A migration renamed the object (`ALTER TABLE ... RENAME`), and both sides know the statement that created it. Then the line names the migration and the line of the rename. A different name without that is a drop and an add, however alike the two are: nothing is matched by similarity.
- **Where a schema comes from is not a difference.** Squashed migrations and the chain they replace give the same schema.
- **The order is fixed, and can be carried out.** What goes comes first (foreign keys, constraints, and indexes, then columns and tables), then the renames, then what comes and what changes, with new keys, constraints, indexes, and foreign keys last; within a kind by table and name. A drop names things as the before side calls them, everything after the renames as the after side does. It does not depend on the order in which a schema lists things.
- **A dropped object is never the one that takes its name.** When a column is dropped and another is renamed to its name, that is a drop and a rename, and the keys and indexes of the two are not taken for the same.
- **An index and a constraint are what they are beyond their columns.** An index of another method (`USING gin`), with its keys in another order or direction, with another operator class or collation, or carrying other columns along (`INCLUDE`) is another index; a constraint that is deferrable, or is not, is another constraint. The one goes and the other comes.
- **Two expressions that read alike are compared by what they name.** A schema from migrations says what the text of a check, an index's expression, or a default names, and what each of those things is called now. A check over a column that is renamed is the check it was, and the diff is the rename alone. A check that reads the same and is over another column, which has taken the name, is another check: the first goes before the rename and the second comes after it.

`--json` prints the diff alone, as data (`{ "diffVersion": 1, "changes": [ ... ] }`): each change has an `op` (`renameColumn`, `addColumn`, `alterColumnType`, `dropForeignKey`, ...), the names it concerns, and what the object was or is. The same two schemas give the same bytes every time, wherever they are stored. It says what changed, not how to change it.

| Option | Effect |
|---|---|
| `--json` | Print the diff as JSON, and nothing else. |
| `--max-file-size <MB>` | Largest database or schema file to read. |

The command exits with 0 when the two were compared, with or without differences, and with 1 when a side could not be read. Notes (a database of an earlier format; migrations with statements the collector does not support; what entities declare that was not read) go to stderr. A note and an error say which of the two they are about (`<before>`, `<after>`) and where it is.

### TypeORM entities as a side

For a NestJS + TypeORM project, the three schema commands read the entities themselves, so that a change of an entity can be looked at before anything is written:

```sh
npx local-db-sandbox diff-schema ./sandbox.db ./my-nest-project
npx local-db-sandbox plan-migration ./sandbox.db ./my-nest-project
npx local-db-sandbox generate-migration ./sandbox.db ./my-nest-project --dialect postgres
```

```text
Before: ./sandbox.db (database directory)
After:  ./my-nest-project (TypeORM entities in src, 3 tables)
3 changes:
  - column users.active
  + table tag (2 columns, primary key (id))
  + column users.nickname varchar(40)
```

A database that `init-nest` made and the project it was made from do not differ until an entity changes. Entities can be either side, or both.

| Given | Where the entities are read from |
|---|---|
| a NestJS project that `init-nest` set up | the folder of the entry point that `.local-db-sandbox/sandbox.config.json` names |
| a NestJS project that was not set up | the folder of its entry point, where NestJS has it: `sourceRoot` and `entryFile` of `nest-cli.json`, or `src/main.ts` |
| a folder of entity files | that folder, and the folders in it |
| one entity file (`.ts`, `.js`, ...) | that file |

- **Nothing of the application is started.** Only files that declare an entity (they import `typeorm` and name `@Entity`) are loaded, with what they import, and TypeORM's own metadata of them is read. The entry point, the modules, the `TypeOrmModule.forRoot` settings, and the services are not loaded; no data source is made, and no database is connected to. A source file that declares no entity is refused when it is given, and not run.
- **No connection leaves this machine while they are loaded.** The [network guard](#network-guard) refuses one, and the command then fails and says where the connection was to go: an entity file, or a file it imports, opens it when it is loaded. The guard is a development aid, not a security boundary; loading an entity file still runs that file.
- **A project with migrations and entities both is asked which.** `Error: ... has PostgreSQL migrations (supabase/migrations) and TypeORM entities (src) both. Give the one to compare.` Give that folder. A directory that holds the `.sql` files itself is migrations, as it always was.
- **Entities say less than a database.** No indexes and no unique or check constraints are read from them, and not every default (the one a database gives a `@CreateDateColumn`; a default that is an expression), table (a join table of `@ManyToMany`; an entity that was skipped), column (an embedded one), and key. What was left out of the tables, columns, and keys is noted when the entities are read. Compared with a side that says more, such a thing is listed as dropped or added, and a note says how many of the changes may only be that.
- **`generate-migration` writes no SQL for such a change.** A migration made of it could drop what the application still has. It names the steps, and the comparison that has none: the project with the database `init-nest` made of it, or two sets of entities.

What is refused, each with its own message: a project whose entities are not found (no `init-nest` configuration and no entry point where NestJS has it; give the folder of the entity files); a project whose packages are not installed; a place with no entity file, or with none that can be read (nothing is compared with an empty schema); entity files that fail to load, with the file and the reason; and a project with migrations and entities both.

Limits: entities are read as TypeORM's PostgreSQL driver reads their declarations (D-040), so a type that PostgreSQL does not have (`datetime`, `tinyint`) has no canonical type, is compared as declared, and is refused by the generator; a single-file database stores no table definitions, so a database to compare with is a database directory; an entity file is read once per run, as it is on disk; and `EntitySchema`, table inheritance, embedded columns, join tables, and relations with several join columns are not read, as for `init-nest`.

Limits: a rename can only be told while the migration file that created the object is unchanged, since an object is identified by its statement and the file's hash; comparing a newer schema with an older one reports a drop and an add where the other direction reports a rename; within one kind of change the order is by name, so tables that are dropped together and refer to each other, renames that pass a name on, and several changes to one enumerated type's values need care when a diff is carried out; and generating migrations from a diff, or applying one to a database, is not implemented. The rules are in [docs/COMPATIBILITY.md](COMPATIBILITY.md#schema-diff-diff-schema).

## Migration Plan (experimental)

`plan-migration` says in which steps the differences between two schemas would be carried out. It reads the two as `diff-schema` does, [TypeORM entities](#typeorm-entities-as-a-side) among them. It carries nothing out and generates no SQL: it shows what the planner makes of a diff.

```sh
npx local-db-sandbox plan-migration .local-db-sandbox/sandbox.db .   # the database, and what the project's migrations make now
npx local-db-sandbox plan-migration old/migrations new/migrations --json
npx local-db-sandbox plan-migration sandbox.db .                     # a NestJS project: its database, and what its entities are now
```

```text
Before: old/migrations (PostgreSQL migrations, 1 file)
After:  new/migrations (PostgreSQL migrations, 2 files)
3 steps:
  1. ~ table a renamed to migration_tmp_1 [planner: rename-cycle]
  2. ~ table b renamed to a (0002_exchange.sql:2)
  3. ~ table migration_tmp_1 renamed to b (0002_exchange.sql:3)
```

A diff says what changed. A plan says how that is carried out:

- **The steps are the diff's changes, in an order in which each can be taken when its turn comes.** A table is dropped when no foreign key refers to it any more, a name is taken when it is free, a value is added to a type when the value it is put next to is there. The order does not come from the names of things.
- **The plan adds the steps such an order needs**, and says why. `rename-cycle`: names are exchanged or passed round, so one object is first renamed to a temporary name (`migration_tmp_1`, ...; never a name that either schema has). `tables-dropped-together`: tables that are dropped refer to each other, so a foreign key between them is dropped first.
- **A step says things as they are at that step**: the names things have then, and what the thing is then.
- **One diff has one plan.** The same two schemas give the same plan, to the byte with `--json`, in whatever order they list their objects.
- **What cannot be carried out is refused**, with the step and the reason, such as a schema with a foreign key to a table that is not there. So is a key that the schema to arrive at leaves without a name while another constraint of its table takes the name it had: in a database the key needs a name, so give it one there.

`--json` prints the plan alone: `{ "version": 1, "steps": [ ... ] }`, each step a change as `diff-schema --json` writes it. The command exits with 0 when a plan was made, and with 1 when one of the two could not be read or their differences cannot be planned.

Limits: a plan has no SQL in it, and nothing is applied to a database. It follows the rules that databases share; what PostgreSQL refuses beyond them (a key dropped while a foreign key of a table that stays rests on it) is met by the PostgreSQL generator, below, not by the plan. It says nothing about rows. The rules are in [docs/COMPATIBILITY.md](COMPATIBILITY.md#migration-plan-plan-migration).

## PostgreSQL Migration (experimental)

`generate-migration` writes the differences between two schemas as a migration for PostgreSQL: the steps that `plan-migration` shows, each as the statements PostgreSQL carries it out with. It connects to no database and carries nothing out. The migration is printed, or written to a file you name. Read it before you run it.

Status: the schema diff, the migration plan, and this generator are complete and frozen (M4). They stay experimental. Generation is offline: none of these commands connects to a database or runs a migration, and none will do so as a side effect. The one command that connects to a database server is `init-pg`, which reads its catalog in a read-only transaction ([From a Running PostgreSQL Database](#from-a-running-postgresql-database-experimental)).

```sh
npx local-db-sandbox generate-migration .local-db-sandbox/sandbox.db . --dialect postgres   # the database, and what the project's migrations make now
npx local-db-sandbox generate-migration old/migrations new/migrations --dialect postgres --out 0003_next.sql
npx local-db-sandbox generate-migration old.schema.json new.schema.json --dialect postgres --json
npx local-db-sandbox generate-migration sandbox.db . --dialect postgres                     # a NestJS project: its database, and what its entities are now
```

Where a side is [TypeORM entities](#typeorm-entities-as-a-side), a step that is there only because the entities lack what they do not say (an index, a unique or check constraint, a default, table, column, or key that was not read) is not written: no migration is generated while the plan has one, and the steps are named.

```sql
-- PostgreSQL migration: 5 statements in 3 segments.
-- It is not one transaction: what a segment did stays when a later segment fails.
-- Run it with a client that sends each statement on its own and adds no transaction of its own (psql -f).

-- Segment 1 of 3: one transaction.
BEGIN;

-- Step 1. The rows it holds are lost.
DROP TABLE "drafts";
ALTER TABLE "orders" RENAME COLUMN "note" TO "remark";

COMMIT;

-- Segment 2 of 3: outside a transaction, each statement on its own.
-- A value added to an enumerated type cannot be used before it is committed.
ALTER TYPE "order_status" ADD VALUE 'refunded' AFTER 'paid';

-- Segment 3 of 3: one transaction.
BEGIN;

ALTER TABLE "orders" ADD COLUMN "refunded_at" timestamp with time zone;
CREATE INDEX "orders_status_idx" ON "orders" ("status") WHERE (status = 'refunded');

COMMIT;
```

A diff says what changed, a plan in which steps it is carried out in any database, and a PostgreSQL migration in which statements and transactions PostgreSQL does it:

- **It writes the plan, and puts no step in another place.** What PostgreSQL needs beyond a step is added as statements that say why: a foreign key is dropped before the key it rests on and added again at the end; an enumerated type that is in the way of a table's name is renamed away until it is dropped; to take a value out of an enumerated type, or to reorder its values, the type is made again; a default that is a value of an enumerated type is taken off while its column's type changes.
- **Every step is one of four, and a migration is written only when none is refused.**

| Class | Means | Written |
|---|---|---|
| `safe` | every row stays as it is, and the statement cannot fail because of the rows, or it is a key, constraint, or index, which PostgreSQL checks against them | yes |
| `requiresDataMigration` | whether it can be carried out depends on the rows: a column that becomes `NOT NULL`, a `NOT NULL` column added without a default, a type made narrower, a value taken out of an enumerated type | only with `--assume-valid-data`, and marked; PostgreSQL still refuses it as a whole when the rows do not fit |
| `requiresExplicitCast` | a column's type changes, and PostgreSQL has no conversion that is known to keep every value (`text` to `integer`), or the one it has rounds, cuts, or depends on the session's time zone | never: how the values are converted (`USING`) is yours to say |
| `unsupported` | what the schema does not say, or PostgreSQL cannot have: a column without a canonical type, a constraint without a name that is to be dropped, an expression whose text a rename has left behind, an index or a constraint of which the schema only says that there is more to it, a name longer than 63 bytes | never |

- **No backfill and no conversion is made up.** A refusal names every step it is for, with the class, a reason, and a sentence.
- **Names are always quoted, and types are written from what they are** (the canonical type), never from how a source spelled them. An expression (a check, a default, the condition of an index) is the one thing that is copied as its source wrote it, within parentheses of its own.
- **The SQL is given to PostgreSQL's own parser before it is printed**: every statement is one statement, and every copied expression one expression.
- **Transactions are written out.** `BEGIN` and `COMMIT` stand around what is one transaction. A value added to an enumerated type stands outside them, since PostgreSQL does not let it be used before it is committed; such a migration is not one transaction, and says so in its first lines.
- **A statement that drops rows says so**, in a comment and in the JSON. A name that changed without a recorded rename is a drop and an add, as in the diff.

| Option | Effect |
|---|---|
| `--dialect postgres` | The database to write the migration for. Required; PostgreSQL is the one there is. |
| `--assume-valid-data` | Also write the statements that rest on what the rows are, on your word that the rows fit. |
| `--json` | Print what was generated as JSON, and nothing else: every step with its class, and the statements in their segments, each with its parts and its SQL. |
| `--out <file>` | Write the migration to this file instead of printing it. A file that exists is never replaced. |
| `--max-file-size <MB>` | Largest database or schema file to read. |

The command exits with 0 when a migration was generated, and with 1 when one of the two could not be read, their differences cannot be planned, or a step is refused. With `--json` a refusal is printed as data, and the command still exits with 1.

- **An index and a constraint are written with what the schema holds of them**: `USING gin`, the keys in their order with `DESC`, `NULLS FIRST`, an operator class, and a collation, `INCLUDE`, `NULLS NOT DISTINCT`, and `DEFERRABLE INITIALLY DEFERRED`. What the schema only says is there (`MATCH FULL`, storage parameters, `NOT VALID`) is refused, never left out.
- **An expression that a rename has left behind is not written.** A check written as `price > 0` before `price` was renamed is the check PostgreSQL has under the new name: where it stays, only the rename is written. Where it would have to be written again (its table is created from the schema), it is refused, with the names it is stale by: PostgreSQL would refuse the text, or, when another column has taken the name, take it for that column without a word.
- **A schema from TypeORM entities is written too**, from a database directory: each column has the type that TypeORM's own PostgreSQL driver creates for its declaration (`float` is `double precision`, `simple-json` is `text`, an enumerated column is of a type named `<table>_<column>_enum`). A declared type that PostgreSQL does not have (`tinyint`, `datetime`) is refused, not guessed.

Limits: nothing is known of the rows, so nothing is converted or filled in; there is no migration backwards; a migration of several segments is not one transaction; an expression is never rewritten, so one that a rename has left behind is refused where it would have to be written, until its source writes it again; a default has no identity, so one whose text calls a function that was renamed is refused the same way; renames of collations, operator classes, sequences, and schemas are not followed into an expression; what the schema does not hold is not written (sequences; views, functions, triggers, policies); a column without a canonical type (a schema written by hand, a single-file database of entities) is refused wherever a type has to be written; and locks and running time are not considered. The generated SQL was tried on PostgreSQL 18, and is to be read before it is run on a database that matters. The rules, with every class and reason, are in [docs/COMPATIBILITY.md](COMPATIBILITY.md#postgresql-migration-generate-migration).

## Supabase / PostgREST Endpoint (experimental)

For applications that use Supabase's database client (`supabase-js`), in a browser, in Deno (Edge Functions), or in Node. The sandbox serves a database at `/rest/v1/<table>` in a subset of PostgREST, and the application is pointed at it by its Supabase URL. Its code is not changed.

```sh
npx local-db-sandbox postgrest sandbox.db        # a database directory with a schema.json
```

```text
Local DB Sandbox PostgREST endpoint (subset) at http://127.0.0.1:54321/rest/v1
  database:    /path/to/sandbox.db
  tables:      assets, asset_rates, pair_snapshots, job_state
  Supabase URL for clients: http://127.0.0.1:54321 (any key is accepted)
  No Row Level Security, Auth, Storage, Realtime, RPC, or Edge Functions: every client can read and write every table.
```

Then start the application with its Supabase URL set to the sandbox, for example:

```sh
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=local npm run dev          # Vite: variables already set win over .env files
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=local deno run ... index.ts   # an Edge Function run by hand
```

Supported (v0): `select` with `*` or a column list; the filters `eq`, `gte`, `lt`; `range`; `single()`, `maybeSingle()`; `upsert()` on the primary key (one object or an array); `delete()` with filters. Each request is one transaction; committed changes are written back to the database. Anything else PostgREST accepts (other operators, `order`, `insert()`, `update()`, counts, embedding, `rpc()`, ...) is refused with `501 SANDBOX_POSTGREST_UNSUPPORTED` naming what is missing, never silently ignored. Errors PostgREST would give (`PGRST116`, `42703`, `23505`, ...) are given with its codes. The full contract is in [docs/COMPATIBILITY.md](COMPATIBILITY.md#postgrest-endpoint).

The database needs stored table definitions (`schema.json`); they are not guessed from rows. For a Supabase project, `init` creates the database from its migrations (see [From PostgreSQL Migrations](#from-postgresql-migrations-experimental)). There is no Row Level Security: every key is accepted and every table is readable and writable, so authorization bugs of the real project do not show here. Keys sent by clients are never logged.

The endpoint has its database to itself while it runs: a second endpoint, sandbox, or saving SQL console on the same database is refused, and told who has it. To look into the rows the endpoint serves, and change them, start [Local DB Studio](#local-db-studio-experimental) on the same database; it asks the endpoint's process, so the application and Studio see the same rows.

| Option | Effect |
|---|---|
| `-p`, `--port <number>` | Port (default 54321, a local Supabase stack's API port; 0 = any free port). |
| `-H`, `--host <name>` | Host to bind (default 127.0.0.1). |
| `--max-rows <n>` | Most rows one read returns (default 1000, as Supabase's `db-max-rows`; 0 = no cap). |
| `--no-save` | Discard changes when the endpoint stops. |
| `--sql-log <mode>` | `off`, `summary` (default), `verbose`. |
| `-q`, `--quiet` | Do not log requests. |
| `--max-file-size <MB>` | Largest database to accept. |

## Local DB Studio (experimental)

A page in your browser that looks into a sandbox database: its tables, what each table is, and its rows; it adds, changes, and removes rows, runs SQL, and sends requests to your application's API on this machine. It is a local development tool for the sandbox's own databases, not a database client: it connects to no database server.

```sh
npx local-db-sandbox studio sandbox.db           # a database directory, or a single file (sandbox.db.json)
npx local-db-sandbox studio                      # the project's database: the one .local-db-sandbox/sandbox.config.json names, or .local-db-sandbox/sandbox.db
```

```text
Local DB Studio at http://127.0.0.1:4583/#key=3f9c...
  database:  /path/to/sandbox.db (database directory)
  mode:      standalone: Studio has the database to itself
  access:    read/write
  tables:    12
  The address holds the key of this session. The page is served to this machine only.
  Press Ctrl+C to stop.
```

Open the address it prints. Everything the page does is carried out by the sandbox's relational runtime (SQLite in memory, as in the NestJS mode, the PostgREST endpoint, and the SQL console); Studio has no engine and no SQL of its own, and a change is saved as a sandbox saves it.

**How a database is opened** follows from what it is and from who has it open:

| The database | What Studio does |
|---|---|
| A directory that no process has open | **Standalone, read/write.** Studio has the database to itself: it claims it, loads it, and saves every committed change to it. What you change is there when Studio, or a sandbox, is started again. |
| A database that a sandbox has open (`npm run sandbox`, `postgrest`, another Studio) | **Attached.** Studio does not open the database. It asks the process that has it, so there is one runtime and one writer: what the application writes, Studio shows, and what you change in Studio, the application reads at once, and that process saves it. |
| A single file | **Read-only, always.** Rows can be browsed and statements that read can be run. Nothing is changed, and the file is never converted or written again. To change it in Studio, convert it into a directory: `local-db-sandbox convert sandbox.db.json --out sandbox.db`. |

With `--read-only`, Studio changes nothing whatever the database is.

**The page**

- *Overview:* the database's name and path, its format, whether Studio is standalone or attached (and to what), whether it can be changed, and how many tables it has.
- *Rows:* the tables with their row counts; for a table, its columns with their types, whether they take NULL, the primary key, and defaults; the rows by page (25 to 500), sorted by the column whose name you press, filtered by one or more comparisons (`=`, `!=`, `>`, `>=`, `<`, `<=`, contains, is NULL, is not NULL). **Add a row** gives the columns you fill in and leaves the rest to the database; a column that TypeORM fills itself with the time a row is written (`@CreateDateColumn`, `@UpdateDateColumn`), and that has no default in the database, gets the time of the insert when you leave it out, as the application would give it, and keeps a value you give; **Edit** changes the columns you touch of the row with that key; **Delete** removes it, after asking.
- *SQL:* `SELECT`, `INSERT`, `UPDATE`, and `DELETE`, several statements separated by semicolons. Without **Allow changes**, a statement that would change anything is refused by SQLite itself, whatever it looks like. With it, the page asks first, and the statements run as one transaction: committed when every one went well, taken back when one did not. Results show the rows a statement returned and how many it changed.
- *API:* one HTTP request at a time to an API that runs on this machine: a method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), a URL, headers (one `Name: value` per line), and a JSON body. **Send** shows the status, how long it took, the response headers, and the body (laid out when it is JSON), or why it was not sent or not answered. Studio's server sends it, to `127.0.0.1`, `localhost`, or `[::1]` only. Whether the answer is right is for you to say: then look at the rows in *Rows* or *SQL*.
- *Export:* the tables you choose (one, several, or **All**), written as an SQL script for PostgreSQL that the page offers as a `.sql` file: **Schema only** (the default), **Data only**, or **Schema + data**. The page says how many tables and which mode before you export. An export with data asks you to confirm that the file will hold the rows, which may be data you entered. See [SQL export](#sql-export-studios-export-tab) below.
- *Clear data:* deletes every row of the tables you choose (one, several, or **All**), in one transaction; the tables, columns, keys, constraints, and indexes stay. It asks you to tick that the rows cannot be restored, and then to confirm in a dialog that names the tables and their rows. See [Clearing rows](#clearing-rows-studios-clear-data-tab) below.
- *ER Diagram:* every table with its columns, types, primary and foreign keys, and NULL, and every foreign key as lines from column to column; zoom, pan, Fit to view, search, and tables you can drag. Read-only, and made without reading a row. See [ER diagram](#er-diagram-studios-er-diagram-tab) below.
- *Refresh* reads everything again. The page also does so after every change it made, and when the sandbox it is attached to was restarted.

**Calling the application's API.** Studio does not start your application; start it as you do.

1. Start the backend on the sandbox, for example `npm run sandbox` (set up with `init-nest`; it listens on `127.0.0.1:3001` unless you chose another port).
2. Start Studio on the same database: `npx local-db-sandbox studio sandbox.db --api http://127.0.0.1:3001/`. It attaches to the sandbox.
3. Open the address it prints, and choose the **API** tab. The URL starts as the `--api` address; change it as you like.
4. Send `GET http://127.0.0.1:3001/users` (with your application's global prefix, if it has one), or a `POST` with a JSON body.
5. Read the status and the body, and go back to **Rows** to see what the request changed in the database.

The API tab sends nothing to another machine: another host or address, `https:`, and Studio's own port are refused, and no name is looked up (`localhost` is `127.0.0.1`, then `::1`). A redirect is shown, not followed. A request may take 10 seconds; a body is read up to 1 MiB and shown as cut beyond that. Nothing of a request (its URL, headers, body, or answer) is logged, written to a file, or kept in the page, and a cookie the API sets is shown without its value.

Values are shown as the application has them (`true`, an ISO date-time, JSON), and typed the same way; the console shows what SQLite stores. A value that is too long for a page is cut and marked; open the row to read all of it.

**One process has a database open to write at a time.** A sandbox process says that it has a database, in a small file beside it (`sandbox.db.owner.json`), for as long as it runs: the REST sandbox, the PostgREST endpoint, the NestJS sandbox, the SQL console when it may save, and Studio when it has a directory to itself. `init --force` asks the same file before it replaces a database, and is refused one that any of them has open.

- A second process that would write is refused when it starts, and is told who has the database: `sandbox.db is open in the NestJS sandbox (pid 4242, since ...). One process has a database open to write at a time: stop that one first.` Before this, both were let in, and one of them failed at its next save.
- Studio is never the second one. A database that a sandbox has open, it looks into through that sandbox. A directory that a process has open which has no runtime to look into (the REST sandbox, which runs on the JSON engine; the SQL console) is refused; `studio --read-only` then shows what is stored.
- A Studio that has a directory to itself keeps a sandbox out in the same way, and says so when it starts and on its page. **To use the database with an application: stop Studio (Ctrl+C), start the sandbox, and start Studio again.** It then attaches to the sandbox, and both show the same rows. A sandbox that is started while Studio still has the database is refused, and is told the same three steps. Nothing lets go of a database by itself, and nothing starts a sandbox for you.
- The file is removed when its process stops. A process that was killed leaves it behind; whoever comes next sees that the process is gone and takes the database. If a refusal names a process that is not there any more, delete the file it names.
- The file is not part of the database, and holds the token of a local endpoint. Do not commit it: the init commands add it to the project's `.gitignore` ([The Project's .gitignore](#the-projects-gitignore)); add `*.owner.json` yourself for a database made another way.

**With `npm run sandbox` (watch mode).** Start Studio while the sandbox runs, and leave it open. When a source change restarts the sandbox, the page says that it is not connected, then finds the new sandbox process by itself, says that the sandbox was restarted, and reads everything again. Studio stays attached while the sandbox is away: it does not take the database for itself.

- Nothing is changed while no sandbox answers, and nothing is kept to be done later.
- A change is sent once. If the sandbox ended while a change was on its way, Studio says that it does not know whether the change was carried out; look at the data, and do it again if it was not. Studio never sends it a second time by itself.
- A form that was filled in before a restart is not carried out by the sandbox that came after it: the page says that the database is open in another process, and shows the rows as they are now.
- While the application has a transaction open, Studio does nothing and says that the runtime is busy; the page asks again a few times by itself when it only reads.

**Who can reach it.** The page is served on `127.0.0.1` and nowhere else; there is no option for another address. What it asks is answered only with the key of the session, which is random, is in the address the command prints (behind `#`, where a browser sends it to no server), and is taken out of the address bar once the page has it. A page of another site cannot ask in your name, and the page loads nothing from anywhere: it is one document with its own style and script. The sandbox that Studio attaches to serves its runtime on `127.0.0.1` too, on a port of its own, to whoever has the token in its `owner.json`; that token is never printed.

| Option | Effect |
|---|---|
| `-p`, `--port <number>` | Port of the page (default 4583; 0 = any free port). |
| `--read-only` | Change nothing: browse, and run statements that read. |
| `--api <url>` | Address of a local API that the API tab starts from (`http://127.0.0.1:<port>/...`). Another host is refused when Studio starts. |
| `--max-file-size <MB>` | Largest database to accept when Studio opens it itself. |

Limits:

- Table definitions are the ones stored with the database (`schema.json` of a directory, `$tableSchema` of a file). A database that stores none is described from its rows, as `sql --no-entities` describes it. Tables are not created, altered, or dropped in Studio: they are changed where the application defines them.
- A table without a primary key is shown, and its rows are changed with SQL.
- Studio cannot attach to the REST sandbox or to a SQL console. A read-only Studio on a database that such a process changes shows the rows as they were stored when it started; start it again to see newer ones.
- An application that opens a database through the library without the sandbox module (`createSandboxDataSource`), or a REST sandbox on a directory with `"persistence": "memory"`, says nothing about having it open, and Studio does not know of it.
- When the first of two Studios on one database stops, the second is attached to no one; start it again.
- A directory in an earlier format is opened read-only, with the command that migrates it.
- Times shown are local execution times, and say nothing about how a production database would perform.

Not part of Studio: editing schemas or migrations, the ER diagram as an image file, charts, a query builder, import, access from another machine, accounts, and connections to a real database server; and in the API tab, requests to another machine, collections, saved requests or history, environments, assertions, reports, and starting or watching the application. The rules are in [docs/COMPATIBILITY.md](COMPATIBILITY.md#local-db-studio-and-who-has-a-database-open).

### Clearing rows (Studio's Clear data tab)

The Clear data tab deletes every row of the tables you choose, and nothing else:

- **One transaction.** All the tables chosen are cleared, or none: when a delete fails, or what changed cannot be saved, everything is taken back. The database directory, the schema, and every other table stay as they were.
- **Foreign keys.** Among the tables chosen, foreign keys are checked when the transaction ends, so tables that refer to one another, or to themselves, are cleared together. A table that is **not** chosen and has rows that refer to a chosen one stops the clear: it would lose those rows (`ON DELETE CASCADE`), have them changed (`SET NULL`), or keep rows that refer to nothing. The refusal names those tables and how many rows refer; choose them too, or clear them first. Nothing outside your choice is ever changed, and foreign keys are never switched off.
- **Numbering is not reset.** While the database stays open, a numbered key goes on after the last number it gave. The stored database keeps rows, not counters: after it is opened again (a new Studio, a restarted sandbox), an emptied table starts numbering at 1 again, as after deleting its rows any other way.
- **It cannot be undone.** To keep the rows, export them first (Export, Data only or Schema + data), or copy the database directory while nothing has it open.
- **Where it runs.** Standalone, in Studio's runtime; attached, in the runtime of the process that has the database open (the NestJS sandbox, the PostgREST endpoint), never by writing the files. A read-only Studio, a single-file database, and a runtime with a transaction of the application open refuse it.

### SQL export (Studio's Export tab)

The Export tab writes tables of the sandbox as a script that rebuilds them in PostgreSQL, to load into an empty database:

```sh
psql -v ON_ERROR_STOP=1 -d my_empty_db -f local-db-export-schema-and-data-20261026T081503Z.sql
```

| Mode | The script holds | Load it into |
|---|---|---|
| Schema only | enumerated types, `CREATE TABLE` with primary keys, unique constraints, check constraints, and defaults, indexes, and the foreign keys | a database without these tables |
| Data only | `INSERT`s of every row, and the numbering of numbered columns set past the largest value | a database that has these tables, empty |
| Schema + data | the definitions, the rows, then the foreign keys | a database without these tables |

What to know:

- It is one transaction (`BEGIN` ... `COMMIT`): when a statement fails, nothing of it stays. The last line counts the statements, so a cut file is told from a whole one.
- The definitions are what `generate-migration` writes for these tables from an empty schema, and are refused for what it refuses: a column whose type the schema does not say (a database written by hand), a name longer than PostgreSQL keeps. Values are written from each column's type, exactly: NULL, booleans, whole numbers beyond JavaScript's (as their digits), decimals, dates and times, UUIDs, JSON and JSONB, arrays, bytes, values of enumerated types; every name is quoted, and every text is a constant, whatever it holds.
- Tables that refer to one another, or to themselves, load in any order with schema and data: the foreign keys come after the rows. With data only, the rows are put in the order of the foreign keys, and tables in a circle need the target's foreign keys `DEFERRABLE` (the script says so).
- A foreign key to a table you did not choose is left out, and said. A value that is not a value of its column's type, or anything else that cannot be written as it is, refuses the export as a whole, with every reason: no file is made.
- It reads the sandbox and changes nothing; Studio may be read-only. Attached to a sandbox, it reads that sandbox's runtime. It connects to no database. The file's name holds nothing of the database or where it is, and the script holds no connection string, password, token, or path; it holds the rows, which may be personal: keep the file accordingly.
- Limits: the chosen tables with their rows may be 32 MiB as JSON, and a script 64 MiB. Above that the export is refused; export fewer tables, or the schema alone.
- Tested on PostgreSQL 18.6; other versions of PostgreSQL are targeted and not tested. The rules are in [docs/COMPATIBILITY.md](COMPATIBILITY.md#sql-export-studios-export-tab).

### ER diagram (Studio's ER Diagram tab)

The ER Diagram tab draws the tables of the database and their foreign keys:

- Each table is a box: its name, and for each column `PK` and `FK` marks, its name, its type (as the Rows tab shows it), and `null` or `not null`. A foreign key is a line from each column that refers to the column it refers to, with an arrow there; a key over several columns has a line for each pair of columns. A table that refers to itself loops out of its side and back. Tables without foreign keys are there too. The numbers of tables and foreign keys are shown above the diagram.
- **Zoom in** / **Zoom out**, or the mouse wheel (about the pointer); drag the background to pan; **Fit to view** shows every table, as the first view does. **Find a table** lists the tables whose names hold what you type; a click on one (or Enter, for the first) shows it in the middle and marks it with its foreign keys. A click on a table marks its foreign keys. Drag a table to move it; **Auto arrange** puts every table back where the layout puts it. Where a table was moved to is not kept.
- The layout is computed by Studio's server with Dagre (MIT): tables referred to stand left of those that refer to them, connected tables together, and the rest in rows by name. The same schema gets the same layout.
- It reads the tables' definitions and no row, and changes nothing; it works in a read-only Studio, on a single file, and attached to a sandbox. It sends nothing anywhere but to Studio's server.
- Only declared foreign keys are drawn; one to a table the database does not have is named above the diagram instead. A name longer than 40 character cells is cut in its box, and whole in its tooltip.
- Limits: at most 400 tables and 8,000 columns; above that the tab says so, and the Rows and Export tabs show the tables one by one. It cannot be saved as an image.
- The rules are in [docs/COMPATIBILITY.md](COMPATIBILITY.md#er-diagram-studios-er-diagram-tab); the library's license in [docs/THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Architecture

```text
                    Core Engine
              +------------------+
              | data model       |
              | CRUD             |
              | query model      |
              | events           |
              | timing           |
              +--------+---------+
                       |
          +------------+------------+
          |            |            |
          v            v            v
   JSON Storage     REST Server     CLI
     Adapter          Adapter      Adapter
```

```text
packages/
  core/          headless data model, CRUD, queries, operation events
  storage-json/  JSON file persistence
  server/        local HTTP server, simulation, request events, log formatting
  cli/           command-line entry, $config loading, package entry point
  import-typeorm/ TypeORM entity importer (experimental)
  runtime/       relational runtime on embedded SQLite, Query IR (experimental)
  sql-console/   SQL console session over the runtime (experimental)
  nest-typeorm/  TypeORM on the runtime, NestJS module, and parallel sandbox server (experimental)
  side-effects/  mail capture (local SMTP server) and network guard for an application in the sandbox (experimental)
  postgrest/     PostgREST-compatible endpoint (subset) for supabase-js clients, on the runtime (experimental)
  import-postgres/ PostgreSQL migration collector: migrations, or a running database's catalog (init-pg), to the runtime's table definitions (experimental)
  schema-diff/   what differs between two schemas, as data and as lines (experimental)
  migration/     a schema diff applied to a schema, the plan of steps that carries it out, and (src/postgres) that plan as a PostgreSQL migration, and tables as a PostgreSQL script for Studio's Export tab (experimental)
  runtime-access/ what is asked of a runtime that a process has open (rows by page, one row, changes, a console, a snapshot of whole tables), and the local endpoint that serves it to other processes (experimental)
  studio/        Local DB Studio: a session on a database through that access, its page, and the ER diagram's layout (experimental)
examples/basic/  example database file
docs/            user guide, reference, architecture, compatibility, storage format
```

The core does not depend on HTTP, the CLI, file paths, or environment variables. See `docs/ARCHITECTURE.md`.

The standalone REST mode runs on the core's JSON engine. The NestJS + TypeORM mode runs on the relational runtime (`packages/runtime`), where the JSON file is only the fixture; see `docs/COMPATIBILITY.md`.

## Out of Scope

Intentionally not part of this tool: a SQL parser or SQL translation of its own (the NestJS mode executes SQL on embedded SQLite as it is; `init` reads migrations with PostgreSQL's own parser and translates nothing), PostgreSQL/MySQL compatibility, generating migrations for a database other than PostgreSQL or as the migration classes of an ORM, migrations backwards, converting or filling in rows for a migration, running a migration on a database and applying a schema diff to a database (`simulate` runs SQL on a copy only; `diff-schema` says what differs, `plan-migration` in which steps it would be carried out, and `generate-migration` writes those steps as SQL for PostgreSQL; none of them changes anything or connects to a database), schema migrations for your application's database (`migrate` only changes the sandbox's own storage format), dump import, entity generation, ERD files (Studio's ER Diagram tab shows the tables, read-only), performance dashboards, authentication, production-grade concurrency, a VS Code extension, Supabase beyond PostgREST table access (Auth, Storage, Realtime, RPC, Edge Functions, Row Level Security), and stand-ins for other services (Redis, S3, HTTP APIs, message queues, webhooks): the sandbox captures mail and can refuse connections, and emulates nothing else. Local DB Studio looks into the sandbox's own databases on this machine: it is not a client for a database server, is not reachable from another machine, has no accounts, and does not edit schemas or migrations.
