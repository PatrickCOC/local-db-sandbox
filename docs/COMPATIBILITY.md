# Compatibility: the Relational Runtime

This document describes what the sandbox's relational runtime does and does not do. It is written from the runtime's point of view: an ORM integration is supported to the extent that the SQL it produces runs on the runtime. It is not a list of ORM methods.

It applies to the NestJS + TypeORM integration and to the SQL console (`local-db-sandbox sql`), which runs on the same runtime; the TypeORM sections do not concern the console, and without entities its table definitions are inferred from the data (see [REFERENCE.md](REFERENCE.md), "SQL Console"). The standalone REST mode (`local-db-sandbox db.json`) does not use the runtime yet; see "What still runs on the JSON engine".

Status: experimental spike (D-018).

## Model

```text
sandbox.db.json   portable fixture and snapshot
      |  load at startup
      v
SQLite (in memory, node:sqlite)   the only execution engine
      ^
      |  SQL
ORM (TypeORM, using its own SQLite dialect)
```

- The JSON file is not queried. At startup its rows are inserted into SQLite tables; after that, every read and write is a SQL statement executed by SQLite.
- With `json` persistence (the default), the tables are written back to the file at each commit that changed data. With `memory` persistence, changes are discarded when the process stops.
- The database is disposable. It is rebuilt from the file on every start.

## What the runtime provides

| Capability | Behavior |
|---|---|
| Statements | Any single SQL statement that SQLite accepts, with positional parameters written as `?` or as `$1`, `$2`, ... (see [Parameter placeholders](#parameter-placeholders)). Rows returned, rows affected, and the last inserted row id are reported. |
| Transactions | SQLite transactions: `BEGIN`, `COMMIT`, `ROLLBACK`, and savepoints. Nothing is emulated outside SQLite. |
| Constraints | Primary keys (single and composite), `NOT NULL`, static column defaults, foreign keys (of one or several columns) with their `ON DELETE` and `ON UPDATE` actions, unique constraints, enumerated values, and the computed defaults `current_timestamp` and `current_date`. All enforced by SQLite. Check constraints are kept as information and not enforced. |
| Generated keys | A single integer primary key that the entity marks as generated is `INTEGER PRIMARY KEY AUTOINCREMENT`. Keys of deleted rows are not reused. |
| Query IR | A small model for single-table select, count, insert, update, delete, and upsert (`INSERT ... ON CONFLICT`), with the conditions `eq` (also `IS NULL`), `gte`, and `lt`, compiled to SQL. The runtime uses it to load and save fixtures; it is available to adapters that cannot supply SQL, such as the [PostgREST endpoint](#postgrest-endpoint). |
| Events | One structured event per executed statement: the SQL text as executed, its parameters, row count, `localExecutionMs`, and an error code on failure. |
| Size limits | The existing limits on the JSON file apply when it is loaded and when a snapshot is saved. |

Created when the table definitions have them (a schema from PostgreSQL migrations, `init`; or `schema.json` written by hand): unique constraints, indexes over columns (unique ones enforced), enumerated values. Not created, and therefore not enforced: check constraints, indexes over expressions or with a condition (kept as information). The TypeORM integration does not put unique constraints or indexes into the definitions, so for it none of these is created. Join tables of many-to-many relations are not created.

## Schema mapping

Tables are created by the runtime from the metadata the TypeORM importer reads from entity classes. One entity is one table, named after the entity's table name. Fixture rows are keyed by entity property name; SQL uses the database column name (`@Column({ name })`).

| Entity column | SQLite column | In the JSON file | Notes |
|---|---|---|---|
| integer types, `number` properties, `bigint`, `@VersionColumn` | `INTEGER` | number | |
| `float`, `double`, `real`, `float4`, `float8` | `REAL` | number | |
| `decimal`, `numeric` | `NUMERIC` | number | SQLite has no exact decimal type. Values are stored as floating point; precision and scale are not applied. |
| string and text types, `uuid`, enums | `TEXT` | string | Length limits are not applied. Enum values are not checked by the database. |
| `boolean` | `BOOLEAN` | `true` / `false` | Stored as `1` / `0`. |
| `datetime`, `timestamp`, `timestamptz`, `@CreateDateColumn`, `@UpdateDateColumn`, `@DeleteDateColumn` | `DATETIME` | ISO 8601 text | Stored as `YYYY-MM-DD HH:MM:SS.SSS` in UTC. Time zones are not kept. Values written by `datetime('now')` have whole seconds. |
| `date` | `DATE` | `YYYY-MM-DD` text | |
| `json`, `jsonb`, `simple-json`, `simple-array`, PostgreSQL arrays (`array: true`, of any element type) | `TEXT` | any JSON value | Stored as JSON text. JSON and array operators are not available in SQL. |
| nullable | no `NOT NULL` | `null` | |
| primary column(s) | `PRIMARY KEY` | | Any name, single or composite. |
| generated integer primary column | `INTEGER PRIMARY KEY AUTOINCREMENT` | number | |
| generated uuid primary column | `TEXT PRIMARY KEY` | string | The value is generated by TypeORM, not by the database. |
| `@ManyToOne` / owning `@OneToOne` key | column with `REFERENCES` | key value | Enforced, including `onDelete`. |

Loading is strict. A fixture row with a field that is not a column, a value that does not fit its column type, a missing value for a `NOT NULL` column without a default, a duplicate key, or a reference to a row that does not exist stops the sandbox at startup, with the table and row named.

Collections in the file that are not entity tables are kept and written back unchanged.

## TypeORM

Nothing of TypeORM is re-implemented. The sandbox creates a real TypeORM `DataSource` with TypeORM's own SQLite dialect (the `better-sqlite3` driver type) and gives it the runtime as its connection. TypeORM generates SQLite SQL; the runtime executes it.

Versions: the connection the sandbox hands to TypeORM follows what TypeORM's `better-sqlite3` driver does in its stable releases 0.3.0 to 1.1.1. That driver obtains its connection by calling the driver value as a plain function up to 0.3.27 and by constructing it with `new` from 0.3.28 on; both are supported. The tests run on TypeORM 0.3.17 and 0.3.31. TypeORM 1.x makes the same calls but is not run by the tests. TypeORM 0.2 and earlier have no `DataSource` and are not supported. The NestJS parts are run on NestJS 12 only.

**Where the sandbox server listens (D-047).** The sandbox server that `init-nest` sets up (`sandbox.server.ts`, with or without `--watch`, and `runNestSandbox`) listens on the configured port on `127.0.0.1`, whatever port and host the entry point gives `app.listen`; a callback given with them is kept. After listening, the address the server has is read from it: one that is not `127.0.0.1` (an HTTP adapter that ignores the host it is given) stops the sandbox with an error, and nothing is served. The start line says what the entry point asked for and what the sandbox uses (`the entry point asked for port 3000 on 0.0.0.0; the sandbox uses 3001 on 127.0.0.1 (this machine only) instead.`). The application started without the sandbox listens where it always did. `SandboxModule.forRoot` in the application's own root module replaces the database and not the server: there the application's own `app.listen` decides.

| Path | How it reaches the runtime |
|---|---|
| `Repository` and `EntityManager` methods, find options, operators, relations loaded through joins | SQL generated by TypeORM |
| `DataSource.transaction`, `EntityManager.transaction`, `QueryRunner` transactions | TypeORM's `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK` / savepoint statements, executed as SQLite transactions |
| `createQueryBuilder` | SQL generated by TypeORM; fragments the application writes by hand are passed through as written |
| `DataSource.query` and other raw SQL | the application's SQL, as written |

No TypeORM path uses the Query IR. Covered by tests: repository create, read, update, delete; find with operators, `OR`, `select`, and relations; `DataSource.transaction` commit and rollback; QueryBuilder select, aggregate, update, and join; raw queries; single, non-`id`, uuid, and composite primary keys; entities declared with PostgreSQL column types; the conversion of JSON, array, enum, date, and text column values through repositories, QueryBuilder inserts, updates and selects, and transactions. Other TypeORM features run TypeORM's own code against SQLite and are expected to behave as TypeORM does on SQLite, but are not covered by this spike's tests.

What differs from the application's real configuration:

- The application's `TypeOrmModule.forRoot` options are not used. Its naming strategy, subscribers, migrations, logging, and cache settings do not apply; TypeORM's default naming strategy is used.
- `dataSource.options.type` is `better-sqlite3`. Code that branches on the database type takes its SQLite branch.
- TypeORM does not create or alter tables (`synchronize` is off). The runtime owns the schema. At startup the sandbox prints a warning for each entity whose table or columns it did not create; statements that touch them fail.
- Entities the importer skips have no table: views, table inheritance, and `EntitySchema`. Embedded columns and many-to-many join tables are not created.

### Column types and values

An application declares a column under the type name of the database it was written for. On the sandbox that column has three types, and they are kept apart (`packages/nest-typeorm/src/column-semantics.ts`):

- the **declared type**, which says what the values are to the application. The entity's decorators keep it; the sandbox records it with the table definitions (`declaredType` in `schema.json`);
- a **type for TypeORM's SQLite dialect**, which TypeORM is given in the declared type's place while the sandbox's DataSource builds its metadata, and only there. It is chosen so that TypeORM's own conversion, `preparePersistentValue` on the way in and hydration on the way out, is the one the declared type has in production. Afterwards the decorators say again what the application wrote;
- a **storage type**, which is how the runtime holds the values in SQLite and in the JSON fixture (`type` in `schema.json`).

Where TypeORM's SQLite dialect has no conversion that gives the application what it gets in production, a column transformer makes up the difference. It is added after the application's own transformers, as a driver comes after TypeORM, so those still see what they see in production.

"Read" below is what a repository, the entity manager, or a QueryBuilder that returns entities gives the application. It is the same on TypeORM 0.3.17 and 0.3.31.

| Declared | For TypeORM's SQLite dialect | In SQLite | In the fixture | Written | Read | As in production |
|---|---|---|---|---|---|---|
| `boolean`, `bool`, a `boolean` property | `boolean` | integer `1` / `0` | `true` / `false` | `true` / `false` | `true` / `false` | yes |
| `int`, `integer`, `int2`, `int4`, `smallint`, `tinyint`, `mediumint`, a `number` property | as declared, or `integer` | integer | number | number | number | yes |
| `bigint`, `int8` | as declared | integer, 64 bits | number; text of the digits beyond 2^53 | number or digits as text | **text of the digits** | yes, as PostgreSQL's driver and MySQL's (as TypeORM configures it) return it |
| `decimal`, `numeric`, `dec`, `fixed` | as declared | number (float), rounded to the declared scale | number | number or text | **text with the digits of the scale** (`"12.50"`) | yes, up to about 15 significant digits; see below |
| `float`, `float4`, `float8`, `double`, `double precision`, `real` | as declared, or `double` | float | number | number | number | yes |
| `varchar`, `char`, `text`, `citext`, and other text types, a `string` property | as declared, or `varchar` | text | string | string; an object as its JSON text | string | yes; `citext` compares with case |
| `uuid` | `varchar` | text | string | string; generated by TypeORM where the entity asks | string | yes |
| `enum`, `simple-enum` | `simple-enum` | text, or integer for a numeric enum | the value | the value | the value; a number for a numeric enum | yes; other values are not refused |
| `timestamp`, `timestamptz`, `timestamp with/without time zone`, `datetime`, `datetime2`, a `Date` property, `@CreateDateColumn`, `@UpdateDateColumn`, `@DeleteDateColumn` | `datetime` | text, `YYYY-MM-DD HH:MM:SS.SSS` in UTC | ISO 8601 text | `Date` | `Date` | yes, to the millisecond; values the database sets itself have whole seconds |
| `date` | `date` | text, `YYYY-MM-DD` | the same text | text or `Date` | text | yes |
| `time`, `timetz`, `time with/without time zone` | `time` | text | the same text | text or `Date` | text, with its zone if it was given one | yes; the zone is not interpreted |
| `json`, `jsonb`, `simple-json` | `json` or `simple-json` | JSON text | the JSON value | any JSON value | the JSON value | yes |
| `simple-array` | `simple-json` | JSON text of an array | the array | array | array of **text** | yes, except that an element with a comma is not split |
| any column with `array: true` | `simple-json` | JSON text of an array | the array | array | array; **`Date` elements** for date-time arrays, text elements for `bigint` and `decimal` arrays | yes for these; array operators in SQL are not available |
| `bytea`, `blob`, `tinyblob`, `mediumblob`, `longblob`, `binary`, `varbinary`, a `Buffer` property | `blob` | BLOB | Base64 text | `Buffer` | **`Buffer`** | yes |

Bold marks what the sandbox converts itself; everything else is TypeORM's own conversion for the type it was given.

A type with no row here and no SQLite equivalent (for example `geometry`, `tsvector`, `interval`, `money`, `hstore`) is not mapped. The sandbox then fails at startup with `SandboxDialectUnsupportedError`, naming the entity and column.

**64-bit integers.** SQLite stores them exactly. A JavaScript number does not hold every one, so the application gets text of the digits, small values included, as it does from PostgreSQL and MySQL. In SQL they are integers: comparisons, ordering, and arithmetic are numeric.

**Decimals.** A value is rounded to the declared scale when it is written, half away from zero, as PostgreSQL and MySQL round what they store; so SQL sees the value the application sees. It is read as text with all the digits of the scale. Without a declared scale nothing is rounded and the number is read as its shortest text. SQLite has no exact decimal type: the value is a 64-bit float, which holds about 15 significant digits. A decimal with more digits than that is not stored exactly, whatever precision the entity declares; it is still returned as text. Declared precision is not enforced, and a value SQL computes (`SET price = price * 1.1`) is not rounded. On SQL Server and Oracle the driver returns a number where the sandbox returns text.

**Objects in text columns.** TypeORM does not convert a value written to a text column. On PostgreSQL the node-postgres driver sends an object bound to a parameter as its JSON text, so an application can save an object to a `varchar` column and read the JSON text back. The sandbox makes the same conversion where TypeORM persists a value of a text column, and reading returns the string, as it does in production. It is not made for arrays or dates, which node-postgres does not send as JSON, for `enum` and `uuid` columns, or for parameters the application binds itself. On MySQL the same write fails in production; the sandbox accepts it.

**Defaults.** A default declared as an object or an array (`default: { theme: "light" }`, `default: []`) is used when a row is inserted without the column. For a column with `array: true`, the default `"{}"` is PostgreSQL's text for an empty array and is read as one. Other array defaults written as PostgreSQL text (`"{a,b}"`) are not translated. `@CreateDateColumn` and `@UpdateDateColumn` are set by SQLite's clock, which TypeORM's SQLite dialect asks for whole seconds.

**Generated values.** An integer key is generated by SQLite. A UUID (`@PrimaryGeneratedColumn("uuid")`, `@Generated("uuid")`) is generated by TypeORM, as its SQLite dialect does; the database's own `uuid_generate_v4()` is not involved.

### What a column is in the entities' own database

Beside the three types above, a column has a **canonical type** (`canonicalType` in `schema.json`, D-040): what the column is in the database the entity was written for, independent of how the entity spelled it. It decides nothing in the sandbox. It is what `diff-schema` compares types by, and what `generate-migration` writes a type from, so that a schema from entities can be compared with one from migrations and written as PostgreSQL.

The declaration is read as TypeORM's own PostgreSQL driver reads it (`PostgresDriver.normalizeType`, the same in 0.3.17 and 0.3.31):

| Declared | Canonical type | In PostgreSQL |
|---|---|---|
| `boolean`, `bool`, a `Boolean` property | `boolean` | `boolean` |
| `smallint`, `int2` | `integer` of 16 bits | `smallint` |
| `int`, `int4`, `integer`, a `Number` property, `@VersionColumn` | `integer` of 32 bits | `integer` |
| `bigint`, `int8` | `integer` of 64 bits | `bigint` |
| `decimal`, `numeric`, with `precision` and `scale` | `decimal` | `numeric(p,s)` |
| `real`, `float4` | `float` of 32 bits | `real` |
| `float`, `float8`, `double precision` | `float` of 64 bits | `double precision` |
| `text`, `simple-json`, `simple-array` | `text` | `text` |
| `varchar`, `character varying`, a `String` property, with `length` | `varchar` | `character varying(n)` |
| `char`, `character`, with `length` (1 when none is given) | `char` | `character(n)` |
| `uuid` | `uuid` | `uuid` |
| `date` | `date` | `date` |
| `timestamp`, a `Date` property, `@CreateDateColumn`, `@UpdateDateColumn`, `@DeleteDateColumn` (unless the decorator states a type), with `precision` | `timestamp` without time zone | `timestamp` |
| `timestamptz`, `timestamp with time zone` | `timestamp` with time zone | `timestamp with time zone` |
| `time`, `timetz`, `interval`, with `precision` | `time` without or with time zone, `interval` | the same |
| `json`, `jsonb` | `json`, and `json` stored decomposed | `json`, `jsonb` |
| `bytea` | `binary` | `bytea` |
| `enum`, `simple-enum` | `enum`, of a type of the schema | a type of its own |
| any of these with `array: true` | `array` of it | `type[]` |
| `citext`, `inet`, `cidr`, `macaddr`, `money`, `xml`, `hstore`, `tsvector`, `tsquery`, the range types, the geometric types, `ltree`, `cube` | PostgreSQL's own (`other`) | the same |

- **An enumerated column is of a type of the schema**, named as TypeORM names it in PostgreSQL: the column's `enumName`, or `<table>_<column>_enum`. Its values are texts, as every value of an enumerated type of PostgreSQL is. The type is listed with the schema's types (`types.enums`). The column names it and does not carry the values: the sandbox does not check an entity's enumerated column against them, as it never has.
- **A name PostgreSQL does not have has no canonical type**: `tinyint`, `mediumint`, `datetime`, `longtext`, `blob`, `varbinary`, `double`, a `Buffer` property without a declared type. Nothing is guessed for them. Such a column keeps what was declared, is compared as declared, and is refused by `generate-migration` (`no-canonical-type`).
- **A database directory stores it**; a single file does not, and is described the tables as before. `convert` from a directory to a single file leaves the canonical types and the enumerated types of entities out, and says so: they are worked out from the entities whenever the application opens the database.
- **What is not read from an entity**: the default TypeORM gives the columns it fills (`now()`), which the sandbox does not apply either; and a uuid key that TypeORM generates is a strategy without a text, while PostgreSQL's `gen_random_uuid()` is one with a text, so `diff-schema` reports the two as different defaults.
- **A default that is no value of its column's type is refused, not cast.** TypeORM takes `@Column({ type: "text", default: false })` and writes `DEFAULT false`, which PostgreSQL casts to the text `false` when a row is written. The schema keeps the default as the entity gave it, and `generate-migration` refuses the step (`value-not-representable`) as it does for any schema: the generator makes up no conversion. Give the default as a value of the column's type (`default: "false"`) and it is written.

### Raw results are not converted

TypeORM converts values where it builds entities. It does not convert the rows of `DataSource.query`, `EntityManager.query`, `Repository.query`, or a QueryBuilder's `getRawOne` and `getRawMany`, on any database: there the application gets what the driver returns. In production that driver is node-postgres or mysql2, which have conversions of their own. On the sandbox it is SQLite, and the application gets what SQLite holds:

| Declared | Raw result in production (PostgreSQL) | Raw result on the sandbox |
|---|---|---|
| `boolean` | `true` / `false` | `1` / `0` |
| date-time types | `Date` | text, `YYYY-MM-DD HH:MM:SS.SSS` in UTC |
| `json`, `jsonb` | the JSON value | JSON text |
| arrays | an array | JSON text |
| `bigint`, `int8` | text of the digits | a number; text of the digits beyond 2^53 |
| `decimal`, `numeric` | text with the digits of the scale | a number |
| binary types | `Buffer` | `Uint8Array` |
| `date`, `time`, text, `uuid`, enums, integers, floats | the same | the same |

The sandbox does not put entity conversion onto raw rows: a raw row has no entity, and imitating a production driver's conversions is PostgreSQL or MySQL emulation, which this project does not do. Code that reads raw rows has to expect SQLite's values on the sandbox. A query that should return application values can return entities (`getOne`, `getMany`) instead.

One thing is guaranteed for raw rows: an integer is never a rounded number. One that a JavaScript number cannot hold exactly is returned as text of its digits.

Parameters of a raw query are bound as given: a boolean as `1` / `0`, a `Date` as SQLite's date-time text. An object or an array that reaches the runtime was not converted by anything and is refused with a `TypeError` that names its position.

## SQL dialect

The runtime does not translate SQL; the only thing it rewrites is the spelling of `$N` parameter placeholders, described below. It provides one function of another database itself, `TO_CHAR` for dates, also described below; that is a function SQLite calls, and no SQL is rewritten for it. A statement that SQLite cannot compile fails with `SandboxDialectUnsupportedError` (code `SANDBOX_DIALECT_UNSUPPORTED`), which carries SQLite's message and the SQL. The same error is used when a statement names a table or column the runtime's schema does not have. Errors raised while a statement runs, such as constraint violations, are passed on as SQLite reports them.

Known to fail this way, because SQLite has no such syntax or function:

- `ILIKE`, `::type` casts, `SELECT ... FOR UPDATE`, `SKIP LOCKED`, schema-qualified names of other databases;
- functions such as `now()`, `gen_random_uuid()`, `uuid_generate_v4()`, `date_trunc()`, `to_date()`, and JSON or array operators;
- `TO_CHAR` outside the subset below: for a number, or with a pattern that is not listed;
- a column `default` given as raw SQL (`default: () => "now()"`) when a row is inserted without that value, because TypeORM inlines the expression into the `INSERT`. `CURRENT_TIMESTAMP` works.

### TO_CHAR for dates

`TO_CHAR(value, format)` is PostgreSQL's function for writing a value as text. Reports group by it (`GROUP BY TO_CHAR("createdAt", 'YYYY-MM')`), and SQLite has no function of that name. The runtime defines one, for dates and date-times only. It is an ordinary SQL function to SQLite: the statement is executed as the application wrote it, in whatever part of it the call stands, and SQL events and logs show it unchanged. It is available on every path to the runtime: TypeORM's QueryBuilder and raw queries, and the SQL console.

This is one function with a stated subset. It is not PostgreSQL emulation, and nothing else of PostgreSQL's formatting comes with it. A call outside the subset fails with `SandboxDialectUnsupportedError` (code `SANDBOX_DIALECT_UNSUPPORTED`); it is never answered with something close.

| Pattern | Result |
|---|---|
| `YYYY`, `YY` | year with four digits; its last two |
| `MM`, `DD` | month and day of the month, two digits |
| `HH24` | hour, 00 to 23 |
| `HH12`, `HH` | hour, 01 to 12 |
| `MI`, `SS`, `MS` | minute and second, two digits; millisecond, three |
| `AM`, `PM`, `am`, `pm` | `AM` or `PM`, in the case the pattern is written in |
| punctuation, spaces, digits | copied (`YYYY-MM-01` gives the first day of the month) |
| `"text"` | the text in double quotes, copied |

- The numeric patterns are recognized in any case (`yyyy-mm-dd`), as on PostgreSQL.
- **Value:** SQLite's date-time text (`2026-01-02 03:04:05.678`), ISO 8601 text, or a day alone, which is what the runtime holds for date-time and date columns and what a `Date` parameter is bound as. `NULL` for a `NULL` value or format. Anything else is refused: text that is not a date, a date that does not exist, a number, binary data.
- **Format:** usually a literal, but it may be a parameter or a column; it is read when the function is called, and an unsupported one is refused then.
- **Refused patterns:** every other pattern and modifier of PostgreSQL's `TO_CHAR`, by name: names of months and days (`Month`, `Mon`, `Day`, `Dy`), day of year and week numbers (`DDD`, `D`, `WW`, `IW`, `Q`), ISO years, `YYY` and `Y`, `SSSS`, `US` and `FF1` to `FF6`, `A.M.`, `BC` / `AD`, time zones (`TZ`, `TZH`, `OF`), Roman numerals, Julian days, and the modifiers `FM`, `TH`, `FX`, `TM`, `SP`. Letters that are no pattern are refused too: text to copy has to be in double quotes (`"T"`).
- **Not provided:** `TO_CHAR` for numbers, intervals, or anything that depends on a locale.
- **Time zone:** the fields are formatted as the runtime holds them, which is UTC. PostgreSQL formats a `timestamptz` in the session's time zone, and a `timestamp` with the fields it was written with, which are that session's too. Where the production session's time zone is not UTC, a row near midnight can therefore fall on a different day than in production. Text that carries an offset (`+08:00`) is brought to UTC first, as SQLite's own date functions do.

### Parameter placeholders

One thing is rewritten before SQLite sees a statement: the spelling of PostgreSQL-style positional placeholders. TypeORM passes SQL given to `DataSource.query`, `EntityManager.query`, and `Repository.query` to the driver as it is, so an application written for PostgreSQL sends `WHERE "userId" = $1` with `[1]`. SQLite reads `$1` as a parameter that is named `$1`, which a parameter array does not bind (`column index out of range`).

- `$N` is given to SQLite as `?N`, SQLite's own numbered placeholder. `$N` is bound to the Nth parameter, wherever it stands and however often it appears: `a = $2 AND b = $1` and `a = $1 OR b = $1` mean what they mean on PostgreSQL. The parameter array is not changed.
- Only a `$` followed by digits and nothing else of a name is a placeholder. `$N` is left alone inside a quoted string or identifier (`'...'`, `"..."`, `` `...` ``, `[...]`), inside a comment (`-- ...`, `/* ... */`), and as part of a longer name (`price$1`, `$1abc`, `:p$1`). These are found by scanning the text the way SQLite reads it. SQL is not parsed.
- The highest placeholder must be the last parameter. `$3` with two parameters, and two parameters with only `$1`, fail with `SandboxParameterError` (code `SANDBOX_PARAMETER`); SQLite alone would bind `NULL` in the first case. A parameter that no placeholder uses is accepted when a later one is used (`$1` and `$3` with three parameters). `$0`, and `$N` together with `?` in one statement, fail with the same error.
- Statements without `$N` are passed to SQLite unchanged, which includes all SQL that TypeORM generates.
- Nothing else is rewritten. `$1::int`, `ILIKE $1`, `= ANY($1)`, and `FOR UPDATE` fail as before, with `SandboxDialectUnsupportedError`.
- SQL events, logs, and error messages show the statement and the parameters as the application gave them, with `$1`.

SQL that SQLite accepts but answers differently from other databases is executed as SQLite defines it. The sandbox does not detect these differences:

- `LIKE` is case-insensitive for ASCII letters; string comparison and ordering use byte order, not a locale collation.
- Column types are affinities, not strict types: a text value can be stored in an integer column.
- Decimals are floating point (about 15 significant digits). Integers have 64 bits; one above 2^53 is returned as text of its digits.
- Date-time values are UTC text; date arithmetic uses SQLite's date functions.
- There is one connection. Isolation levels, row locks, and concurrent transactions do not exist. Overlapping requests that use transactions at the same time share that connection and can interleave; the sandbox is meant for one developer's requests, not for load.

## Transactions and persistence

- A transaction is a SQLite transaction. Everything the callback of `DataSource.transaction` does through its manager runs on the same connection inside it.
- With `json` persistence, the snapshot is written to the file immediately before the commit, synchronously. If the snapshot cannot be saved (for example because it is above the size limit), the commit does not happen and the caller rolls back; the file and the database stay as they were. A statement outside a transaction is treated the same way and is rolled back by the runtime.
- A rolled-back transaction writes nothing.
- The file is replaced atomically (written to a temporary file, then renamed). `$config` and other keys outside `data` are preserved.
- A single-file database is rewritten, with every table in full, on each commit that changed data. This is the reason for the size limits. A database directory has the files of the tables that the commit changed written, and no others (see [REFERENCE.md](REFERENCE.md), "Database directory").

## Observability

- Events describe real statements executed by SQLite, not descriptions of operations. Statements the runtime runs for its own bookkeeping (loading the fixture, reading the snapshot, the transaction it wraps around a single statement) are not reported.
- `localExecutionMs` is the time the local runtime spent on the statement, including saving the snapshot when the statement committed. It is not, and must not be presented as, a measure of how a production database would perform.
- Each event carries: `sql`, `parameters`, `operation` (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRANSACTION`, `OTHER`), `transaction` (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO SAVEPOINT`) for transaction boundaries, `tables` when recognized, `returnedRows` for statements that return rows, `affectedRows` for INSERT/UPDATE/DELETE, `rows` (affected for writes, returned otherwise), `resultPreview` (the first returned rows, 20 by default, never the whole result), `localExecutionMs`, `requestId` and `sequence` when the adapter says what the statement ran for, and `errorCode` / `errorMessage` on failure.
- `tables` is found by pattern after `FROM`, `JOIN`, `INTO`, and `UPDATE`, with string literals ignored, and is limited to tables of the runtime's schema. SQL is not parsed: tables behind a subquery alias or a CTE, and statements beginning with `WITH`, are not recognized, and the field is then absent.
- `requestId` and `sequence` come from the adapter. The NestJS sandbox server tags each request on Node's HTTP server with `AsyncLocalStorage` (the client's `x-request-id`, or a generated ID), numbers the statements of each request from 1, and uses the request `background` for SQL that runs outside any request. It reports one event per request (`requestId`, method, path, status, `totalMs`, `sqlCount`, `sqlExecutionMs`); `sqlCount` equals the number of SQL events with that `requestId`. Response bodies are not captured.
- One event is emitted per statement executed through the runtime's public interface, with nothing merged; a test compares the events with TypeORM's own query log.
- The sandbox server prints these events according to `sqlLog`: `off`, `summary` (default), or `verbose`. Verbose output includes bound parameters and is not redacted. From code, use `onSql` / `onRequest`, or `runtime.subscribe(listener)`; in NestJS the runtime is injectable as `SANDBOX_RUNTIME`.
- Request-level timing (`simulatedDelayMs`, `totalMs`) belongs to the standalone REST server and is unchanged. The NestJS sandbox server is the application's own HTTP server and has no simulated delay.

## What still runs on the JSON engine

- The standalone REST mode: `local-db-sandbox <file.json>`, `startSandbox`, the core `Database`, its query model, simulation, and request logs. Its SQL-like log lines remain descriptions, not executed SQL.
- `import-typeorm` and `init-nest`, which only read entities and write files.

Both modes read and write the same file format. A file written by the runtime keeps property names as keys and can be served by the REST mode, which still identifies rows by `id`.

## PostgreSQL migrations (`init`)

`local-db-sandbox init <project-or-migrations>` reads a project's PostgreSQL migrations with PostgreSQL's own parser (libpg_query 18, through `libpg-query`), applies them in order to a model of the schema, and creates a sandbox database from the result with the relational runtime. No database server is involved, and nothing is translated: the result is the runtime's own table definitions, the sandbox's canonical schema. Status: experimental (D-033 to D-036). Verified with a real Supabase project's seven migrations (the record is kept outside this repository).

Every statement is in the report (`<database>.report.json`) with its file, line, and one of these outcomes: reproduced (`applied`, `seeded`), kept as information (`retained`), not reproduced on purpose (`not-reproduced`), without effect (`no-effect`), or `unsupported`.

### Reproduced locally, and enforced

| PostgreSQL | Locally |
|---|---|
| `CREATE TABLE [IF NOT EXISTS]` in `public` | a table, columns in order |
| `DROP TABLE [IF EXISTS] ... [CASCADE]` | dropped; `CASCADE` drops the foreign keys into it, without it a dependent key is an error |
| `ALTER TABLE ... ADD COLUMN [IF NOT EXISTS]`, `DROP COLUMN [IF EXISTS] [CASCADE]`, `RENAME COLUMN`, `RENAME TO` | applied; keys, indexes, foreign keys, and seed rows follow renames and drops |
| `ALTER COLUMN ... TYPE`, `SET/DROP DEFAULT`, `SET/DROP NOT NULL`, `ADD/DROP IDENTITY` | applied (`USING` is not run on seed rows). A dropped or replaced default ends what it did: the numbering of a `serial`, the UUID of `gen_random_uuid()` |
| `PRIMARY KEY` (column or table, one or several columns) | primary key |
| `ADD [CONSTRAINT name] PRIMARY KEY \| UNIQUE USING INDEX index` | a key over the index's columns. The index becomes the constraint's own and is no longer listed as an index; the constraint has the index's name unless it is given one, in which case the index is renamed, as in PostgreSQL |
| `REFERENCES` / `FOREIGN KEY` (one or several columns, `ON DELETE`/`ON UPDATE` actions, the referenced table's key when no columns are named) | foreign key, enforced |
| `UNIQUE` (column or table), `ADD/DROP/RENAME CONSTRAINT` | unique constraint, enforced; names kept (PostgreSQL's default names: `<table>_<columns>_key`, `_fkey`, `_pkey`) |
| `NOT NULL`, `NULL` | nullability |
| `DEFAULT` with a constant (also cast: `'{}'::jsonb`, `'t'::boolean`) | static default. For a `bytea` column, the bytes (`'\x0102'`) |
| `DEFAULT` with an array: a literal (`'{}'`, `'{a,"b c",NULL}'`, `'{{1,2},{3,4}}'`) or `ARRAY[...]` over constants | static default: an array, with elements of the element's type (numbers, booleans, text, `NULL`, arrays within). On an array column `'{}'` is the array without elements, not an object. A backslash makes the next character itself, within quotes and outside them |
| `DEFAULT now()`, `current_timestamp`, `localtimestamp`, `timezone('utc', now())`, `transaction_timestamp()`, ... on `timestamp`/`timestamptz` | computed at the write (`current_timestamp`) |
| `DEFAULT current_date` on `date` | computed at the write (`current_date`) |
| `serial`, `bigserial`, `GENERATED ... AS IDENTITY`, `DEFAULT nextval(...)` on a single integer primary key | numbered by the runtime. `serial` and `nextval(...)` are defaults, an identity is not: the one ends with `DROP DEFAULT` or another default, the other with `DROP IDENTITY` |
| `CREATE [UNIQUE] INDEX [IF NOT EXISTS]` over columns, `DROP INDEX`, `ALTER INDEX ... RENAME` | index created (a unique one enforced); `gin`, `gist`, ... become ordinary indexes |
| `CREATE TYPE ... AS ENUM`, `ALTER TYPE ... ADD VALUE [BEFORE/AFTER]`, `RENAME VALUE`, `ALTER TYPE ... RENAME TO`, `DROP TYPE` | the column takes those values only |
| `INSERT ... VALUES` with constants (and `DEFAULT`, `now()`), `ON CONFLICT DO NOTHING` | rows loaded into the new database; an array literal or `ARRAY[...]` is an array there too |

Column types as the runtime stores them: integers (`int2`, `int4`, `int8`, `serial`s) `integer`; `numeric`/`decimal` `numeric`; `real`/`double precision` `real`; `boolean`; `timestamp`, `timestamptz` `datetime`; `date`; `json`, `jsonb`, and every array type `json`; `bytea` `binary`; `text`, `varchar`, `char`, `uuid`, `citext`, `time`, `timetz`, `interval`, `inet`, `cidr`, `macaddr`, `money`, `bit`, `xml`, `tsvector` `text`.

Besides the storage type, a column keeps its type three more ways (D-036). None of them changes how values are stored or what the runtime enforces:

| Field | What it is | `bigint` | `numeric(12, 2)` | `timestamp with time zone` |
|---|---|---|---|---|
| `declaredType` | the type as the migration wrote it, with its spaces collapsed | `bigint` | `numeric(12, 2)` | `timestamp with time zone` |
| `sourceDialectType` | PostgreSQL's own name for it, with its modifiers | `int8` | `numeric(12,2)` | `timestamptz` |
| `canonicalType` | what the type is, independent of spelling and dialect | `integer`, 64 bits | `decimal`, precision 12, scale 2 | `timestamp` with time zone |

### Canonical types

Every spelling of one type gives the same canonical type, and types that PostgreSQL keeps apart give different ones. This is what [`diff-schema`](#schema-diff-diff-schema) compares.

| PostgreSQL | Canonical type |
|---|---|
| `smallint`, `int2`, `smallserial` | `integer`, 16 bits |
| `integer`, `int`, `int4`, `serial` | `integer`, 32 bits |
| `bigint`, `int8`, `bigserial` | `integer`, 64 bits |
| `real`, `float4`, `float(1)` to `float(24)` | `float`, 32 bits |
| `double precision`, `float8`, `float`, `float(25)` to `float(53)` | `float`, 64 bits |
| `numeric`, `decimal`, `dec`, with `(p)` or `(p, s)` | `decimal`, with its precision and scale; `numeric(10)` is `numeric(10, 0)`. A scale may be below zero or above the precision (`numeric(5, -2)`, `numeric(3, 5)`) |
| `boolean`, `bool` | `boolean` |
| `text` | `text` |
| `varchar`, `character varying`, with `(n)` | `varchar`, with its length; without a length it is still not `text` |
| `char`, `character`, `bpchar`, with `(n)` | `char`, with its length; `char` alone is `char(1)` |
| `uuid` | `uuid` |
| `date` | `date` |
| `time`, `timetz`, `time with time zone`, with `(p)` | `time`, with or without time zone, with its precision |
| `timestamp`, `timestamptz`, `timestamp with time zone`, with `(p)` | `timestamp`, with or without time zone, with its precision (`timestamp(0)` has one) |
| `interval`, `interval(p)` | `interval`, with its precision |
| `json`, `jsonb` | `json`; `jsonb` is marked `binary` |
| `bytea` | `binary` |
| an enumerated type of the schema, also written `public.<type>` | `enum`, by the type's name |
| any type with `[]`, `[n]`, or `ARRAY` | `array` of the element's type; declared sizes and dimensions are not part of the type, as in PostgreSQL |
| anything else: `inet`, `citext`, `money`, `bit(3)`, `geometry(Point, 4326)`, an interval restricted to fields (`interval day to second`), a type of another schema | `other`: kept as PostgreSQL's type, by its name and modifiers. Two of them are the same type only when both agree |

A modifier written as text is the number it says, as it is to PostgreSQL: `numeric('12', '2')` is `numeric(12, 2)`.

A type that is `other` is not given a meaning by guessing. Its storage type is as listed above when the collector knows the name, and `any` (stored as given, and reported) when it does not.

### Names of what a migration does not name

Keys, constraints, and indexes are stored with the names PostgreSQL gives them, so that a later `DROP CONSTRAINT` in a migration, and a comparison of two schemas, find them. The rules are PostgreSQL's (`makeObjectName`, `ChooseRelationName`, `ChooseConstraintName`, `ChooseIndexColumnNames`):

| Object | Name |
|---|---|
| primary key | `<table>_pkey` |
| unique constraint | `<table>_<columns>_key` |
| foreign key | `<table>_<columns>_fkey` |
| check | `<table>_<column>_check` when its expression uses exactly one column of the table, wherever it is written; `<table>_check` otherwise |
| index (`CREATE [UNIQUE] INDEX` without a name) | `<table>_<columns>_idx`; an expression counts by the name of its function or column, else `expr` |
| sequence of a `serial` or identity column | `<table>_<column>_seq`. Not created; its name is taken, as in PostgreSQL |

- A name is at most 63 bytes. It is cut from the longer of its two parts (the table's and the columns'), and never within a character.
- A name that is in use is tried again with a number after its label: `t_a_key`, `t_a_key1`, `t_a_key2`. The number makes the label longer, so a name that was cut is cut further.
- Index and constraint names are in use across the schema, not per table. A key's name must be free as an index's and as a constraint's.
- The columns an index only carries along (`INCLUDE`) are part of the name of the index and of a unique constraint, after its key columns: `unique (c1, c2) include (c3, c4)` on `tbl` is `tbl_c1_c2_c3_c4_key`. They are part of nothing else here: the schema does not keep them, and the report says so.
- Renaming a table does not rename its keys, constraints, and indexes, and their names stay taken. Dropping one frees its name.
- A `serial` column's sequence keeps its name for as long as the column is there, whatever becomes of the default; an identity column's goes with the identity. An identity added to a column that was `serial` therefore gets `<table>_<column>_seq1`.
- A name that was worked out this way is marked (`origin.generatedName`); a name the statement gives is kept as it is.

### Provenance and renames

Every table, column, key, constraint, index, and enumerated type of the collected schema says where it comes from, and the database stores it (`schema.json`, [docs/FORMAT.md](FORMAT.md)):

- `origin`: the migration file, the SHA-256 of its bytes, the number and line of the statement that created the object, and the name it was created with. A column of `CREATE TABLE` has the statement's position, not the line it is written on.
- `renames`: every rename a migration states, oldest first, each with the position of its statement: `ALTER TABLE ... RENAME TO`, `RENAME COLUMN`, `RENAME CONSTRAINT`, `ALTER INDEX ... RENAME TO` (which renames the key or unique constraint whose index it is), `ALTER TYPE ... RENAME TO`. An enumerated type also records `ALTER TYPE ... RENAME VALUE` (`valueRenames`).
- An object that is dropped and created again is another object, with a new origin and no renames.
- A migration file whose bytes change gives everything it created another origin. The schema is the same; a rename of those objects can then no longer be told from a drop and an add.

Provenance is information. It changes nothing the runtime does, and two schemas never differ because of it.

### What the text of an expression names

A check, an index's expression or condition, and a default that is an expression are kept as the text the migration wrote. PostgreSQL keeps what the text meant, and follows a rename by itself; the text stays as it was written. So the collected schema says what each text names (`names`, `defaultNames`), and what each of those things is called now:

```json
{ "name": "items_price_check", "expression": "price > 0", "names": [{ "kind": "column", "name": "price", "now": "price_cents" }] }
```

- Listed are the columns of the table that the text names, the table itself where the text says its name, the enumerated types it casts to, and the values of enumerated types in it (those of a type the expression has to do with: by a cast, or by the type of a column it names). An empty list says that the text names none of them. A default names no column.
- A function, and a type that is not enumerated (a domain, a type of several parts), is listed only when it was renamed since.
- A name with a `now` is stale: the text is no longer what PostgreSQL has. Renamed back, a name is not stale. Each rename that leaves a text behind is in the report of `init` (`retained`).
- Followed: `RENAME COLUMN`, `ALTER TABLE ... RENAME TO`, `ALTER TYPE ... RENAME TO` and `RENAME VALUE`, `ALTER FUNCTION` (`ROUTINE`, `PROCEDURE`, `AGGREGATE`) `... RENAME TO`, `ALTER DOMAIN ... RENAME TO`.
- A column that is dropped takes with it the checks that name it and the indexes that name it in an expression or a condition, or carry it along, as in PostgreSQL.
- A default written as a value of an enumerated type on a column of another type (`('ok'::mood)::text`) is kept as that value, and follows the value's and the type's renames.

It is information: it changes nothing the runtime does, and two schemas never differ because of it alone. `diff-schema` and `generate-migration` use it (below).

### Kept as information, not enforced

- How an index is built (`USING gin`, `gist`, `hash`, `brin`, or an extension's method) and what its keys are: their order, a descending key, where its NULLs stand, an operator class, a collation, the place of an expression among columns, and the columns it carries along (`INCLUDE`). The runtime creates an ordinary index over the columns; the schema says the rest (`method`, `keys`, `include`). What PostgreSQL refuses of a method is refused: a unique `hash` index, a descending key of a `gin` index.
- Whether a primary key, a unique constraint, or a foreign key is deferrable, and what it starts out as (`deferrable`). The runtime checks every constraint at each statement. A foreign key that would rest on a deferrable key is refused, as in PostgreSQL.
- What the schema has no place for, kept as text on the object (`sourceClauses`): `MATCH FULL`, `NOT VALID` until the constraint is validated, `NOT ENFORCED`, `NO INHERIT`, `ON DELETE SET NULL (columns)`, storage parameters (`WITH (...)`), a tablespace, the parameters of an operator class. Such an object is reported (`retained`), is another object to `diff-schema` than one without, and is not written by `generate-migration`.

- Check constraints, with their expression (`id = 1`). An expression (of a check, an index, or a default) is the migration's own text: all of it, without parentheses around the whole and without a comment after it.
- Indexes over expressions (`lower(email)`) or with a condition (`WHERE deleted_at IS NULL`): not created, so a unique one of these does not keep duplicates out.
- Defaults the runtime does not compute: `gen_random_uuid()` and `uuid_generate_v4()` (`generated: "uuid"`; a row written without the value gets none, or is refused if the column is `NOT NULL`), and any other expression. An array default that is not an array of constants of the element's type is such an expression: one that says its own bounds (`'[1:2]={a,b}'`), one with an expression in it (`ARRAY[lower('A')]`), and what PostgreSQL itself refuses.
- `serial` or identity numbering of a column that is not a single integer primary key.
- Generated (computed) columns: they hold what is written to them.
- `NULLS NOT DISTINCT` of a unique constraint.
- Types the collector does not know (domains, composite types, types of extensions such as `vector` or `geometry`): the column is stored as given (`any`).

### Not reproduced locally, on purpose

| PostgreSQL / Supabase | Why |
|---|---|
| Row level security: `ENABLE/FORCE ROW LEVEL SECURITY`, `CREATE/ALTER/DROP POLICY` | the sandbox has no database users; every client reads and writes every row |
| Roles, `GRANT`/`REVOKE`, default privileges, ownership | the same |
| Extensions (`CREATE EXTENSION`) | what they provide is not available; SQL that uses it fails |
| Functions, procedures, `DO` blocks, `SELECT`s run for their effect | not run; SQL that calls a function fails |
| Triggers | rows written locally do not get what a trigger would do |
| Scheduled jobs (`pg_cron`: `select cron.schedule(...)`) | nothing is run on a schedule; what a job calls must be called by hand |
| Publications and subscriptions (replication, Supabase Realtime) | no replication |
| Schemas other than `public` (`auth`, `storage`, `extensions`, ...), their tables and types, statements that change those (`ALTER TYPE app.status ...`), and foreign keys into them | not created, and never taken for the object of that name in `public`; such a foreign key column takes any value, and a column of such a type is stored as given |
| Sequences (`CREATE SEQUENCE`) | numbering is the runtime's, for a single integer primary key |
| Temporary tables (`CREATE TEMPORARY TABLE`, `CREATE TEMP TABLE ... AS`, `SELECT ... INTO TEMP`, a table in `pg_temp`), their indexes, and what is done to one | a temporary table is no table of the database. As in PostgreSQL, it hides a table of the same name for as long as it is there. It is there until it is dropped; until its transaction is committed or rolled back, if it was made with `ON COMMIT DROP`; and to the end of its migration file at the latest, since no migration can count on the session of another. Its indexes are known by their names, so `ALTER INDEX ... RENAME` and `DROP INDEX` of one are read, and they go with it. An unlogged table is a table like any other |

### Unsupported

These change the schema or the data in a way the collector does not handle. They are listed when `init` runs, and `--strict` refuses them:

- Views and materialized views, `CREATE TABLE ... AS`.
- `UPDATE`, `DELETE`, `TRUNCATE`, `MERGE`, `COPY`, `INSERT ... SELECT`, and `ON CONFLICT DO UPDATE` in migrations: seed rows are not changed by them.
- Domains, composite and range types.
- Table inheritance, partitioning, typed tables, `LIKE`.
- `EXCLUDE` constraints, and other `ALTER TABLE` actions than those above.

### Errors

A migration PostgreSQL cannot parse is an error at its file, line, and column. A chain PostgreSQL would refuse (a table created twice, a column or table that is not there, a drop that something depends on without `CASCADE`, a duplicate key among the seed rows, a `NOT NULL` column added to a table that has rows, a type or a value of a type renamed to a name that is taken, a default set or dropped on an identity column, an identity added beside a default or to a column that takes NULL, a key made from an index that is missing, another table's, not unique, partial, or over expressions) is an error at the statement it would refuse. In both cases nothing is written.

So is what PostgreSQL refuses because of what rests on what (D-039):

- a foreign key to columns that no primary key, unique constraint, or unique index (over columns only, without a condition) is over;
- a key or unique index dropped while a foreign key rests on it. With `CASCADE` the foreign keys that rest on it alone go with it;
- a table that takes the name of an enumerated type, or a type that of a table: PostgreSQL keeps a type for every table, under the table's name;
- an enumerated type dropped while a default is a value of it, which a default still is after its column became another type. With `CASCADE` those defaults go;
- a column that changes from one enumerated type to another while it has a default: PostgreSQL does not convert the default;
- an identity column whose type is to be no whole number.

These are refused only while the collector has seen everything that changed the schema. After a `DO` block, a function called for its effect, or a statement listed as unsupported, PostgreSQL may have a key or lack a type that the collector does not know of, and none of them is refused any more: migrations that PostgreSQL takes are not refused for what the collector could not see.

A database is not written either when its definitions could not be read back from it: the storage reads its schema document with its own reader first, and refuses the save with what that reader says.

### Limits

- Files are applied in the order of their leading version number (`0001_`, `20240101120000_`, `V10__`), or by name when not every file has one. Subdirectories and `.sql` files outside the migrations directory are not read; neither are seed files outside it (`supabase/seed.sql`).
- An existing database is replaced only with `--force`, and its rows are lost. `diff-schema <database> <migrations>` says what new migrations change in it; applying that to a database while keeping its rows is not implemented.
- A computed default in a seed row (`updated_at` of a row inserted by a migration) is computed once, when `init` creates the database.

## Schema diff (`diff-schema`)

`local-db-sandbox diff-schema <before> <after>` says what differs between two schemas. It reads both and changes neither, and it generates no SQL: the result is a list of changes, as lines or as JSON. Status: experimental (D-036 and D-037). Verified with a real Supabase project's migrations (the record is kept outside this repository).

A side is a database directory or a single-file database (the definitions it stores), a schema file (a document such as `schema.json`), PostgreSQL migrations (collected as `init` collects them), or TypeORM entities (collected as `init-nest` collects them; see "TypeORM entities as a side" below). What is compared is the sandbox's canonical schema, whatever it was read from.

### What is compared

| Object | Compared by | Changes |
|---|---|---|
| Table | its name | `addTable`, `dropTable`, `renameTable` |
| Column | its name, type, nullability, and default | `addColumn`, `dropColumn`, `renameColumn`, `alterColumnType`, `setNotNull`, `dropNotNull`, `setDefault`, `dropDefault` |
| Primary key | its name, and its columns in the key's order | `addPrimaryKey`, `dropPrimaryKey`, `renameConstraint` |
| Unique constraint | its name, and its columns in order | `addUnique`, `dropUnique`, `renameConstraint` |
| Foreign key | its name, its columns, the table and columns it refers to, and its `ON DELETE` and `ON UPDATE` actions | `addForeignKey`, `dropForeignKey`, `renameConstraint` |
| Check constraint | its name and its expression | `addCheck`, `dropCheck`, `renameConstraint` |
| Index | its name, its columns in order, whether it is unique, its expressions, and its condition | `addIndex`, `dropIndex`, `renameIndex` |
| Enumerated type | its name, and its values in order | `addEnumType`, `dropEnumType`, `renameEnumType`, `addEnumValue`, `removeEnumValue`, `renameEnumValue`, `replaceEnumValues` |

- A key, constraint, or index whose definition changed is a drop and an add under its name; nothing is altered in place. A foreign key with another action is one of these.
- An added table's indexes and foreign keys are changes of their own, after all tables. A dropped table's are listed in what the change says it had.
- A change of a type that several columns use is one change of the type, and none of the columns.
- `replaceEnumValues` stands for values in an order that adding and removing cannot give.

### How things are compared

| What | Rule |
|---|---|
| Column types | By canonical type: `integer` and `int4` are one type; `varchar(50)` and `varchar(100)`, `timestamp` and `timestamptz`, `json` and `jsonb` are not. |
| Column types, when a side has no canonical type (a schema written by hand, or made from TypeORM entities) | By storage type, declared spelling (apart from case and spaces), and enumerated type. The change says `comparedBy: "declared"`, and its line says which of the three differ. A spelling is never taken to mean a type: `int` and `integer` are then a difference. |
| Defaults | By what they are: a constant (an object by its content, not the order of its keys); a default the runtime computes (`now()`, `CURRENT_TIMESTAMP`, and `timezone('utc', now())` are one); the next number (`serial`, identity); a value the source's database generates (`gen_random_uuid()`), by its expression; another expression, as text. |
| Foreign key actions | With `NO ACTION` for a key that gives none, in any case. `RESTRICT` is not `NO ACTION`. |
| Expressions (checks, index expressions and conditions, default expressions) | As text, apart from layout: line breaks and runs of spaces. A text with a quote character or a comment is compared exactly, since spaces count within a quoted text. Two texts that read alike are the same expression only when they name the same things (below). |
| Indexes | By their columns, expressions, uniqueness, and condition, and by how they are built: the method, the keys in their order with each key's direction, place of NULLs, operator class, and collation, the columns carried along (in any order), and `NULLS NOT DISTINCT`. An index that differs in any of it is another index: `USING gin (tags)` is not `USING btree (tags)`, and `(a, b DESC)` is not `(b DESC, a)`. An index of an earlier format that is over columns and expressions without saying their order is not the same as one that says it. |
| Keys and constraints | Also by whether they are deferrable and what they start out as, by the columns a key carries along, and by `NULLS NOT DISTINCT`. A constraint that differs in any of it goes and comes. |
| What a schema only says is there (`sourceClauses`) | As text: an object with a clause is another object than one without it, or with another. |
| Constraints without a name | By their definition: the columns of a unique constraint, the expression of a check, the columns and target of a foreign key. A named one and an unnamed one of the same definition are the same constraint. |
| The primary key of a schema without key constraints | The columns marked as key columns, in any order and under any name. |

Whatever has no canonical form is compared conservatively: two spellings that may mean the same are reported as a change, and nothing is called equal by guessing.

**Two expressions that read alike.** A rename leaves the text of an expression as it was, so the same text can be over a column on one side and over another column, which has taken the name, on the other. The diff compares by what the schemas say the texts name (`names`, D-040):

| The two sides | The texts are one expression when |
|---|---|
| both say what the text names | every name leads, by the renames of this diff, from what the before side calls the thing to what the after side calls it, and both name the same things |
| one says it | the same, with the other side's text taken as written in the names that side has |
| neither says it (schemas written by hand, by an ORM, or of an earlier format) | no rename of this diff can reach the text; across a rename of a column of the table, of the table, of an enumerated type, or of a value, only when the two are one object (the same origin) |
| a text may be stale (`mayBeStale`) | the two are one object, or both may be and nothing is renamed between them |

- A column that a check names is renamed: the check is the check it was, and the diff is the rename alone. Also when another column takes the old name.
- The column is renamed, another takes its name, and the check is written again: two checks. The one goes (before the rename) and the other comes (after it), though both read `price > 0`.
- The diff knows no functions and no types but enumerated ones. Of one object, such a thing is the one it was; of two, it is when both sides call it the same.
- A default has no object of its own: it is compared by what its text names, never by identity. A default of which the schema says nothing is set again when a type or a value is renamed; one whose text calls a function that was renamed is reported as changed, to a text that is stale.
- A default that the runtime computes (`now()`) is what it computes, whatever its text names.
- A change says what the text that comes names (`after.names`), and what a default was is said in the names the after side has.

### Renames

A different name is a rename only on explicit evidence, which is all of:

1. the two objects have the same origin: the same statement of the same file, with the same hash, created them, under the same name;
2. the renames the before side records are the start of those the after side records; and
3. the rest of those lead from the before side's name to the after side's.

The change then carries that origin and that rest, and its line names the file and line of the last one. Without all of it, a different name is a drop and an add, however alike the two objects are. Nothing is matched by similarity.

- Evidence comes before names: a column that was renamed stays renamed when a new column has taken its old name. The result is a rename and an added column.
- A value of an enumerated type is renamed when both sides are the same type, the renames of values that the before side records are the start of those the after side records, and the rest lead from values of the one to values of the other, never onto a value that is there already.
- What refers to a renamed object follows it: a foreign key to a renamed table, an index on a renamed column, a column of a renamed type, and a default that is a renamed value are not changes.
- An object that is dropped is never the object that takes its name. When a column is dropped and another is renamed to its name, the keys, constraints, indexes, and foreign keys over the dropped column are dropped, and those over the renamed one are added: they are not taken for the same because their columns are called the same.
- An enumerated type that is renamed onto the name of a type that is dropped is reported as a change of the type of that name (its values) and a drop of the other. A type can only be dropped after the renames, when no column has it, so the name would still be taken; and a type holds no rows, so the result is the same.
- A database made by `init` stores where its objects come from, so a rename in a later migration is found when the database is compared with the migrations.

### Order

Changes are listed by kind, in three parts. The exact list is `CHANGE_ORDER` in `packages/schema-diff/src/ir.ts`.

1. What goes: dropped foreign keys, checks, unique constraints, indexes, and primary keys; then dropped columns and tables.
2. The renames: of enumerated types, their values, tables, columns, constraints, and indexes.
3. What comes and what changes: added enumerated types, added and replaced values; added tables and columns; dropped defaults, changed types, nullability, defaults; removed values and dropped enumerated types; added primary keys, unique constraints, checks, indexes, and foreign keys.

Carried out in this order, a diff turns the before schema into the after schema: a thing goes after what depends on it, a name that a drop gives up is free before a rename takes it, a type is there before a column uses it and goes when none does, and a foreign key comes after the key it refers to.

Within a kind, changes are in the order of the table's (or type's) name, then the object's name, then everything else the change says, by code point; a constraint without a name is placed by its definition. The values added to one type keep the order in which they can be added. The order does not depend on how a schema lists its tables, types, constraints, or indexes.

A change names things as they are called where it stands in the list:

- A drop stands before the renames, so it, and what it says the object was, uses the before side's names.
- Everything after the renames uses the after side's names, also in what it says a column was before: a renamed table, column, type, or value has its new name there.
- Declared spellings and expressions are text of the source and stay as written.

### The diff as JSON

`--json` prints `{ "diffVersion": 1, "changes": [ ... ] }` and nothing else. A change has an `op` (one of the 30 kinds above), the names it concerns (`table`, `column`, `constraint`, `index`, `enum`, `value`, `from`, `to`), and what the object was or is (`before`, `after`): a column with its type (`storage`, `canonical`, `declared`), nullability, and default; a key or constraint with its columns; and so on. A rename has its `evidence`.

Every object's keys are written in one fixed order, with two spaces of indentation. The same two schemas give the same bytes on every run, in whatever order they list their objects and whatever kind of source each was read from. No path is part of it.

### Not compared

- The order of a table's columns. (The order of the columns of a key, a constraint, or an index is.)
- The place of an expression among the columns of an index: the schema keeps an index's columns and its expressions as two lists, so `(a, lower(b))` and `(lower(b), a)` are one index to it.
- The columns an index only carries along (`INCLUDE`), which the schema does not keep.
- How the runtime stores a column whose canonical type is known, a column's property name, and the dialect's own name for a type.
- Where a schema comes from. Squashed migrations and the chain they replace give no differences.
- Rows.
- What the collector does not collect: views, functions, triggers, row level security, sequences, and other schemas.

### Limits

- A rename can only be told while the migration file that created the object is unchanged. After an edit of that file, also of a comment in it, the rename is a drop and an add.
- From a later state to an earlier one, a rename is a drop and an add: undoing a rename is not a recorded rename.
- Within a kind the order is by name, not by dependence. Three cases need care from whoever carries a diff out: tables that are dropped together and refer to each other; renames of one kind of which one takes the name another gives up (`a` to `b` and `b` to `c`, or two names exchanged); and several changes to the values of one enumerated type.
- An expression is never rewritten. What follows a rename is what the schema says its text names; for a schema that says nothing of that, a text is followed through a rename only as one object's.
- Renames of what a schema does not keep, other than functions and types, are not followed into a text: a collation, an operator class, a sequence or a table that a text names as `regclass`, a schema.
- A constant default is compared as the number or text it was read as. Two numbers beyond what a JavaScript number holds exactly may compare equal.
- A schema without canonical types is compared as declared, which reports spellings that may mean the same. Directory format 2 did not keep declared types at all, so comparing such a database with a later one reports every declared type as a difference.
- Migrations with statements the collector does not support may leave a schema that differs from PostgreSQL's; the command says so on stderr and compares what was collected.
- It does not generate migrations, and it does not apply a diff to a database.

### TypeORM entities as a side

Experimental (D-044). `diff-schema`, `plan-migration`, and `generate-migration` take TypeORM entities as `<before>`, as `<after>`, or as both. No option says so: what a path is is decided by what is there.

| Given | Read as | Where the entities are |
|---|---|---|
| a directory whose `manifest.json` states a format | a database, always | |
| a directory that holds `.sql` files itself | migrations, always | |
| a directory with `.local-db-sandbox/sandbox.config.json` | a NestJS project that `init-nest` set up | the folder of the entry point the configuration names |
| a directory with `package.json`, for which `typeorm` is installed | a NestJS project | the folder of its entry point: `sourceRoot` and `entryFile` of `nest-cli.json`, or `src/main.ts` |
| another directory with files that declare an entity | a folder of entity files | that folder, and the folders in it, without `node_modules` |
| a source file (`.ts`, `.cts`, `.mts`, `.js`, `.cjs`, `.mjs`) that declares an entity | one entity file | that file |

- A file declares an entity when its text has `typeorm` and one of `Entity`, `ChildEntity`, `ViewEntity`, `EntitySchema` as a word. That is looked for by reading the file. It is the rule `import-typeorm` and `init-nest` load files by.
- The schema is the one `init-nest` stores for those entities (`databaseSchema`, D-040): tables, columns with their canonical types as TypeORM's PostgreSQL driver reads the declarations, enumerated types, single-column keys, and defaults that are values. A database directory that `init-nest` made and the entities it was made from do not differ.
- The same entities give the same schema, and so the same bytes with `--json`, however they were given (the project, its folder, a copy elsewhere) and however often. Files are read in the order of their names.

**What is loaded, and what is not.** The files that declare an entity, by the project's own `typeorm` and `typescript`, and whatever those files import. Loading a file runs its top-level code, as for `init-nest`. Nothing else of the project is loaded: not the entry point, a module, a controller, a service, or the settings of `TypeOrmModule.forRoot`. No `DataSource` is made and nothing is connected to. A source file that was named and declares no entity is refused, and not loaded to see.

**Connections.** While entity files are loaded, and for one turn of the event loop after, the network guard is in `block` mode: a TCP connection that leaves this machine, and the look-up of a name for one, is refused (see "What the network guard covers" for what it sees). If one was tried, the command fails, names the host and the port, and compares nothing. It is the guard of the sandbox: a development aid against code that connects when it is loaded, not a security boundary. Code that does not handle the failure of its own connection ends the command with that error instead. A guard that is installed in the process already is left as it is.

**A project with migrations and entities both.** A directory in which migrations are found in a folder of their own (`supabase/migrations`, `migrations`, ...) and entities are found too is refused, with both folders named: each can be given itself. Before D-044 such a project was read as its migrations. A directory in which no entity is found is read as its migrations, as before.

**What entities do not say.**

| Of the entities | In the schema | Noted when read | A change that is of it |
|---|---|---|---|
| indexes, unique constraints (also `unique: true` of a column), check constraints | never | no | an index, a unique, or a check constraint of a table the entities have that is dropped where the entities are `<after>`, or added where they are `<before>` |
| the default a database gives a column TypeORM fills (`@CreateDateColumn`, `@UpdateDateColumn`); a default that is an expression, or the stored text of a list or a document | no | no | that column's default dropped where the entities are `<after>`, or set where there was none and they are `<before>` |
| a join table (`@ManyToMany` with `@JoinTable`); an entity that was skipped (`EntitySchema`, table inheritance and its children, a name another entity has) | no | yes | any table dropped where the entities are `<after>`, or added where they are `<before>` |
| an embedded column; a column of a kind that is not read; the key column of a relation with several join columns, or to an entity without one primary column | no | yes | a column of that entity's table dropped or added in the same way, and a primary or foreign key of it |
| what a key column refers to, where the related entity was not read or the column it names is not found | the column, without the reference | yes | a primary or foreign key of that entity's table dropped or added in the same way |

- `diff-schema` and `plan-migration` show such a change as any other, and say on stderr how many there are: `Note: 4 of the changes are of what <after> does not say. It was read from TypeORM entities, ...`. It may be a difference, or only what was not read.
- `generate-migration` writes no migration while the plan has such a step: `Error: No migration was generated: 4 of the 9 steps are of what <after> does not say. ...`, with each step. Exit code 1, nothing on stdout, also with `--json`, and no file with `--out`. This is a rule of the command for a side that says less; the diff, the plan, and the generator are as they were.
- Not noted, and not a reason to refuse: what is only about how the sandbox treats rows (a transformer, lifecycle hooks, `select: false`), a view, a property that is no column, and a type that is kept as it was declared. A declared type PostgreSQL does not have (`datetime`, `tinyint`) has no canonical type: it is compared as declared, and the generator refuses to write it (`no-canonical-type`), as for any schema.

**What is refused, and how it is told apart.** Each with exit code 1, and nothing compared:

| Case | The message says |
|---|---|
| A project whose entities are not found | `... is a project with TypeORM whose entities are not found: it has no .local-db-sandbox/sandbox.config.json ..., and no entry point at src/main.ts. Give the folder that holds its entity files.` |
| A project for which `typeorm` is not installed, or a directory with nothing of any kind | `... is neither a database directory (...), nor PostgreSQL migrations (...), nor TypeORM entities (...).` |
| No entity file where the entities would be | `... has no TypeORM entity: no file in ... declares one, so there is nothing to compare.` |
| Entity files of which no entity can be read | `There is nothing to compare: No importable TypeORM entities found in ...`, with the reason for each |
| A source file that declares no entity | `... declares no TypeORM entity, and was not loaded: ...` |
| Migrations and entities both | `... has PostgreSQL migrations (...) and TypeORM entities (...) both. Give the one to compare.` |
| Entity files that cannot be loaded, or `typeorm` or `typescript` missing where they are | `The TypeORM entities in ... were not collected: ...`, with the file and the reason |
| A connection, or the look-up of a name, that was tried while loading | `The TypeORM entities in ... were not collected: loading the entity files tried to reach <host>:<port>, which was refused.` |
| Steps of what entities do not say (`generate-migration`) | `No migration was generated: <n> of the <m> steps are of what <side> does not say.` |

Nothing is ever compared with a schema without tables in place of entities that were not read.

**Limits.**

- Entities are found for a NestJS project as `init-nest` finds them. A project of another shape (a monorepo's root, entities outside the entry point's folder, plain TypeORM without NestJS) is given by the folder of its entity files.
- A single-file database stores no table definitions, so the database to compare entities with is a database directory.
- An entity file is read as it is on disk when the command runs, and once per run.
- What the entity collection does not read is not read here either: `EntitySchema`, table inheritance, embedded columns, join tables, relations with several join columns, and custom naming strategies. Nothing was added to the collection but what it reports (`ImportIssue.omits`).
- Only TypeORM's PostgreSQL reading of a declaration gives a canonical type (D-040).

## Migration plan (`plan-migration`)

`local-db-sandbox plan-migration <before> <after>` prints the plan of the diff of two schemas: in which steps the differences would be carried out. It reads the two as `diff-schema` does, carries nothing out, and generates no SQL. Status: experimental (D-038). The planner is `packages/migration`, which is not part of the package's public API yet.

### What a plan is

`{ "version": 1, "steps": [ ... ] }`. A step is a change as the diff writes it (one of the same 30 kinds), and says things as they are when the step is carried out: the names things have at that step, and in `before` what the thing is then. A step that the planner added has `planned` with the reason, and one that gives a temporary name has `temporaryName`.

### The rules a step keeps

A step is only planned at a point where a database lets it be carried out:

| Rule | So |
|---|---|
| A foreign key refers to a table and to columns that are there | a table or column is not dropped while a foreign key refers to it; a foreign key is added when what it refers to is there |
| A key, a foreign key, or an index is over columns that are there, and so is what a key or an index carries along, and what a check or an index's expression or condition names | a column is not dropped while one of them is over it, carries it along, or names it. PostgreSQL would drop the thing with the column without a word; a plan drops it first, as a step of its own. (Which columns a text names is known where the schema says it; of a text of which it says nothing, nothing is refused.) |
| A column is of a type that is there | an enumerated type is there before a column takes it, and is not dropped while one has it |
| A value is added to a type next to a value the type has | values are added in the order in which each has what it is put next to |
| A name is one object's: a table's and a type's in the schema, a column's and a constraint's in its table, an index's in the schema (the sandbox creates an index by its name, as PostgreSQL does) | a name is given up before it is taken |

### Order, and the steps the planner adds

- The order does not come from the diff's list, which is an order of names. Of the steps that can be taken, the first by kind (as the diff orders kinds) and then by all the change says is, so that one diff has one plan. Where that order can be carried out as it stands, it is the plan.
- **Tables that are dropped.** A table goes before the table it refers to. Tables that refer to each other cannot go in any order, so the foreign keys between them that are in the way are dropped first, as steps of their own (`tables-dropped-together`). A foreign key of a table that stays is never dropped by the planner: the diff has to.
- **Names that are passed on** (`a` to `b`, `b` to `c`): the one that gives a name up goes first.
- **Names that go round** (`a` to `b` and `b` to `a`, or more): one object is renamed to a temporary name, the others take their names, and it takes its own from there (`rename-cycle`). One temporary name is enough for a ring of any length.
- **Temporary names** are `migration_tmp_1`, `migration_tmp_2`, ..., in the order of the plan, leaving out every name that either schema has for anything. The object of a ring that moves out of the way is the one whose name comes first. Both are the same on every run.
- **Names of different kinds of object.** Which kinds share their names differs between databases (in PostgreSQL a table and an index are both relations, a key has an index of its name, and a table has a type of its name). The plan relies on none of it: among the renames of tables, enumerated types, constraints, and indexes a name is given up before it is taken, whatever kinds the two are and whichever tables they are in, by way of a temporary name where such names go round.
- **A name taken from something that is dropped**: the drop comes first, as in the diff.

### Refused

- A diff that does not fit the schema it is applied to.
- A schema that a database would refuse: a foreign key to a table or column that is not there (also one that the diff does not touch, so a schema that is part of a database is not planned), a default that is no value of its column's enumerated type, one name for two constraints of a table or for two indexes.
- A step that can be taken at no point, with the step and the reason: an enumerated type that is dropped while a column is still declared with it.
- A key or constraint that the schema to arrive at leaves without a name while another constraint of its table takes the name it had. In a database it needs a name; give it one in that schema.

### Limits

- A plan has no SQL in it and no database's syntax. For PostgreSQL, [`generate-migration`](#postgresql-migration-generate-migration) writes one as SQL; nothing is applied to a database.
- The rules are those that databases share. PostgreSQL also refuses to drop a key or unique index that a foreign key rests on, and keeps a table's row type with the enumerated types. A plan knows neither: the PostgreSQL generator meets them with statements of its own.
- A default that is a value of an enumerated type is checked for the plan as a whole, not at every step: between a step that changes a type's values, or makes a column of the type, and the step that sets the default, the default may be no value of the type. The PostgreSQL generator takes such a default off for as long as that is so.
- Nothing is said about rows: whether a column that becomes `NOT NULL` has values, how the values of a changed type are converted.
- Checks are kept as text, so a column is dropped without regard to checks over it.

## PostgreSQL migration (`generate-migration`)

`local-db-sandbox generate-migration <before> <after> --dialect postgres` writes the migration from one schema to another as SQL for PostgreSQL. It reads the two as `diff-schema` does, plans their differences as `plan-migration` does, and writes each step of the plan as the statements PostgreSQL carries it out with. It connects to no database, carries nothing out, and changes neither side. Status: experimental, and frozen: M4 is complete, and nothing is added to it without a decision of its own (D-039 to D-041). The generator is `packages/migration/src/postgres`, which is not part of the package's public API.

Three things are kept apart:

| | Says |
|---|---|
| schema diff (`SchemaDiff`) | what changed |
| migration plan (`MigrationPlan`) | in which steps it is carried out, in any database |
| PostgreSQL migration (`PostgresMigration`) | in which statements and transactions PostgreSQL does it |

The generator reads the plan, never the diff, and puts no step in another place. What PostgreSQL needs beyond a step it adds as statements of its own, each saying why.

The SQL is for PostgreSQL 13 and later (`gen_random_uuid()` without an extension; a scale below zero needs 15). Every statement kind, every rule of the type table below, and every statement PostgreSQL needs beyond a step was tried on PostgreSQL 18, with empty tables but for the changes of type, and on no other version.

### What a step becomes

| Step of the plan | Statement |
|---|---|
| `addTable` | `CREATE TABLE` with its columns, primary key, unique constraints, and checks. Its indexes and foreign keys are steps of their own |
| `dropTable`, `renameTable` | `DROP TABLE`, `ALTER TABLE ... RENAME TO` |
| `addColumn`, `dropColumn`, `renameColumn` | `ALTER TABLE ... ADD COLUMN`, `DROP COLUMN`, `RENAME COLUMN ... TO` |
| `alterColumnType` | `ALTER TABLE ... ALTER COLUMN ... TYPE`; from one enumerated type to another with `USING column::text::type` |
| `setNotNull`, `dropNotNull` | `ALTER COLUMN ... SET NOT NULL`, `DROP NOT NULL` |
| `setDefault`, `dropDefault` | `ALTER COLUMN ... SET DEFAULT`, `DROP DEFAULT` |
| `addPrimaryKey`, `addUnique`, `addCheck`, `addForeignKey` | `ALTER TABLE ... ADD [CONSTRAINT name] PRIMARY KEY`, `UNIQUE`, `CHECK`, `FOREIGN KEY ... REFERENCES ... [ON DELETE ...] [ON UPDATE ...]`, of one or several columns |
| `dropPrimaryKey`, `dropUnique`, `dropCheck`, `dropForeignKey` | `ALTER TABLE ... DROP CONSTRAINT name` |
| `renameConstraint` | `ALTER TABLE ... RENAME CONSTRAINT ... TO` (the index of a key is renamed with it, by PostgreSQL) |
| `addIndex`, `dropIndex`, `renameIndex` | `CREATE [UNIQUE] INDEX ... ON ... (...) [WHERE (...)]`, `DROP INDEX`, `ALTER INDEX ... RENAME TO` |
| `addEnumType`, `dropEnumType`, `renameEnumType` | `CREATE TYPE ... AS ENUM (...)`, `DROP TYPE`, `ALTER TYPE ... RENAME TO` |
| `addEnumValue`, `renameEnumValue` | `ALTER TYPE ... ADD VALUE ... [BEFORE ... or AFTER ...]`, `ALTER TYPE ... RENAME VALUE ... TO` |
| `removeEnumValue`, `replaceEnumValues` | the type is made again (below): PostgreSQL takes no value out of a type and does not reorder its values |

The temporary names of a plan (`migration_tmp_1`, ...), by which names that go round are exchanged, are names like any other: the generator makes no names for renames, and no second order. One statement is one action; statements are not gathered into one `ALTER TABLE`.

### Names, types, constants, and expressions

- **A name is always quoted** (`"users"`, `"Order Items"`, `"select"`), with a quote in it doubled. So no word of PostgreSQL's and no capital letter changes what it names, and no list of PostgreSQL's words is kept. Names are not qualified with a schema: the migration is for the schema the session puts first (`search_path`).
- **A type is written from the canonical type**, never from how a source spelled it (`declaredType`, `sourceDialectType`): a spelling may be another database's, or name a type that has been renamed since.

| Canonical type | PostgreSQL |
|---|---|
| `boolean` | `boolean` |
| `integer` of 16, 32, 64 bits | `smallint`, `integer`, `bigint` |
| `decimal`, with precision and scale | `numeric`, `numeric(p,s)` |
| `float` of 32, 64 bits | `real`, `double precision` |
| `text`; `varchar`, with a length | `text`; `varchar`, `varchar(n)` |
| `char`, with a length | `char(n)`; without a length `bpchar`, since `char` alone is `char(1)` to PostgreSQL |
| `uuid`, `date`, `binary` | `uuid`, `date`, `bytea` |
| `time`, `timestamp`, with a precision, with time zone | `time(p)`, `timestamp(p)`, each `with time zone` when it is |
| `interval`, with a precision | `interval`, `interval(p)` |
| `json`; `json`, binary | `json`; `jsonb` |
| `enum`, by name | the type's name, quoted |
| `array` | the element's type and `[]` |
| `other`, of PostgreSQL | its name, quoted, with its modifiers as constants: `"inet"`, `"bit"(8)`, `"geometry"('Point',4326)`; a name with a schema as `"schema"."type"` |

- **A constant is written as a constant of the column's type**: a number as its digits, `true` and `false`, a text in quotes with a quote in it doubled. A text with a backslash is written in the escape form (`E'a\\b'`), which is the same text whether or not the session reads backslashes in ordinary texts as escapes. JSON is its text with the type (`'{"a":1}'::jsonb`), with keys in one order; bytes are hexadecimal digits (`E'\\x0102'::bytea`); an array is `ARRAY[...]::type[]` with every element a constant of the element's type.
- **A default** is written by what it is:

| Default in the schema | Written as |
|---|---|
| a constant | the constant |
| the time of the write (`current_timestamp`, `current_date`) | the expression the source wrote (`now()`, `timezone('utc', now())`), since several expressions that mean this to the sandbox are not one expression to PostgreSQL; without one, `CURRENT_TIMESTAMP`, `CURRENT_DATE` |
| a UUID the database makes | the expression the source wrote; without one, `gen_random_uuid()` |
| another expression | the expression |
| the next number | `GENERATED BY DEFAULT AS IDENTITY`, in the definition of a column. It takes a value that a row gives, as a default does. A schema does not say whether a numbered column is an identity or has a default (`serial`) |

- **An expression is the one thing that is copied.** A schema holds a check, the condition and the expressions of an index, and such a default as the text their source wrote, and has nothing else of them. It is written back as it is, within parentheses of its own: `CHECK ((a > 0) and (b > 0))`, `DEFAULT (now())`, `WHERE (deleted_at is null)`. It is never rewritten: one that names a column, a type, or a value that was renamed after it was written still names the old one, and PostgreSQL refuses the statement.
- **Before it is printed, the SQL is given to PostgreSQL's own parser**: every statement has to be one statement, and every copied expression one expression. A text that would end the place it stands in and go on as something else (`true); DROP TABLE users; --`) is not printed.

### Safety: what is written, and what is refused

Every step of the plan is one of four. A migration is written only when no step is refused; the steps that are refused are all named, with the class, a reason as a word, and a sentence. In the JSON every step has its class (`steps`), and every statement the class it was written under (`safety`).

| Class | What it is | Written |
|---|---|---|
| `safe` | It leaves every row as it is, and either cannot fail because of the rows, or is a key, constraint, or index, which PostgreSQL checks against the rows and refuses as a whole when they do not fit | yes |
| `requiresDataMigration` | The statement is the right one for the schema, and whether it can be carried out depends on the rows. Rows that do not fit have to be changed first, and nothing here makes up what to change them to | only with `--assume-valid-data`, and marked (`assumes`). PostgreSQL still refuses the statement as a whole when the rows do not fit, and changes none |
| `requiresExplicitCast` | A column's type changes, and PostgreSQL has no conversion of its values that is known to keep every one of them. How they are converted (`USING`) is the author's to say | never |
| `unsupported` | What the schema does not say, or what PostgreSQL cannot have | never |

`safe` says nothing of what a change is meant to do. A dropped table or column is gone with its rows: such a statement is marked (`dropsData`) and has a comment in the script. A name that changed without a recorded rename is a drop and an add, as in the diff, and so loses the column's values.

| Reason | Class | When |
|---|---|---|
| `rows-may-hold-null` | `requiresDataMigration` | a column becomes `NOT NULL`. Also when a primary key over it is added in the same plan: the step is the plan's |
| `rows-need-a-value` | `requiresDataMigration` | a `NOT NULL` column without a default is added to a table that is there. With a default, or numbered, it is safe: PostgreSQL gives the rows that are there the value |
| `values-may-not-fit` | `requiresDataMigration` | a column's type becomes narrower, and PostgreSQL refuses a value that does not fit (table below) |
| `rows-may-hold-removed-value` | `requiresDataMigration` | values go from an enumerated type that columns have; a column goes from one enumerated type to another that lacks some of its values. Safe when no column has the type |
| `no-safe-conversion` | `requiresExplicitCast` | a column's type changes in a way the table below does not call safe or narrower |
| `no-canonical-type` | `unsupported` | a column's type has to be written, and the schema only says how it was spelled: a schema written by hand without canonical types, a single-file database of TypeORM entities, or an entity's column whose declared type PostgreSQL does not have (`tinyint`, `datetime`) |
| `type-not-representable` | `unsupported` | a type of another database (`other` with another dialect); an interval restricted to fields, which the schema keeps as PostgreSQL's internal numbers |
| `value-not-representable` | `unsupported` | a constant that is no value of its type; a whole number beyond those a schema holds exactly; a text with a NUL character; a value the source's database makes that the schema gives no expression for |
| `name-not-representable` | `unsupported` | a name that is empty, has a NUL character, or is longer than 63 bytes: PostgreSQL would cut a long one short without an error |
| `expression-not-representable` | `unsupported` | an expression with nothing in it, or with a NUL character |
| `numbering-not-representable` | `unsupported` | a numbered column that takes NULL or is no whole number (a column with a sequence of its own, which a schema does not hold); numbering given to a column that is there already (its numbers would have to start above the values its rows have) |
| `constraint-name-unknown` | `unsupported` | a constraint without a name is dropped, or is a foreign key that has to be taken off and put back: PostgreSQL drops a constraint by its name. One that is added needs none: PostgreSQL names it |
| `index-elements-order-unknown` | `unsupported` | an index over columns and expressions both that does not say in which order they stand (a schema of an earlier format). One that states its keys is written |
| `index-not-representable` | `unsupported` | an index of which the schema only says that there is more to it (`sourceClauses`: storage parameters, a tablespace, parameters of an operator class). Written from the rest, it would be another index |
| `constraint-not-representable` | `unsupported` | a key or a constraint of which the schema only says that there is more to it (`MATCH FULL`, `NOT VALID`, `NOT ENFORCED`, `NO INHERIT`, ...), also when a foreign key would have to be taken off and put back |
| `stale-expression-after-rename` | `unsupported` | an expression would be written whose text names something by a name it has no longer, or of which the schema does not say what it names while a rename may have reached it: a check or an index that is added, a table created with one, a default that is set or put back. The detail names each stale name and what it is called now |
| `unknown-referential-action` | `unsupported` | an action of a foreign key that is none of `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`, `SET DEFAULT` |
| `primary-key-column-takes-null` | `unsupported` | a column of a primary key that the schema says takes NULL |
| `foreign-key-without-key` | `unsupported` | a foreign key to columns that no primary key, unique constraint, or unique index (over columns only, without a condition) is over. A deferrable key is none: PostgreSQL rests no foreign key on one |
| `default-not-a-value-of-its-type` | `unsupported` | a default that is no value of its column's enumerated type, and that no step changes |
| `name-conflict` | `unsupported` | two objects whose names PostgreSQL keeps in one place would have one name: a table, an index, and a key (which has an index of its name) are relations; a table has a type of its name, beside the enumerated types |

A change of a column's type is safe only when PostgreSQL converts every value the old type can hold, and keeps it:

| From | To | |
|---|---|---|
| a whole number | a whole number of more bits; `numeric` with at least as many digits before the point; `double precision` (from 16 or 32 bits), `real` (from 16 bits); `text`, `varchar` long enough | safe |
| `numeric(p,s)` | `numeric` with at least as many digits before the point and after it; `numeric` without a precision; `text` | safe |
| `real` | `double precision` | safe |
| `varchar(n)`, `varchar`, `text` | `varchar` of at least that length, `varchar`, `text` | safe |
| `char(n)` | `char` of at least that length | safe |
| `timestamp`, `time`, `interval` | the same with more digits after the second | safe |
| `date` | `timestamp` (without time zone) | safe |
| `jsonb` | `json`; either of them to `text` | safe |
| `boolean`, `uuid` | `text`, `varchar` long enough | safe |
| an enumerated type | `text`, `varchar` at least as long as its longest value | safe |
| an enumerated type | another that has all its values: every value by its name, `USING column::text::type` | safe |
| an array | an array, as its elements change | as the elements |
| the above, to a type that holds fewer or shorter values (`bigint` to `integer`, `text` to `varchar(20)`, `numeric(12,2)` to `numeric(10,2)`) | | `values-may-not-fit` |
| a conversion PostgreSQL makes by rounding (`numeric` to `integer`, fewer digits after the point or the second, `double precision` to `real`), by cutting (`timestamp` to `date`, `char` to `text`), by the session's time zone (`timestamp` to and from `timestamp with time zone`), or by losing part (`json` to `jsonb`) | | `no-safe-conversion` |
| everything else: no conversion of PostgreSQL's own (`text` to `integer`, to `uuid`, to an enumerated type; `integer` to `boolean`), a type of PostgreSQL's own (`inet`), an array and a single value | | `no-safe-conversion` |

### What PostgreSQL asks beyond a step

A plan follows the rules that databases share. Where PostgreSQL asks more, the generator adds statements, and each says why (`because`, and a comment in the script):

| `because` | What PostgreSQL does | What is written |
|---|---|---|
| `foreign-key-rests-on-dropped-key` | It does not drop a key or unique index while a foreign key rests on it | Every foreign key to exactly the key's columns is dropped first, and added again after the last step, under the names things have then. One that the plan drops meanwhile, or whose table it drops, does not come back |
| `foreign-key-across-type-change` | It keeps no foreign key between columns of types it does not compare: a whole number and a decimal, a UUID and a text, an enumerated type and anything else | When a column of a foreign key gets a type of another kind, the foreign key goes first and comes back after the last step. Whole numbers of every size, texts with and without a length, and dates with times are compared, and keep their foreign keys |
| `type-name-taken-by-table` | A table has a type of its own name, so a table cannot be created with, or renamed to, the name of an enumerated type | An enumerated type of that name which the plan drops later is renamed out of the way (`migration_old_1`), and dropped under that name |
| `enum-type-made-again` | It takes no value out of an enumerated type, and does not reorder its values | The type is renamed away, created anew, every column of it converted by way of text, and the old one dropped, in one transaction. Defaults and foreign keys of those columns go before and come back after. Several values that go from one type make it again once |
| `enum-default-across-type-change` | It does not rewrite a default when its column's type changes: one that was a value of an enumerated type stays that. It cannot be converted to another enumerated type at all, and converted to anything else it still rests on the old type, which then cannot be dropped | The default is dropped before the type changes, and set again as a constant of the new type. One that is no value of the new type stays off, for the step of the plan that changes it |
| `numbering-kind-unknown` | It takes an identity off as an identity and a default as a default, and refuses the other | Both: `DROP IDENTITY IF EXISTS`, which does nothing to a column that is none, then `DROP DEFAULT`. Ahead of its step when the column's type is to become no whole number, or the column is to take NULL: PostgreSQL's numbered column is a whole number that takes none |
| `key-over-the-same-columns` | It leaves a unique constraint out of `CREATE TABLE`, without a word, when the primary key or an earlier one is over the same columns in the same order | Such a constraint is added by a statement of its own, which PostgreSQL carries out |

### Segments and transactions

A migration is a list of segments, and a segment says how its statements are run:

- `transaction`: the statements are one transaction, all of them or none. The script has `BEGIN` and `COMMIT` around them.
- `autocommit`: each statement is run on its own, outside a transaction, and stays when a later one fails.

A segment is carried out, and committed, before the next begins. The one reason for a segment of its own: **a value added to an enumerated type cannot be used before it is committed** (`unsafe use of new value`), so `ALTER TYPE ... ADD VALUE` stands outside the transactions, and what uses the value in a later one. A plan adds values right after it creates types, so a migration has at most three segments: what goes, the renames, and the new types; the added values; everything else.

A migration of one segment is one transaction. One of several is not: what a segment did stays when a later one fails, and the script says so in its first lines. Statements are never moved to make a migration one transaction.

The script is for a client that sends one statement at a time and adds no transaction of its own (`psql -f`). A tool that wraps a file in a transaction needs one file for each segment: `--json` has the segments.

### The script and the JSON

- The script is the statements, each with its semicolon, and comments where there is something to say: why PostgreSQL needs a statement beyond its step, what a statement assumes of the rows, and that a statement loses rows. A comment never holds a line end from a name.
- `--json` prints `{ "status": "generated", "steps": [...], "migration": { "version": 1, "dialect": "postgresql", "segments": [...] } }`. A step has `step`, `operation`, `safety`, and, unless it is safe, `reason` and `detail`. A segment has `mode` and its `statements`; a statement has the `step` it carries out or is needed for, its `kind` with its parts (the table, the column, the type, the constraint), its `sql`, and where they apply `because`, `safety`, `assumes`, `dropsData`, and `expressions` (the expressions that were copied into it). A refusal is `{ "status": "refused", "refusals": [...], "steps": [...] }`, and the command exits with 1.
- The same two schemas give the same bytes, in whatever order the schemas list their objects. Nothing in the output is a path or a time.
- `--out <file>` writes the output to a file, and never replaces one that is there.

### Limits

- **It is not known what the rows are.** No statement converts, fills in, or removes rows. A migration that needs that is refused, or written on the author's word (`--assume-valid-data`).
- **No migration backwards**, and no undoing of one that failed halfway. A migration of several segments is not one transaction.
- **An expression is not rewritten, and a stale one is not written.** A check, a default, or an index expression whose text was written before a rename of what it names is still that text; PostgreSQL has it under the new name. Where the same object is on both sides, nothing of it is written: the rename is. Where it would have to be written (it is added, or its table is created), it is refused (`stale-expression-after-rename`), since PostgreSQL would refuse the text, or take it for whatever has the name now. Writing the expression again in the source, in the names things have, makes it one that is written.
- **What the schema holds of an index and a constraint is written** (D-040): the method, the keys in their order with direction, place of NULLs, operator class, and collation, `INCLUDE`, `NULLS NOT DISTINCT`, and `DEFERRABLE` with `INITIALLY DEFERRED`. An index or a constraint is never changed in place: one that differs goes and comes. **What it only says is there is not**, and is refused (`index-not-representable`, `constraint-not-representable`). An index is not checked against what its method allows: PostgreSQL says so when the migration is run.
- **What PostgreSQL makes of a statement beyond what the schema holds** is not followed. A check or an index condition that names a column of an enumerated type stops that type from being made again or changed, and PostgreSQL says so. A column that a check names is dropped with its check by PostgreSQL: where the schema says what the check's text names, the plan drops the check first, as a step of its own (D-040); where it does not say, nothing does. A numbered column keeps its sequence's own type when its type becomes wider. PostgreSQL 18 gives every `NOT NULL` a constraint of a name of its own.
- **A JSON default is its value.** On a `json` column PostgreSQL keeps the text as it was written; the schema holds the value, so spacing and the order of keys are the generator's.
- **A default of an array of an enumerated type does not follow a renamed value** in the schema, though it does in PostgreSQL (a limit of the collector and of the plan, D-038).
- **A schema without canonical types** (one written by hand, or a single-file database of entities) is refused wherever a type has to be written. A database directory of TypeORM entities has them ([above](#what-a-column-is-in-the-entities-own-database)).
- **A default has no identity.** One whose text calls a function that was renamed since is stale, and is refused where it would be written, until its source writes it again.
- **Renames of what a schema does not keep** (a collation, an operator class, a sequence, a schema) are not followed into an expression's text.
- **The planner's own refusals stand** (above): a constraint left without a name while another takes its name, and a foreign key to a table the schema does not have.
- Locks, and how long a statement takes, are not considered: an index is not created `CONCURRENTLY`, and a type that is made again rewrites its tables.

## SQL script simulation (`simulate`)

Experimental (D-045). `simulate <database> <script.sql>` runs SQL on a copy of a database. The database is read, never opened to write, and not claimed; the copy is written once the script has run, beside it as `<name>-preview` (`sandbox.db` gives `sandbox-preview.db`, `sandbox.db.json` gives `sandbox-preview.db.json`) or at `--out`, in the database's format and in the format this build writes.

- **Execution.** The relational runtime runs the statements one by one, split as `sql --file` splits them, and stops at the first error. SQL is SQLite's and is not translated. `ATTACH`, `DETACH`, and `VACUUM` are not run.
- **Kept in the copy:** rows; tables made with `CREATE TABLE` and dropped with `DROP TABLE`; columns added with `ALTER TABLE ... ADD COLUMN` and dropped with `DROP COLUMN`. A table SQL did not change keeps its stored definition as it was. A table or column SQL made is described from SQLite's catalog: SQLite's documented type names (`INTEGER`, `INT`, `BIGINT`, `VARCHAR(n)`, `TEXT`, `REAL`, `DOUBLE`, `NUMERIC`, `DECIMAL(p, s)`, `BLOB`, ...) and the runtime's `BOOLEAN`, `DATE`, and `DATETIME`; a column declared without a type takes any value. The type as written is `declaredType`; no canonical type is given. Primary keys, `INTEGER PRIMARY KEY` as a generated key, references with their actions, unique constraints, `NOT NULL`, and a default that is a value, `CURRENT_TIMESTAMP` (datetime), or `CURRENT_DATE` (date) are kept.
- **Refused**, as the error of the statement, which is undone (each `CREATE`, `ALTER`, and `DROP` runs in a savepoint): an index, view, or trigger made, dropped, or changed; a renamed table or column; a CHECK constraint, a collation, a deferrable key, an ON CONFLICT clause, a generated column, `WITHOUT ROWID`, `STRICT`; another type name (`serial`, `uuid`, `timestamptz`, `json`, ...); a default that is an expression; a column dropped that a stored key, unique constraint, or index names.
- **A failed statement.** It changed nothing. The statements after it did not run. A transaction that was open is rolled back. The copy is written with what the statements before it committed, and the command says `Copy (partial): <out>, with what statements 1-<n> changed.` (or that it holds the database as it was read), and which statements ran, failed, did not run, and were rolled back. A transaction the script leaves open is rolled back and said so. Exit code 1.
- **No copy** is written when the tables the script left cannot be opened again as a database of the sandbox (a row a key refuses after `PRAGMA foreign_keys = OFF`, say), or when the copy cannot be saved; the command says why. Exit code 1.
- **Paths.** Refused before anything is read: a database that is not there; a copy that would be the database, be inside it, or hold it; a copy in the other format; a script that is not a file, or is inside the database or the copy; a script without a statement; a copy that exists, without `--replace`. Exit code 1.
- **Output.** Each statement's result, as `sql` prints it; then the outcome, the copy's path, the tables and columns the copy has that the database had not (or lost), and the commands to look at it (`studio`, `sql`), compare it (`diff-schema`), and delete it. On stdout when the whole script is in the copy, on stderr otherwise. The text may change; the exit code is 0 only when the whole script is in the copy.
- **Not provided:** writing to the database itself, taking a copy over in its place, deleting a copy, simulating PostgreSQL migrations on the rows, and a report beyond the lines above.

## PostgREST endpoint

`local-db-sandbox postgrest <database>` serves the tables of a database at `/rest/v1/<table>` in a subset of PostgREST, the HTTP API behind Supabase's database client. It is another consumer of the runtime: requests become Query IR, run on SQLite, in one transaction each. Status: experimental, v0 subset (D-030 to D-032).

Verified with `@supabase/supabase-js` 2.116.0 (`@supabase/postgrest-js` 2.116.0), in Node and in Deno 2.

### Supported (v0)

| Client call (supabase-js) | HTTP | Behavior |
|---|---|---|
| `.select('a, b')`, `.select('*')` | `GET ?select=` | Plain columns only. A column named twice is returned once. No `select` means every column. |
| `.eq(col, v)` | `col=eq.v` | Equality. `eq.null` compares with the text `null`, as in PostgREST (`is.null` is not supported). Several filters combine with AND. |
| `.gte(col, v)`, `.lt(col, v)` | `col=gte.v`, `col=lt.v` | By the column's type: numbers as numbers, date-times as moments (any ISO 8601 or PostgreSQL spelling), text by its bytes. |
| `.range(from, to)` | `offset=` / `limit=` | Both ends included. Reads are capped at `--max-rows` rows (default 1000, Supabase's `db-max-rows`); `Content-Range` is `from-to/*` (`*/*` for no rows). |
| `.single()` | `Accept: application/vnd.pgrst.object+json` | One object; otherwise `406 PGRST116`. |
| `.maybeSingle()` | (nothing; the client unwraps the array) | `null` for no row, the object for one, the client's own `PGRST116` for more. |
| `.upsert(obj)`, `.upsert([...])` | `POST`, `Prefer: resolution=merge-duplicates` | Insert, or update the row with the same primary key. With `columns=` (sent for arrays) a key a row lacks is `NULL`. `onConflict` may only name the primary key. `201`, empty body. |
| `.delete().<filters>` | `DELETE ?col=op.v` | Deletes what the filters match; foreign keys cascade as declared. Without a filter: `400 21000`, as Supabase's pg-safeupdate. `204`. |
| CORS preflight | `OPTIONS` | Any origin, the headers the client asks for. |

### Values

Filter values and bodies are converted by the runtime's column codec, the same one that loads the fixture, so a row written through the endpoint and a fixture row hold the same text for the same moment. Responses are written as PostgREST writes them:

| Storage type | In (body or filter) | Out |
|---|---|---|
| `datetime` | ISO 8601 or PostgreSQL text, with or without an offset (none = UTC) | `2026-10-06T12:00:00+00:00` (`timestamp` without time zone: no offset); a fraction only when there is one |
| `date` | `YYYY-MM-DD` | the same |
| `boolean` | JSON `true`/`false`; in a filter `true`/`false`/`t`/`f`/... | JSON boolean |
| `integer` | JSON number or digits | number; beyond 2^53 the text of its digits (PostgREST sends a number that JavaScript cannot hold exactly) |
| `numeric`, `real` | number | number (floating point, about 15 digits; PostgreSQL's `numeric` is exact) |
| `json` | any JSON value | the value (filtering on it is refused) |
| `binary` | `\x` hex text | `\x` hex text (filtering on it is refused) |

A value that does not fit its column is PostgreSQL's invalid input (`400 22P02`, or `22007` for dates), and nothing is written.

### Errors

- What PostgREST would refuse as well gets its code and status: `PGRST100` (unparseable query), `PGRST102` (body not JSON objects, or keys that differ between rows), `PGRST106` (schema other than `public`), `PGRST116`, `PGRST117` (method), `PGRST125` (path), `PGRST204` (unknown column in a body), `PGRST205` (unknown table), `42703` (unknown column), `22P02`/`22007`, and the constraint errors `23502`, `23503`, `23505`, `23514` from SQLite's failures.
- A valid PostgREST feature that the sandbox does not implement is `501 SANDBOX_POSTGREST_UNSUPPORTED`, with a message that names it. Never ignored, never approximated. This includes: the operators `neq`, `gt`, `lte`, `in`, `is`, `like`, `ilike`, full-text and array operators; `not`, `or`, `and`; `order`; embedded resources, renamed columns, casts, and JSON paths in `select`; `Prefer: count=...` and `return=representation`/`headers-only`, `select=` on a write; plain `.insert()` (`POST` without `resolution=merge-duplicates`), `ignore-duplicates`, `on_conflict` other than the primary key; `.update()` (`PATCH`), `PUT`, `HEAD`; the `Range` header.
- Other Supabase services under the same URL answer `501` with the service's name: `/auth/v1`, `/storage/v1`, `/realtime/v1`, `/functions/v1`, `/graphql/v1`, `/rest/v1/rpc/*`, and `GET /rest/v1/` (OpenAPI).

### Differences from Supabase that do not show as errors

- **No Row Level Security, roles, or grants.** Any key is accepted and every client can read and write every table. A project that relies on RLS for correctness (a policy that hides rows, or a missing policy that hides a table from `anon`) gets a more permissive sandbox than production.
- No dynamic defaults (`now()`, `gen_random_uuid()`), no `CHECK` or unique constraints besides the primary key: the runtime's schema model does not have them (see [What the runtime provides](#what-the-runtime-provides)).
- SQLite's semantics: decimals are floating point, text compares by bytes, rows come back in SQLite's order when nothing orders them.
- Tables are served only when the database stores their definition (`schema.json` of a directory). For a Supabase project, `init` creates them from its migrations ([PostgreSQL migrations](#postgresql-migrations-init)); otherwise they are written by hand or by another importer.

### Logs and secrets

Each request is logged as one line (`[req-3] GET /rest/v1/t?select=a -> 200 (sql 1, 0.2 ms; total 1.4 ms)`), and its statements carry its request ID and a number, as in the NestJS mode. A client's `x-request-id` is used when it sends one. Header values are never logged: `apikey` and `Authorization` hold the client's keys, and an Edge Function sends the service-role key.

## Mail and network

This part is not the relational runtime. It is what the sandbox does about two things an application does besides using its database, when `sandbox.config.json` asks for it (`"smtp"`, `"network"`; see [REFERENCE.md](REFERENCE.md), "Mail capture" and "Network guard"). Both are off by default. Status: experimental (D-029).

### What the sandbox says when it starts

A NestJS sandbox says what is kept on this machine each time it starts, before the application is loaded (D-043). The lines are formatted from a structured status (`SideEffects.status`: `mail`, `smtp`, `variables`, `network`, `allow`), which is the source of truth; the text may change.

| `smtp` | `network` | What is said |
|---|---|---|
| off | `allow` | `SMTP capture is off.`, `network guard is off ("allow").`, and `Warning: nothing keeps this application from real services.` |
| off | `warn` | `SMTP capture is off.`, the guard's own line, and the same warning: connections are reported, and still opened |
| off | `block` | `SMTP capture is off.`: mail is not kept, and a mail server outside this machine is refused by the guard, unless it is among the hosts that `allow` lets through, which the line then says. No warning |
| capture, with `env` | `allow` | the capture's own lines, `network guard is off ("allow").`, and `Warning: the application's mail is captured, and nothing else keeps it from real services.` |
| capture, with `env` | `warn` | the capture's and the guard's own lines, and that warning |
| capture, with `env` | `block` | the capture's and the guard's own lines. No warning |
| capture, without `env` | any but `block` | as if mail were not captured: a capture listens, and nothing leads the application to it |

- A warning names the keys of `sandbox.config.json` that change it, and the file. It is printed at every start and restart of the application for as long as it holds.
- Three states are told apart for the guard: off (`allow`), reporting (`warn`), and refusing (`block`). `warn` is never said to keep anything in.
- "No warning" says what the configuration is, and nothing about the application. Mail is captured when the application reads the variables that were set; the guard covers what the table below says, and lets through the hosts listed in `allow`, which its own line names. Neither is a security boundary, and no line says that an application is isolated.
- The sandbox sets what the configuration names and nothing else. It does not read or write the application's `.env`, and turns on neither the capture nor the guard by itself.
- `startSideEffects` prints nothing when both are off, as before; the lines are the NestJS adapter's (`formatUnguardedSideEffects`). The PostgREST and REST sandboxes run no application code, and say nothing of this.

### What the mail capture is to an application

| | |
|---|---|
| Protocol | SMTP (RFC 5321) as a mail library uses it to submit a message: `EHLO`/`HELO`, `MAIL`, `RCPT`, `DATA`, `RSET`, `NOOP`, `VRFY`, `HELP`, `QUIT`, with `SIZE`, `8BITMIME`, `SMTPUTF8`, and `PIPELINING`. Written on Node's `net`; there is no mail library in the sandbox. Verified with Nodemailer 9.0.5. |
| Where | A loopback address only (`127.0.0.1:2525` by default). Another address is refused when the configuration is read. |
| TLS | None. `STARTTLS` is not offered, and a connection that starts with TLS (implicit SSL, usually port 465) fails. An application whose settings turn either on has to have them turned off for the sandbox, through `smtp.env`. |
| AUTH | Not offered by default, so a client that does not insist never sends credentials. With `"auth": "accept"`: `PLAIN` and `LOGIN`, any credentials accepted and dropped. Other mechanisms are refused. |
| Recipients | Every address is accepted. Nothing checks whether a mailbox or a domain exists, because nothing is delivered. An application's handling of a rejected recipient cannot be exercised. |
| Delivery | None, ever. The server has no client side. Bounces, delays, greylisting, and rate limits of a real provider do not happen. |
| Limits | 25 MB per message (`552` above it), 1000 recipients per message, 500 messages kept (the newest). |
| Not supported | `BDAT`/`CHUNKING`, `DSN`, `ETRN`, and other extensions: answered with `500` or `502`. |

What is kept of a message is what a developer needs to see: the envelope, the headers (with encoded words decoded), the first plain-text and HTML bodies (with `\n` line breaks, in the character set they declare), and the name, type, size, disposition, and content ID of every other part. A message that is not well formed is read as far as it goes. Attachment content, and the message as it was sent, are not kept.

**Request correlation.** A message has the ID of the request that was being handled when its connection was opened. That is exact when the mail library opens a connection per message (Nodemailer's default). On a connection that is kept open, a later message is given a request only when the application wrote it in another request's context than the one the connection was opened in; otherwise its request is `unknown`. A pooled transport does its work in the context its connection was opened in, whoever asked for the mail, so anything else would be a guess. Mail sent outside any request is `background`. Mail that reaches the capture from another program has no request.

**Environment.** Only the variables named in `smtp.env` are set, in the application's process, before the application is loaded. An application that reads its mail settings from somewhere else (a configuration file, a secrets service), or whose `.env` loader overwrites variables that are already set, is not led to the capture by this; the startup line that lists what was set is the place to check. The network guard in `block` mode keeps such an application's mail from leaving all the same.

### What the network guard covers

| Covered: goes through `net.Socket.prototype.connect` or the look-ups of `dns` in the application's process | Not covered |
|---|---|
| `net`, `tls`, `http`, `https`, `http2`, the built-in `fetch` | UDP (`dgram`), QUIC |
| Clients built on those: database drivers, mail, Redis, message queue, and HTTP client libraries | DNS queries other than `dns.lookup`, `resolve`, `resolve4`, `resolve6` and their promise forms: other record types, a `Resolver` the application creates |
| A client that looks a name up itself and connects to the address (Nodemailer): the address is judged and reported by the name it was looked up for | Worker threads and child processes, which have their own copies of these modules |
| | Native add-ons that open sockets themselves |
| | A connection given a `lookup` function of its own: it is judged by the name it was given, and the function decides where it goes |

- Loopback means `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, and the unspecified addresses `0.0.0.0` and `::`. A name that only resolves to this machine (through the hosts file, say) is not known to be local; list it in `allow`.
- `protocol` in a report is what usually speaks on the port (25, 465, 587, 2525 `smtp`; 80 `http`; 443 `https`; 5432 `postgres`; 3306 `mysql`; 6379 `redis`; ...). It is a hint, not something that was observed.
- A refused connection ends with the socket's `error` event, code `ESANDBOXNETWORK`, as a connection that fails does. Code that opens a socket without an error handler fails the way it would if the server were down.
- The guard is installed in the process that runs the application, not in the watcher.
- It is a development aid. It is not a sandbox in the security sense, and is not a reason to run code you do not trust.

## Local DB Studio, and who has a database open

Experimental (D-042). `local-db-sandbox studio <database>` serves a page that looks into a sandbox database through the relational runtime. This section is the contract of the three things that came with it: the record of a database's owner, the access to a runtime, and the page.

### Who has a database open

One process has a database open to write at a time, and says so in a record beside the database:

```text
sandbox.db.owner.json        (for sandbox.db; sandbox.db.json.owner.json for a single file)
{ "version": 1, "pid", "startedAt", "instance", "kind", "database", "persistence"?, "control"?: { "url", "token" } }
```

- `kind` is `rest`, `postgrest`, `nest`, `sql`, `studio`, `init` (D-043), or `simulate` (D-045). `instance` is a random name for this one claim. `database` is the database's canonical path: links resolved, in the letters the file system has it in. `control` is where the owner serves its runtime, once it does.
- The record is not part of the database. It is not in the directory, no format describes it, and `inspect`, `convert`, and `migrate` do not look at it. It is written in one step (a rename), and is readable by its owner only where the file system knows such a thing.

| Process | Claims | Serves its runtime |
|---|---|---|
| `local-db-sandbox <database>` (REST), `startSandbox` | when it saves; not for a directory that declares `"persistence": "memory"` | no: it runs on the JSON engine |
| `local-db-sandbox postgrest`, `startPostgrestSandbox` | always, `--no-save` included | the command does; the function gives its claim to whoever composes it (`RunningPostgrestSandbox.claim`, `serveRuntime`) |
| NestJS sandbox: `npm run sandbox`, `sandbox.server.ts`, `SandboxModule.forRoot` | always | yes |
| `local-db-sandbox sql` | unless `--read-only` or `--no-save`, or the database declares that it is never written to | no |
| `local-db-sandbox studio` on a directory no process has | yes | yes |
| `local-db-sandbox init --force` on a database that exists | while it replaces it: from before it reads its migrations until the new database is written, or the command has failed | no |
| `openTypeormSandbox`, `createSandboxDataSource`, `SqlConsole.open`; `convert`, `migrate`, `import-typeorm`, `init-nest`; `init` where no database is | no | no |

- A database is claimed before it is read.
- A second process that would write is refused with `DatabaseOwnedError`: `<database> is open in <the NestJS sandbox | the PostgREST endpoint | the REST sandbox | the SQL console | Local DB Studio | the init command, which is replacing it | the simulate command, which is writing a copy there> (pid <n>, since <time>). One process has a database open to write at a time: stop that one first.` For an owner that serves nothing, it adds which file to delete if that process is gone.
- A sandbox that serves its runtime (`nest`, `postgrest`) and is refused a database that a Studio has to itself is told how the database is handed over as well: `That Studio has the database to itself. To run the sandbox on it: stop that Studio (Ctrl+C in its terminal), start the sandbox, and start Studio again. It then attaches to the sandbox, and both show the same rows.` Nothing is handed over for it: no process lets go of a database because another asked, and none starts another.
- `init --force` is refused in the same way, and adds `Nothing was replaced: the database is as it was.` It has no switch that replaces a database under its owner. A record that was left behind is taken over by it as by every claim, and its own record is gone when the command ends, whether it replaced the database or failed.
- `simulate --replace` claims the database at `--out` in the same way while it writes a copy there, and is refused one that a process has open: `Nothing was run, and <out> was not changed.` The database it copies is read and not claimed (D-045).
- **Not covered (D-043).** `convert --force`, `import-typeorm --force`, `init-nest` on a database that exists, and `migrate` write a database and ask no record. Stop the process that has a database before running one of them on it.
- A record is taken over when its owner is gone: its process does not run; or, when it says where it serves, nothing listens there, or what answers there is not that owner. A record that cannot be read is taken over once it has not been touched for two seconds. A record that names an address other than `http://127.0.0.1:<port>` is asked nothing there, and is taken for one that was left behind.
- A live owner's record is never taken, and a claim removes only the record it made: when the process stops, and when it exits. A process that is killed leaves its record behind.

Differences from before D-042 that show without an error message elsewhere: a second sandbox on a database is refused when it starts, where it used to start and fail at its next save; and `sql` without `--read-only` or `--no-save` is refused a database that a sandbox has open.

### How Studio opens a database

| The database | Who has it open | Studio |
|---|---|---|
| directory | no one | standalone, read/write: claims it, loads it, saves committed changes |
| directory | a process that serves its runtime | attached, read/write through that process |
| directory | a process that serves nothing | refused; with `--read-only`, standalone on what is stored |
| directory in a format this build does not write | no one | standalone, read-only, with the command that migrates it |
| single file | no one, or a process that serves nothing | standalone, read-only, on what is stored |
| single file | a process that serves its runtime | attached, read-only |
| any, with `--read-only` | a process that serves its runtime | attached; Studio refuses every change itself |

- A sandbox that has claimed a database and has not said yet where it serves is waited for, for five seconds.
- A Studio that opens what is stored to read it claims nothing and writes nothing. It shows the rows as they were when it opened them.
- Attached, Studio stays attached. While no process has the database it is connected to no one; it does not open the database itself.
- A directory with `"persistence": "memory"` that Studio has to itself is changed in Studio's memory, and not saved; the page says so.

### The access to a runtime

The page asks for nothing but these operations, and neither does anything else that attaches to a sandbox:

| Operation | What it does |
|---|---|
| `info` | whose runtime it is (`instance`, `pid`, `kind`), the database and its format, whether changes are saved, why nothing can be changed (if so), how many tables, and the limits |
| `schema` | every table: columns (storage type, declared type, canonical type, NULL, primary key, generated, default, enumerated values, what it refers to), the primary key, the number of rows |
| `browse` | a page of a table's rows, with `limit`, `offset`, `orderBy`, and `filters` (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `null`, `notnull`; all have to hold), and how many rows match. Without an order, in the order of the primary key |
| `row` | one row by its primary key, whole |
| `insert`, `update`, `delete` | one row: added with the columns that are given, and with the time of the insert in a column TypeORM fills (below); changed in the columns that are given; removed. By primary key, all of its columns |
| `sql` | statements, in `read` or `write` mode |
| `events` | the statements the runtime carried out lately, the application's and Studio's (no values) |

- **The time a row is written (D-047).** A column whose `declaredType` is `@CreateDateColumn` or `@UpdateDateColumn` (as the TypeORM integration marks the columns TypeORM fills itself), stored as a date-time or a day, has no default in the database: TypeORM gives the value in the application's own inserts. `insert` gives such a column, when the request leaves it out, the time of the insert (an ISO date-time to the millisecond, or its UTC day), and `schema` says so as `generated: "insert time"`. A value that is given, `NULL` included, is used as it is. Nothing else is filled: another required column, a time the schema says nothing more of, and `@DeleteDateColumn` are given or refused as before. `update` fills nothing (`@UpdateDateColumn` keeps its value), and neither does SQL in the console. The table's definition and the database's schema are not changed.
- Values in `browse`, `row`, `insert`, and `update` are logical values, as the application and the fixture have them: `true`, an ISO 8601 date-time, a JSON value, Base64 for bytes, the digits of an integer beyond 2^53 as text. They are converted with the runtime's column codec. `contains` takes its value as text: `%` and `_` are themselves.
- Values in the results of `sql` are what SQLite returns: `1` for true, `2026-01-31 12:00:00.000` for a date-time, JSON as its text, bytes as `\x` and hexadecimal digits.
- A table without a primary key can be browsed. `row`, `update`, and `delete` refuse it: its rows are changed with `sql`.
- `sql` carries out `SELECT`, `INSERT`, `UPDATE`, and `DELETE` (also behind `WITH`, and `VALUES`). `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, and `RELEASE` are refused: a request is one transaction already. `CREATE`, `ALTER`, `DROP`, `PRAGMA`, `ATTACH`, `VACUUM`, and everything else are refused: the tables are the application's. Every statement is looked at before any is carried out. Statements are split at semicolons, as in the SQL console; SQL is not parsed.
- In `read` mode, SQLite refuses a statement that would change data or schema, whatever it looks like (`query_only`, for that call); statements before it stay carried out, and none after it is. In `write` mode the request is one transaction: committed when every statement went well, and taken back when one did not, or when what it changed could not be saved.
- While the application has a transaction open on the runtime, every operation but `info` and `events` does nothing and answers `BUSY`.

Limits (`AccessInfo.limits`):

| Limit | Value |
|---|---|
| rows of a page | 500 at most, 50 by default |
| rows one statement of `sql` returns | 1,000 at most, 200 by default; `truncated` says that there were more. A statement that writes is carried out whole |
| statements, and characters of SQL, in one `sql` request | 50, and 100,000 |
| characters of a value in a page or a result | 2,000; a longer one is cut, and `cut` says where |
| characters of a value of a row that is read to be edited | 200,000; a longer one is left out, and `tooLong` names it |
| bytes of a request | 1,048,576 |
| bytes of an answer | 8,388,608. A page that would be larger is refused; of a row, the values that do not fit are left out and named; a `sql` request whose results would be larger fails at the statement that goes over, in `write` mode before anything is committed |
| statements remembered for `events` | 200 |

Errors are `{ "error": { "code", "message" } }`, with an HTTP status over the control and from Studio's server:

| Code | Status | When |
|---|---|---|
| `INVALID_REQUEST` | 400 | the request does not say what it has to, or is not JSON |
| `UNSUPPORTED_STATEMENT` | 400 | a statement the console does not carry out |
| `INVALID_VALUE` | 400 | a value that is none of its column's |
| `SQL_ERROR` | 400 | SQLite could not carry the statement out |
| `UNAUTHORIZED` | 401, 403 | no token or key, or not the right one; a request from another page or under another host name |
| `READ_ONLY` | 403 | nothing can be changed through this access; or the statement would change something and was asked in `read` mode |
| `NOT_FOUND` | 404 | a table, a column, a row, or an operation that is not there |
| `BUSY` | 409 | the application has a transaction open; nothing was done |
| `CONSTRAINT` | 409 | a constraint of the schema would not hold; nothing was changed |
| `OWNER_CHANGED` | 409 | the request was made for another owner than the one that has the database; nothing was done |
| `LIMIT_EXCEEDED` | 413 | more than a request or an answer may have |
| `PERSISTENCE` | 500 | what was changed could not be written to the database, and was taken back |
| `OWNER_UNREACHABLE` | 503 | no process answers for the database; nothing was done |
| `OUTCOME_UNKNOWN` | 504 | a change was sent and no answer came: whether it was carried out is not known |

In a `sql` answer, a statement that failed is in the result (`error`, with its place among the statements and one of these codes), and the answer itself has status 200.

### A sandbox that restarts

What Studio does when the process it is attached to goes away and another takes its place, as under `npm run sandbox` after a source change:

- It asks how things are every second and a half (`GET /api/status`). `connected` is false while no process has the database, with the reason in `disconnected`.
- The new process is found by the owner's record. Studio attaches to it only when the record is of this database, and what answers where the record points says that it is that owner and has this database.
- A request that changes nothing, and finds its owner gone, is asked again of the owner that has the database now. Nothing else is ever asked twice.
- A change is sent once, to the owner Studio is attached to at that moment. When no owner is there, it is not sent (`OWNER_UNREACHABLE`), and not kept for later. When it was sent and no answer came, its outcome is not known (`OUTCOME_UNKNOWN`), and it is not sent again: not to that owner, and not to the next.
- A change names the owner whose rows the page showed when it was asked for (`"for"`). Another owner carries nothing of it out (`OWNER_CHANGED`).
- When the page sees another owner than before, it reads the tables and the open page of rows again, and says that the sandbox was restarted.

With `"persistence": "memory"`, a restarted sandbox starts again from the stored database, and Studio shows that.

### The page and its server

- Served on `127.0.0.1`, on port 4583 unless `--port` says otherwise. There is no option for another address.
- `GET /` is the page: one document that is the same for every database and holds no data and no key. `GET /api/status` and `POST /api/access/<operation>` need `Authorization: Bearer <key>`, the key of the session from the address the command printed.
- A request has to name `127.0.0.1:<port>` or `localhost:<port>` as its host, and, when it says where it comes from (`Origin`), Studio's own page. No answer has an `Access-Control-Allow-Origin` header.
- The page is sent with a `Content-Security-Policy` that allows its one script and its one style by a nonce, connections to its own server and that server's icon, and nothing else, and forbids frames.
- The control of a sandbox is served the same way, on a port of its own: `127.0.0.1`, `Authorization: Bearer <token>` with the token of the owner's record, `GET /health` and `POST /access/<operation>`, and nothing else. It is not a public API.
- Neither the key nor the token is in any log line or event. The key is printed once, in the address; the token is never printed. An error does not carry it either: `DatabaseOwnedError` says who has the database (`owner` is the owner's record without `control`), so a refusal that NestJS's exception handler or Node prints with all the error holds shows no token (D-048).

### The API tab

Experimental (D-046). `POST /api/request`, with the session's key as for every request under `/api`, and `{ "request": { "method", "url", "headers"?, "body"? } }`: Studio's server sends one HTTP request and answers `{ "result": { "status", "statusText", "durationMs", "headers": [[name, value], ...], "body", "bodyBytes", "truncated" } }`, or `{ "error": { "code", "message" } }`.

- **Where.** The URL's host as it is written: `127.0.0.1`, `localhost`, or `[::1]`. Any other host or address (another loopback address such as `127.0.0.2`, `0.0.0.0`, an IPv4-mapped address, a name that ends in one of them) is refused with `DESTINATION_REFUSED` (403), and so is Studio's own port. No name is looked up: `localhost` is connected to at `127.0.0.1`, and at `::1` when nothing listens there. Only `http:`; another scheme, and a URL with a user name or password, are `INVALID_REQUEST` (400).
- **What is sent.** The method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), the path and query, `Host` as the URL has it, the headers given (one `Name: value` per line), and the body as it was typed. A body must be JSON, and is not sent with `GET`; `Content-Type: application/json` is added unless a content type is given. `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Upgrade`, `TE`, `Trailer`, `Proxy-Connection`, and `Expect` cannot be given. A request that breaks these rules is `INVALID_REQUEST` (400), and nothing is sent. The page's request is at most 1 MiB.
- **The answer.** Any status, as it came: a 4xx or 5xx is an answer, not an error, and nothing is judged. A redirect is shown with its `Location`, and not followed. The body is read up to 1 MiB, as UTF-8 text; beyond that the connection is closed and `truncated` is true. The value of a `Set-Cookie` header is replaced by `(set; the value is not shown)`. `durationMs` is from sending until the answer was read, on this machine.
- **Errors.** `CONNECTION_REFUSED` (502) when nothing listens; `TIMEOUT` (504) after 10 seconds, when what the API did is not known; `CONNECTION_FAILED` (502) when the connection broke.
- **What is kept.** Nothing: no request, header, body, or answer is logged, written to a file, or held by the server or in the page's storage.
- **`--api <url>`** (`startStudio({ api })`): an address that is checked as a request's would be when Studio starts, refused if it is not this machine's, given in `GET /api/status` as `api`, and put in the tab's URL field once. Studio does not start, find, or watch the application.
- Standalone and attached alike: the request goes from Studio's process to the API, and the database is seen in Rows and SQL as before.

### Not provided

- Creating, altering, or dropping tables; indexes; constraints. Table definitions are read, and are changed where the application defines them.
- Attaching to the REST sandbox or to a SQL console. Reading a stored database again while a read-only Studio is open.
- TypeORM entities as a source of definitions: a database that stores none is described from its rows.
- Access from another machine, accounts, and connections to a database server.
- Import and export, ERD, charts, and a query builder.
- In the API tab: requests to another machine, `https:`, following redirects, collections, saved requests or history, environments and variables, assertions and reports, importing API descriptions, and starting or watching the application.
