# Local DB Sandbox

A local database sandbox for developing an application against a disposable copy of its database, on your own machine.

From a project's own schema (TypeORM entities or PostgreSQL migrations) it creates a local database, runs the project's backend against it, and lets you look into and change the data in the browser (Local DB Studio), send requests to the backend, try a SQL script on a throwaway copy, and compare schemas. It can also serve a JSON file as a mock REST API.

Everything runs on this machine. Apart from the mock REST API, which has a JSON engine of its own, it runs on SQLite. It is a development tool: not a replacement for PostgreSQL, MySQL, or a production backend, and it connects to no database server.

**Read next:** the [User Guide](https://github.com/PatrickCOC/local-db-sandbox/blob/main/docs/USER_GUIDE.md) (Traditional Chinese) walks through the daily workflows; the [Reference](https://github.com/PatrickCOC/local-db-sandbox/blob/main/docs/REFERENCE.md) describes every command, option, and file format. `local-db-sandbox <command> --help` describes each command.

## Status: npm beta

The current release is **`0.1.0-beta.1`** on npm ([`local-db-sandbox`](https://www.npmjs.com/package/local-db-sandbox), dist-tags `beta` and `latest`). It is a beta for personal and team development use:

- Most commands are marked experimental. Commands, options, and file formats may still change before 1.0; a database of an earlier format is read and is brought to the current one with `local-db-sandbox migrate`.
- It is tested on Node.js 22 with NestJS 10 and 12, TypeORM 0.3.17 and 0.3.31, and supabase-js 2.
- Report problems at [GitHub Issues](https://github.com/PatrickCOC/local-db-sandbox/issues).

## Supported projects

| Your project | Start with | What you get |
|---|---|---|
| NestJS + TypeORM, with the default data source set up by `TypeOrmModule.forRoot` / `forRootAsync` | `init-nest` | `sandbox.db` made from the entities, and `npm run sandbox`: your own backend on it, at `http://127.0.0.1:3001` |
| PostgreSQL migrations (`supabase/migrations`, `migrations`, `db/migrations`, `database/migrations`, `sql/migrations`) | `init` | `.local-db-sandbox/sandbox.db`, made from the migrations with PostgreSQL's own parser |
| An application that uses supabase-js | `init`, then `postgrest` | a subset of PostgREST at `http://127.0.0.1:54321` |
| A frontend that needs a mock REST API | a JSON file | CRUD routes, filters, and simulated delays and errors at `http://127.0.0.1:4783` |
| Tests in Node | the library | `startSandbox`, `createSandboxDataSource`, `SandboxModule` |

On any of these databases: Local DB Studio (`studio`), a SQL console (`sql`), a SQL script on a copy (`simulate`), and schema comparison (`diff-schema`, `plan-migration`, and `generate-migration`, which writes PostgreSQL).

## Prerequisites

- Node.js 22.18 or later. SQLite is Node's own (`node:sqlite`): a command that loads it (`init`, `sql`, `simulate`, `postgrest`, a standalone Studio, the NestJS sandbox) prints Node's `ExperimentalWarning: SQLite is an experimental feature` once, which is harmless.
- For a NestJS project: the project's own `@nestjs/*`, `typeorm`, and `typescript`, installed. They are not dependencies of this package.
- A browser, for Studio.

## Install

From npm, into the project you develop:

```sh
npm install --save-dev local-db-sandbox@beta
npx local-db-sandbox --version          # 0.1.0-beta.1
```

To try it without installing: `npx local-db-sandbox@beta --help`.

To build it from source instead, in a clone of this repository:

```sh
npm install
npm pack                     # builds, and writes local-db-sandbox-<version>.tgz here

# in your project
npm install --save-dev /path/to/local-db-sandbox-<version>.tgz
```

## Quick Start

### NestJS + TypeORM

```sh
npx local-db-sandbox init-nest     # once: sandbox.db, .local-db-sandbox/, and the "sandbox" script in package.json
npm run sandbox                     # your backend on the local database, at http://127.0.0.1:3001
```

In a second terminal:

```sh
npx local-db-sandbox studio sandbox.db --api http://127.0.0.1:3001/
```

Open the address Studio prints. Studio is attached to the running sandbox: **Rows** and **SQL** show what the backend writes, and the **API** tab sends requests to it. Before you point a real application at the sandbox, turn on mail capture and the network guard; see the User Guide, "Safety".

### PostgreSQL migrations

```sh
npx local-db-sandbox init .                              # .local-db-sandbox/sandbox.db
npx local-db-sandbox studio .local-db-sandbox/sandbox.db
```

For a supabase-js application, serve the database instead, and set the application's Supabase URL to `http://127.0.0.1:54321` (any key is accepted). Studio started on the same database then attaches to the endpoint.

```sh
npx local-db-sandbox postgrest .local-db-sandbox/sandbox.db
```

### Try a SQL script on a copy

```sh
npx local-db-sandbox simulate sandbox.db sandbox-scripts/change.sql     # writes sandbox-preview.db; sandbox.db is not changed
npx local-db-sandbox studio sandbox-preview.db
```

Keep such scripts in a folder of their own, not in the project root or a migrations folder: a directory that holds `.sql` files is read as migrations by `init` and the schema commands.

### A JSON file as a mock REST API

```sh
npx local-db-sandbox db.json        # db.json: { "data": { "users": [ { "id": 1, "name": "Ada" } ] } }
```

Each key under `data` is a collection: `GET /users`, `POST /users`, `PATCH /users/1`, and so on, at `http://127.0.0.1:4783`. From a clone of this repository: `npm start -- examples/basic/db.json`.

## CLI Usage

```text
local-db-sandbox <database> [options]
local-db-sandbox <command> [arguments] [options]
local-db-sandbox <command> --help
```

| Command | What it does |
|---|---|
| `local-db-sandbox <database>` | Serves a JSON database (a file such as `db.json`, or a database directory) as a local REST API |
| `init <project-or-migrations>` | Creates a database from a project's PostgreSQL migrations |
| `init-nest [entry]` | Sets up a sandbox server for a NestJS + TypeORM project (`npm run sandbox`) |
| `import-typeorm <path>` | Creates a database file from TypeORM entities |
| `studio <database>` | Opens Local DB Studio in the browser |
| `sql <database> ["<SQL>"]` | Opens a SQL console on a database, or runs one statement |
| `simulate <database> <script.sql>` | Runs a SQL script on a copy of a database, and leaves the database as it was |
| `postgrest <database>` | Serves a database to supabase-js clients (a PostgREST subset) |
| `diff-schema <before> <after>` | Says what differs between two schemas, without changing either |
| `plan-migration <before> <after>` | Says in which steps those differences would be carried out |
| `generate-migration <before> <after> --dialect postgres` | Writes those steps as SQL for PostgreSQL, without running it |
| `mail list \| show <id> \| clear` | Shows the mail a running sandbox captured |
| `inspect <database>` | Says what storage format a database has, without changing it |
| `migrate <database>` | Brings a database of an earlier storage format to the current one |
| `convert <database> --out <path>` | Copies a database into the other kind of storage (single file or directory) |

Options of the REST server: `-p, --port <number>` (default 4783; 0 = any free port), `-H, --host <name>` (default 127.0.0.1), `--max-file-size <MB>` (default 150, at most 250), `-v, --verbose`, `-q, --quiet`. Every command and option is in the [Reference](https://github.com/PatrickCOC/local-db-sandbox/blob/main/docs/REFERENCE.md#cli).

## Local DB Studio

`npx local-db-sandbox studio <database>` opens a page in your browser that looks into a sandbox database. It is a local tool for the sandbox's own databases, not a client for a database server.

- **Overview**: the database's path and format, whether Studio has it to itself or is attached to a running sandbox, whether it can be changed, and how many tables it has.
- **Rows**: tables with row counts, columns with their types, keys, and defaults; rows by page, sorted and filtered; add, edit, and delete rows.
- **SQL**: `SELECT`, `INSERT`, `UPDATE`, and `DELETE`. Statements that change data run only with **Allow changes**, after a confirmation, as one transaction.
- **API**: sends one HTTP request at a time to your API on this machine (`127.0.0.1`, `localhost`, or `[::1]` only), and shows the status, duration, headers, and body.
- **Attaches to a running sandbox** (`npm run sandbox`, `postgrest`): one runtime and one writer, so what the application writes, Studio shows, and what you change in Studio, the application reads. It finds the sandbox again after a hot reload.
- **Local only**: the page is served on `127.0.0.1`, and answers only with the random key in the address the command prints. `--read-only` changes nothing.

Studio does not edit schemas or migrations, and does not start your application. Details: [Reference, Local DB Studio](https://github.com/PatrickCOC/local-db-sandbox/blob/main/docs/REFERENCE.md#local-db-studio-experimental).

## Documentation

| Document | What is in it |
|---|---|
| [User Guide](https://github.com/PatrickCOC/local-db-sandbox/blob/main/docs/USER_GUIDE.md) (繁體中文) | quick start, Studio, `simulate`, schema comparison, troubleshooting, and safety, step by step |
| [Reference](https://github.com/PatrickCOC/local-db-sandbox/blob/main/docs/REFERENCE.md) | every command and option, file formats, size limits, logs, mail capture, the network guard |
| [Compatibility](https://github.com/PatrickCOC/local-db-sandbox/blob/main/docs/COMPATIBILITY.md) | exactly what the SQLite runtime, the importers, the PostgREST subset, Studio, and the generator do |
| [Architecture](https://github.com/PatrickCOC/local-db-sandbox/blob/main/docs/ARCHITECTURE.md) | the packages and their boundaries |
| [Format](https://github.com/PatrickCOC/local-db-sandbox/blob/main/docs/FORMAT.md) | the storage format of a database file and a database directory |

## Known limitations

- **SQLite underneath.** SQL runs on SQLite as it is written. PostgreSQL-only syntax (`ILIKE`, `::` casts, `now()`, `ALTER COLUMN ... TYPE`) is not translated, and fails with an error. `$1`-style placeholders and `TO_CHAR` for dates are the documented exceptions.
- **A database made from migrations leaves things out.** Row level security, roles and grants, extensions, functions, triggers, scheduled jobs, and views are reported and not reproduced; check constraints are kept as information and not enforced.
- **NestJS + TypeORM.** The default data source, set up with `TypeOrmModule.forRoot` / `forRootAsync`, and an entry point that calls `NestFactory.create` and `app.listen` itself. Many-to-many join tables, embedded columns, views, and table inheritance get no tables; unique constraints and indexes of entities are not created.
- **PostgREST is a subset**: `select`, the filters `eq`, `gte`, `lt`, `range`, `single()`, `maybeSingle()`, `upsert()` on the primary key, and `delete()` with filters. Anything else is refused, never ignored. No Row Level Security, Auth, Storage, Realtime, or RPC.
- **`simulate` keeps** rows, tables made and dropped, and columns added and dropped. Indexes, views, triggers, renames, CHECK constraints, and type names such as `serial` or `timestamptz` fail their statement.
- **`generate-migration` writes PostgreSQL**, and never runs it. No command of this package changes a real database or connects to one.
- **One writer per database.** A second process that would write a database that one has open is refused. Studio attaches to a running sandbox instead; while Studio has a database to itself, a sandbox is refused (stop Studio, start the sandbox, start Studio again).
- **This machine only.** Studio and the NestJS sandbox listen on `127.0.0.1`, and the REST and PostgREST servers do so unless given `--host`. An application that switches in `SandboxModule` itself listens where its own `app.listen` says.
- **Windows.** A process that is stopped by force leaves its owner record (`<database>.owner.json`) behind; the next process takes it over.
- **Size.** Databases are development fixtures: 150 MB by default, 250 MB at most.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
```

`npm test` includes a test that packs the package and installs it into a temporary project, so it needs `npm` on the path. The tests of Studio's page run in a Chromium-based browser that is installed on the machine (Chrome, Edge, or Chromium), headless; without one they are skipped, and say so. `LOCAL_DB_SANDBOX_TEST_BROWSER` names the browser to use, or `none`.

## License

[MIT](LICENSE)
