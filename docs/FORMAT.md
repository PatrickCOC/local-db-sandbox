# Database Format Versions and Migration

How a stored database says which format it is in, what a build of this package does with each format, and how a database is brought from an earlier format to the current one.

Decision records: D-028 (format versions and migration), D-033 and D-036 (what the schema document of format 4 holds), D-040 (format 5: what the schema document holds of indexes, constraints, and expressions).

## Two version numbers that are not related

| | What it counts | Where it is |
|---|---|---|
| Package version | Releases of `local-db-sandbox` (`0.1.0`, ...). | `package.json`, `local-db-sandbox --version` |
| Database format version | How a database is laid out on disk (`1` to `5`). | In the database itself |

A release that does not change how databases are stored does not change the format version, and one build reads and migrates several formats. Nothing in a database records the package version that wrote it, and compatibility is never decided from it.

## The format version

The format version is a whole number, counted separately for each kind of storage:

| Storage | Format | Status | What it is |
|---|---|---|---|
| Single file (`sandbox.db.json`) | 1 | current | One JSON document: `$meta`, `$config`, `$tableSchema` (optional), `data`. Written as a whole. |
| Directory (`sandbox.db/`) | 2 | read, migrated | `manifest.json`, `schema.json`, and one plain-named file per table. A save staged its files and moved them into place. |
| Directory (`sandbox.db/`) | 3 | read, migrated | Table files are never changed: a save writes new files, named after its generation, and replaces `manifest.json`. |
| Directory (`sandbox.db/`) | 4 | read, migrated | As format 3. `schema.json` may also hold keys, constraints, and indexes with their names, the schema's enumerated types, computed defaults, canonical types, and where each object comes from (D-033, D-036). |
| Directory (`sandbox.db/`) | 5 | current | As format 4, with a schema document of version 2: how an index is built and what its keys are, what a key or a constraint is beyond its columns, and what the text of an expression names (D-040). See [The schema document](#the-schema-document-schemajson). |

The numbers form one sequence for historical reasons (the single file came first), but the two kinds of storage are independent. The single file is not an old format of the directory: it is still written, and `convert` copies a database from one kind to the other. A directory never had format 1.

A database states two numbers:

- `formatVersion`: the format it was written in.
- `minimumReaderVersion`: the oldest format whose readers read it correctly. It is equal to `formatVersion` unless a format was designed so that readers of an earlier one still can. When it is not stated, it is `formatVersion`.

A build has one number per kind of storage: the format it writes. It writes no other.

### Where they are stored

Directory, in `manifest.json`, which is read before anything else:

```json
{
  "formatVersion": 5,
  "minimumReaderVersion": 4,
  "database": "sandbox",
  "persistence": "json",
  "generation": 12,
  "schema": "schema.json",
  "tables": [{ "name": "users", "file": "users.g12.json" }]
}
```

Single file, in `$meta`:

```json
{ "$meta": { "version": 1 }, "data": { "users": [] } }
```

**The rule for a single file that states no version:** a file without `$meta` is format 1. Format 1 is the only format that was ever written without a version, so there is nothing else such a file could be. It is read and written like any other format 1 file, and every save writes `"$meta": { "version": 1 }`. Stating the version is not a migration: the format is the same before and after.

A single file does not write `minimumReaderVersion` (it would be 1, which is the default), so that existing files keep their bytes. It is honoured when a file has it.

## What a build does with a database

Decided in one place (`assessFormat` in `packages/storage-json/src/format-version.ts`) from the database's two numbers and the build's:

| The database's format is | Read | Save | What you see |
|---|---|---|---|
| the current one | yes | yes | Nothing. |
| an earlier one that this build has a migration from (directory formats 2, 3, and 4) | yes, as it is | no | `Database format 2 is older than the format this build writes (5). ... migrate it first: local-db-sandbox migrate sandbox.db` |
| a later one whose `minimumReaderVersion` is at most this build's format | yes | no | `Database format 6 is newer than this build supports (max 5). It says that a reader of format 5 can read it ... Upgrade local-db-sandbox.` |
| a later one otherwise | no | no | `Database format 6 is newer than this build supports (max 5). Upgrade local-db-sandbox.` |
| an earlier one that this build has no migration from | no | no | `Database format 1 is older than this build supports (oldest: 2). Migrate it with an earlier version of local-db-sandbox, one that reads format 1, and then with this one.` |

- **Reading never changes a database.** Not its format, not its files, and not a save that an earlier format left half done (see [Format 2](#directory-format-2-to-3)).
- **A build writes only the format that is its current one.** There is no writer for an earlier format, and none is guessed for a later one.
- **A later format is never interpreted.** For a database this build cannot read, only the two version numbers are looked at; `inspect` shows them and nothing else.
- **Whether a later format can be read is for the database to say**, with `minimumReaderVersion`. A build that reads such a database reads it with its own, strict reader: a later format may only claim this when it adds nothing that readers of the earlier format would have to understand.

## No automatic migration

Nothing migrates a database as a side effect of opening it or saving to it. `local-db-sandbox migrate` is the only thing that changes a database's format.

Before this was decided, a format 2 directory became format 3 with the first save of whatever opened it. That is gone:

- A sandbox that saves (the REST server, the NestJS sandbox with `"persistence": "json"`, the SQL console without `--read-only` or `--no-save`, `init-nest` when it has something to add) **does not start** on a database of another format. It prints the message above, with the command to run, and changes nothing.
- A session that does not save (`"persistence": "memory"`, `sql --read-only`, `sql --no-save`, the source of `convert`) opens a readable database of another format as it is and prints a note that names its format.
- `convert --force` onto an existing database replaces it with a new database, which is in the current format. That is the replacement you asked for, not a migration.

Why not migrate at start: a migration cannot be undone by an older build of this package, so it should happen when you decide, and you should be able to see what it would do first (`migrate --dry-run`).

## `schema.json` has no version of its own

`schema.json` carries `"schemaVersion": 2` in a directory of format 5, and `"schemaVersion": 1` in a directory of an earlier format; `$tableSchema` in a single file carries `1`. That number is a marker of the document's layout, and of how the document is read: a version 1 document could not say what version 2 added, so what it leaves out means something else there than in a version 2 document (see [Directory format 4 to 5](#directory-format-4-to-5)). It is checked when the document is read, a version 1 document with a key of version 2 is refused, and it is not a second compatibility number:

- The document is never read on its own. A reader reaches it through `manifest.json` or `$meta`, which have already decided whether the database can be read.
- It cannot be published on its own either. A change to it becomes part of the database only with a manifest (or with the single file it is in).
- So a change to how table definitions are written is a new **database format version**, for each kind of storage that holds them, with a migration like any other. The two migrations can share the code that rewrites the document.

One number per database is what `inspect` shows and what a build checks. A second one would give every database two numbers, two migration paths, and combinations to support, for no case that the format version does not cover.

Two additions to the document were made before this rule existed, without a new format version: the `declaredType` of a column, and the storage type `binary`. Builds from before them refuse a document that has either, by its content. Under the rule above, each would have been a new format.

## The schema document (`schema.json`)

The file that a directory's manifest names under `schema` (`schema.json`, or `schema.g<generation>.json` once it was saved again) is the database's schema: the stored form of the sandbox's canonical schema (D-033, D-036). The relational runtime creates its tables from it, the PostgREST endpoint takes types and keys from it, and `diff-schema` compares two of them. Tables without an entry are described from their rows by whoever opens the database.

This is what directory format 4 may hold, and directory format 5 with `"schemaVersion": 2` and the keys of [version 2](#version-2-of-the-document). A format 3 document is the same with fewer keys (below), and is a valid format 4 document.

```json
{
  "schemaVersion": 1,
  "types": {
    "enums": [
      { "name": "mood", "values": ["ok", "meh"], "sourceDialectType": { "dialect": "postgresql", "type": "mood" } }
    ]
  },
  "tables": [
    {
      "name": "notes",
      "columns": [
        {
          "column": "id",
          "property": "id",
          "type": "integer",
          "declaredType": "bigint",
          "canonicalType": { "kind": "integer", "bits": 64 },
          "sourceDialectType": { "dialect": "postgresql", "type": "int8" },
          "nullable": false,
          "primaryKey": true,
          "generated": "increment"
        },
        {
          "column": "author_id",
          "property": "author_id",
          "type": "integer",
          "declaredType": "int",
          "canonicalType": { "kind": "integer", "bits": 32 },
          "sourceDialectType": { "dialect": "postgresql", "type": "int4" },
          "nullable": false,
          "primaryKey": false,
          "references": { "table": "authors", "column": "id", "onDelete": "CASCADE", "name": "notes_author_fkey" },
          "origin": {
            "source": "postgresql-migrations",
            "file": "0001_init.sql",
            "sha256": "100a4a5492b73e7776116722070f9cd5a981ec854696355815df82ed990de11e",
            "statement": 3,
            "line": 3,
            "name": "author"
          },
          "renames": [
            {
              "from": "author",
              "to": "author_id",
              "at": {
                "source": "postgresql-migrations",
                "file": "0002_rename.sql",
                "sha256": "0d6e341222241074cab0dfdc31a5711e197e3a4e361bc846079e5adc596ed222",
                "statement": 1,
                "line": 1
              }
            }
          ]
        },
        {
          "column": "body",
          "property": "body",
          "type": "text",
          "declaredType": "varchar(200)",
          "canonicalType": { "kind": "varchar", "length": 200 },
          "nullable": false,
          "primaryKey": false
        },
        {
          "column": "mood",
          "property": "mood",
          "type": "text",
          "declaredType": "mood",
          "canonicalType": { "kind": "enum", "name": "mood" },
          "nullable": true,
          "primaryKey": false,
          "default": "ok",
          "enum": "mood"
        },
        {
          "column": "created_at",
          "property": "created_at",
          "type": "datetime",
          "declaredType": "timestamptz",
          "canonicalType": { "kind": "timestamp", "withTimeZone": true },
          "nullable": false,
          "primaryKey": false,
          "defaultFunction": "current_timestamp",
          "defaultExpression": "now()"
        }
      ],
      "primaryKey": { "name": "notes_pkey", "columns": ["id"] },
      "uniques": [{ "name": "notes_author_body_key", "columns": ["author_id", "body"] }],
      "indexes": [{ "name": "notes_created_idx", "columns": ["created_at"] }],
      "checks": [{ "name": "notes_body_check", "expression": "body <> ''" }]
    }
  ]
}
```

The example is cut down from what `init` writes for two small migrations: there, every object has its `origin` and every column its `sourceDialectType`, and the table `authors` is listed as well.

### Its keys

| Where | Key | Meaning |
|---|---|---|
| document | `schemaVersion` | `2` in a directory of format 5, `1` before that and in a single file: a marker of the layout, not a second format version (above). |
| | `types.enums` | The schema's enumerated types. Present when there are any. |
| | `tables` | The tables. |
| enumerated type | `name`, `values` | The type's name, and its values in their order, each once. A type no column uses may be there. |
| | `sourceDialectType` | The type as its source's database names it: `{ "dialect", "type" }`. |
| | `valueRenames` | Renames of its values that the source states, oldest first. |
| table | `name`, `columns` | Its name, and its columns in their order. |
| | `primaryKey` | The key as a constraint: `name` (optional) and `columns` in the key's order, which need not be the table's. Its columns are exactly the columns marked `primaryKey`. |
| | `uniques` | Unique constraints: `name` (optional), `columns` in order. Enforced. |
| | `foreignKeys` | Foreign keys over several columns: `name` (optional), `columns`, `references` (`table`, `columns`), `onDelete`, `onUpdate`. Enforced when the table they refer to exists. |
| | `indexes` | `name`, `columns` in order, `unique`, `expressions`, `where`. One over columns alone is created (a unique one enforced); one with expressions or a condition is kept as information. |
| | `checks` | `name` (optional), `expression`. Kept as information, not enforced. |
| column | `column`, `property` | The name in SQL, and the key of the value in a row (the same, unless an ORM names them apart). |
| | `type` | The storage type: `integer`, `real`, `numeric`, `text`, `boolean`, `datetime`, `date`, `json`, `binary`, or `any`. How values are held. The only type the runtime acts on. |
| | `declaredType` | The type as the source of the definitions wrote it. Information. |
| | `canonicalType` | What the type is, independent of spelling and dialect (below). Information; `diff-schema` compares it. |
| | `sourceDialectType` | The type as the source's database names it: `{ "dialect", "type" }`. Information. |
| | `nullable`, `primaryKey` | Whether the column may be null, and whether it is a key column. |
| | `generated` | How a value is made when none is given: `increment` (numbered by the runtime when it is the table's single integer key), `uuid`, or another strategy's name (information). |
| | `default` | A constant default, as a fixture value. |
| | `defaultFunction` | A default the runtime computes at the write: `current_timestamp` (a `datetime` column) or `current_date` (a `date` column). Not together with `default`. |
| | `defaultExpression` | The default as the source wrote it (`now()`, `gen_random_uuid()`). Information. |
| | `references` | A foreign key of this one column: `table`, `column`, `onDelete`, `onUpdate`, `name`. Enforced when the table exists. |
| | `enum` | The name of the enumerated type (of `types.enums`) whose values the column takes. Enforced. |
| any of these objects, and a column's `references` | `origin` | The statement that created the object: `source` (the collector, such as `postgresql-migrations`), `file`, `sha256` of the file, `statement` (its number in the file), `line`, `name` (the name it was created with), and `generatedName` when that name was not in the statement. |
| | `renames` | Renames that the source states, oldest first: `from`, `to`, and `at` (the position of the statement that renamed, as in `origin`). |

A canonical type is an object with a `kind`:

| `kind` | Other keys |
|---|---|
| `boolean`, `text`, `uuid`, `date`, `binary` | none |
| `integer` | `bits`: 16, 32, or 64 |
| `float` | `bits`: 32 or 64 |
| `decimal` | `precision`, `scale` (both optional; a scale needs a precision, and is any whole number: below zero it rounds to the left of the point, and it may be above the precision) |
| `varchar`, `char` | `length` (optional) |
| `time`, `timestamp` | `withTimeZone`, `precision` (optional) |
| `interval` | `precision` (optional) |
| `json` | `binary`: `true` for JSON stored decomposed (PostgreSQL's `jsonb`) |
| `enum` | `name`: an enumerated type of `types.enums` |
| `array` | `element`: a canonical type |
| `other` | `dialect`, `name`, `modifiers` (optional): a type of one dialect that has no canonical meaning, kept as that dialect's |

### Version 2 of the document

Directory format 5 (D-040). Everything here is optional, and is left out when it says nothing: an index without `method` is a B-tree, a constraint without `deferrable` is not deferrable.

| Where | Key | Meaning |
|---|---|---|
| index | `method` | How the index is built, by the name its source's database has for it: `gin`, `gist`, `hash`, `brin`, or an extension's. Absent for a B-tree. |
| | `keys` | The keys in their order, when `columns` and `expressions` do not say them: each is a `column` or an `expression`, with `order` (`desc`), `nulls` (`first`, `last`; only where that is not what the order gives anyway), `operatorClass`, and `collation`. With `keys`, `columns` and `expressions` are the columns and the expressions of the keys, in that order. An index with both and without `keys` (a version 1 document) does not say in which order they stand. |
| | `include` | Columns the index carries along without their being part of its key. |
| | `nullsNotDistinct` | For a unique index: two rows that hold NULL in the keys are the same to it. |
| primary key, unique constraint | `include`, `deferrable` | The columns its index carries along; and `immediate` or `deferred` for a constraint that is deferrable, by what it starts out as. |
| unique constraint | `nullsNotDistinct` | As for an index. |
| foreign key, a column's `references` | `deferrable` | `immediate` or `deferred`. |
| index, key, constraint, check, `references` | `sourceClauses` | What the source says of the object that the schema has no place for, as text: `MATCH FULL`, `NOT VALID`, `NO INHERIT`, `NOT ENFORCED`, `WITH (fillfactor=70)`, a tablespace, the parameters of an operator class. An object with any is another object than one without, and is not written for another database from the schema. |
| check, index with an expression or a condition | `names` | What the text names of the things a rename can reach, each as `{ "kind", "name" }` with `now` when that thing is called something else by now, and `type` for a value of an enumerated type. `kind` is `column`, `table`, `type`, `value`, or `function`. Columns of the table, the table, enumerated types, and their values are all listed, so an empty list says that the text names none; a function, and a type that is not enumerated, is listed only when it was renamed since. |
| | `mayBeStale` | `true`: it is not known what the text names, and a rename may have reached it. Never together with `names`. |
| column | `defaultNames`, `defaultMayBeStale` | The same for `defaultExpression`. A default names no column, and not its table. |

A name with a `now` is stale: the text is as the source wrote it, and the source's database has it under the new name. `diff-schema` compares two texts that read alike by what they name, and `generate-migration` does not write a stale text into a database (see `docs/COMPATIBILITY.md`).

In version 2 a column may be of an enumerated type by its `canonicalType` alone (`{ "kind": "enum", "name": ... }`, with the type under `types.enums`) without naming it under `enum`. Such a column does not carry the type's values, and the runtime does not check its values against them. This is how a database directory of TypeORM entities says what an enumerated column is in the entities' own database.

None of this changes what the runtime creates: an index is still an ordinary index over `columns`, a deferrable constraint is checked at each statement, and a check is not enforced. It is what the schema says of the database it describes.

### Rules

- **The document is checked strictly when it is read.** An unknown key anywhere, a column of a type that is not a storage type, a constraint that names a column the table does not have, a `primaryKey` that does not agree with the columns marked as key columns, an `enum` or a canonical type that names a type `types.enums` does not define, and a canonical type that is not one, are each an error that names the place.
- **And it is checked with the same reader before it is written.** A database directory does not store definitions that this build could not read back: the save is refused with the reader's message, and nothing is written.
- **An enumerated type is defined once**, under `types.enums`, and a column names it. The values are not repeated on the column. A document with the values on a column (a shape that existed for a short time before format 4 was final) is refused, with a message that says how to write it.
- **What may be left out** of a document written by hand: `property` (the column name), `nullable` (true, except for key columns), `primaryKey` (false; a column that the table's `primaryKey` lists is a key column), and every key marked optional or "information" above. A schema needs no canonical types and no provenance. `diff-schema` then compares what was declared, and finds no renames.
- **Provenance and the three informational types change nothing the runtime does.** Two schemas never differ because their provenance does. It is what lets a rename be told from a drop and an add: two objects with the same `origin` are the same object.
- **The schema file is replaced as a whole** when the definitions change, under a new name, like a table's file. It is not edited in place.

### In a single file

A single-file database keeps a document of version 1 under `$tableSchema`, with what format 1 had: `column`, `property`, `type`, `declaredType`, `nullable`, `primaryKey`, `generated`, `default`, and `references` with `table`, `column`, and `onDelete`. Everything else in the tables above is beyond it: a single file that would hold any of it is refused when it is saved or read, and the message names what (enumerated types and values, primary key names or order, unique constraints, foreign keys over several columns, indexes, check constraints, computed defaults, named foreign keys or `ON UPDATE` actions, canonical types, provenance). Use a database directory (`convert`).

## Commands

### `inspect`

```sh
npx local-db-sandbox inspect sandbox.db
```

```text
Database: sandbox.db
Storage: directory
Format version: 2
Current supported version: 4
Migration required: yes
Migration path: 2 -> 3 -> 4
Tables: 41
Logical size: 383.1 KB (392,294 bytes)
This build reads the database as it is and does not change it. To bring it to format 5: local-db-sandbox migrate sandbox.db
```

- Nothing is written, whatever the format.
- Of a directory, only `manifest.json` is read. The sizes of the other files come from the file system. A single file has to be read to find its version, so the size limit (`--max-file-size`) applies to it as when it is loaded.
- `Logical size` is the size of the files the database consists of now: what the size limit applies to. Files of earlier generations that are still in a directory are not counted.
- A database in a format this build does not support is described too, as far as the version numbers go, and the command exits with 0. It exits with 1 only for something that is not a database.
- `Minimum reader version` is shown when it differs from the format version.

`--json` prints the same as one JSON object:

```json
{
  "database": "sandbox.db",
  "storage": "directory",
  "formatVersion": 2,
  "versionDeclared": true,
  "minimumReaderVersion": 2,
  "currentVersion": 4,
  "oldestSupportedVersion": 2,
  "compatibility": "older",
  "readable": true,
  "writable": false,
  "migrationRequired": true,
  "migrationPath": [2, 3, 4],
  "tables": 41,
  "generation": 0,
  "logicalSizeBytes": 392294,
  "notes": []
}
```

`compatibility` is `current`, `older`, `newer`, `unsupported-old`, or `unsupported-new`: the five rows of the table above. `tables`, `generation`, and `logicalSizeBytes` are absent for a format this build does not read.

### `migrate`

```sh
npx local-db-sandbox migrate sandbox.db --dry-run   # what it would do; changes nothing
npx local-db-sandbox migrate sandbox.db             # do it
```

```text
Database: sandbox.db
Storage: directory
Format version: 2
Target version: 5
Migration path: 2 -> 3 -> 4 -> 5
Step 2 -> 3: The manifest gains a generation and names the schema file. Table files stay where they are and are never changed again: a later save writes a new file for each table it changes and replaces the manifest.
  manifest.json: formatVersion 2 -> 3; adds minimumReaderVersion 3, generation 1, and schema "schema.json"
  schema.json: kept as it is
  tables/: 41 table files kept as they are
Step 3 -> 4: The schema file may also hold constraints and indexes with their names, enumerated types, computed defaults, canonical types, and where each object comes from. Nothing of the database changes; the manifest states the new format.
  manifest.json: formatVersion 3 -> 4, minimumReaderVersion 4
  schema.json: kept as it is (a format 3 schema is a valid format 4 schema)
  tables/: 41 table files kept as they are
Step 4 -> 5: The schema file may also hold how an index is built and what its keys are, whether a constraint is deferrable, clauses of the source that the schema has no place for, and what the text of an expression names. The schema file is written again in that form; the tables stay as they are.
  manifest.json: formatVersion 4 -> 5, minimumReaderVersion 5, generation 2, schema "schema.g2.json"
  schema.json -> schema.g2.json: written again as a schema document of version 2
  tables/: 41 table files kept as they are
Migrated sandbox.db from format 2 to format 5. 41 tables (1,204 rows), the table definitions, and the configuration were read back from the result before it was published, and are the same as before.
```

| Option | Effect |
|---|---|
| `--dry-run` | Prints the current format, the target, the steps, and what the first step would change in this database. Ends with `Dry run: nothing was changed.` |
| `--to <version>` | Migrate to this format instead of the current one. It must be one this build knows and not below the database's own: a database is not taken back to an earlier format. |
| `--json` | Prints the report as JSON (`formatVersion`, `targetVersion`, `migrationPath`, `steps` with their `changes` and `status`, `dryRun`, `migrated`, `tables`, `rows`). |
| `--max-file-size <MB>` | Largest database to accept, as for every other command. |

- A database that is in the target format already is left alone (`Nothing to migrate`), so the command can be run again, and in scripts.
- Stop a sandbox that uses the database first, and start it again afterwards. One process saves a database at a time; a migration is refused while another process is saving.
- With a path of several steps, a dry run lists every step and shows the exact changes of the first. A later step starts from a state that does not exist yet.

## How a migration is carried out

A migration (`FormatMigration` in `format-migration.ts`) does not write the database. It says what the database consists of in the target format: a manifest, files to add, and files that are no longer needed. The engine (`migrate.ts`) does the rest the same way for every migration:

1. Takes the save lock (`manifest.json.tmp`), the same one a save takes. A second process that tries to save or migrate is refused.
2. Finishes what the source format requires to be finished before it can be read (format 2: a committed save whose files are not all in place).
3. Reads the database in its source format: every table, the definitions, the configuration.
4. Asks the migration for the result, and writes the files it adds next to the existing ones. A file that is part of the database is never changed or replaced; a name that exists is an error.
5. **Checks the result before it is the database.** The new manifest must be a valid manifest of the target format. The database is read back through it, as a reader of the new format will, and compared with what was read in step 3: every row of every table, the table definitions, the configuration, the name, the persistence mode, and the extra keys must be the same (a migration that is meant to change one of these supplies its own check). The size limit applies to the result. Nothing the result consists of may be on the list of files to remove.
6. **Publishes it by replacing `manifest.json`, in one rename.** This is the migration.
7. Removes what is part of neither format.

| If it stops | The database is |
|---|---|
| in steps 1 to 5, for any reason (an error, a failed check, a killed process, a power cut) | the old format, complete. What was written is not named by any manifest; the next save or migration removes it. Run `migrate` again. |
| in step 6 | the old format or the new one. A rename is one step for the file system. |
| in step 7 | the new format, complete. What was not removed is not part of the database; the next save removes it. |

There is no state in which the database is partly migrated, so there is nothing to recover and no recovery command.

- **Processes that read meanwhile** get the old format or the new one, each complete. A reader reads `manifest.json` and then the files it names, and a migration removes no file that either manifest names until the new one is in place. (For 2 to 3 the table files are the same files in both.)
- **One writer.** The lock is the one saves use. An older build that saves format 2 does not know it: do not run one on the database while migrating.
- **Several steps** are several publications. Stopped between two, the database is in the format the last finished step leads to, which is a format in its own right, and `migrate` goes on from there.

### Backup

`migrate` makes no copy of the database.

The steps 2 to 3 and 3 to 4 replace one file, `manifest.json`, and what that file said is in the new one. The step 4 to 5 also writes the schema file again, under the name of a new generation, as a save writes a schema that changed. Rows and table definitions stay in the files they were in. Nothing is lost that a backup would bring back, so a copy of every table would only double the database's size on disk.

What a migration cannot give you is the way back: a build that writes format 2 cannot read format 3. To keep a database for an older build, copy the directory before you migrate it (`cp -r sandbox.db sandbox.db.format-2`). It is a development fixture of at most 250 MB.

A future migration that replaces something the remaining files do not hold must say so in its own description and keep what it replaces until asked to remove it. That is part of adding the migration, not something the engine can decide.

## Directory format 2 to 3

What changes: the manifest gains `minimumReaderVersion`, `generation` (1), and `schema` (the name of the schema file). Every other file stays as it is and where it is. From then on a save writes a new file for each table it changes (`users.g2.json`) and replaces the manifest, and a file that is part of the database is never changed again.

A format 2 save staged its files in `.staging-<pid>-<n>/`, committed by writing `.commit.json`, and moved the files into place. Two things can be left of one:

- **A staging folder without `.commit.json`:** the save never happened. The folder is not part of the database, is ignored when the database is read, and is removed by the migration.
- **`.commit.json`:** the save happened, and its files are not all in place. A format 2 build finished the move when it next read the database. This build does not do that when it reads, because reading does not change a database: it refuses the directory and says that migrating finishes the save. `migrate` finishes it first, as format 2 itself would, and then migrates the result. `inspect` and `migrate --dry-run` report it and leave it. While the process that made the save is still running, `migrate` is refused.

## Directory format 3 to 4

What changes: `manifest.json` states `formatVersion` 4 and `minimumReaderVersion` 4. Nothing else is written: a format 3 `schema.json` is a valid format 4 one, and the table files stay as they are.

Why a new format for a change to `schema.json`: a format 3 reader refuses a schema with keys it does not know, so a database that holds any of what format 4 added must not look readable to it. `minimumReaderVersion` is 4 for the same reason. Such schemas come from `init` (PostgreSQL migrations) and can be written by hand.

What format 4 added to the document, all of it optional (the keys are in [The schema document](#the-schema-document-schemajson)):

| Added | Keys | Decision |
|---|---|---|
| unique constraints, foreign keys over several columns, indexes, check constraints | a table's `uniques`, `foreignKeys`, `indexes`, `checks` | D-033 |
| a foreign key's name and `ON UPDATE` action | `name` and `onUpdate` of a column's `references` | D-033 |
| computed defaults, and the default as the source wrote it | a column's `defaultFunction`, `defaultExpression` | D-033 |
| the schema's enumerated types, which columns name | `types.enums`; a column's `enum` (a type's name) | D-036 |
| the primary key as a constraint, with its name and the order of its columns | a table's `primaryKey` | D-036 |
| what a column's type is, and the source dialect's name for it | a column's `canonicalType`, `sourceDialectType` | D-036 |
| where each object comes from, and the renames the source states | `origin`, `renames`; an enumerated type's `valueRenames` | D-036 |

The second half of the list (D-036) was added to format 4 before any build that writes format 4 left this repository, so it is part of format 4 and not a format 5. One thing changed shape on the way: at first a column carried its enumerated values itself (`"enum": { "name", "values" }`). A document like that is refused when it is read, and the message says to declare the type under `types.enums` and name it on the column.

The single file stays format 1. It cannot hold any of this: a single-file database that would is refused when it is saved or read, with a message that names what and says to use a database directory (`convert`). Its readers are unchanged, so none of its databases needs a migration.

A directory of format 2 is migrated in three steps, 2 to 3, 3 to 4, and 4 to 5, each published on its own.

## Directory format 4 to 5

What changes: `manifest.json` states `formatVersion` 5 and `minimumReaderVersion` 5, and the schema file is written again as a document of version 2, under the name of the next generation (`schema.g<generation>.json`); the old schema file is removed when the migration is published. The table files stay as they are. A directory without a schema file gets the new manifest and nothing else.

Why a new format, and not more optional keys in format 4: a format 4 reader would refuse the new keys, and, more to the point, the absence of a key does not mean the same in the two versions. A format 4 schema could not say how an index is built or what the text of an expression names. An index without `method` there is one whose method was not kept; in version 2 it is a B-tree. So the version decides how a document is read:

- A version 1 document is read as it always was, and none of the keys of version 2 is taken from it: one that has such a key is refused.
- Where a version 1 document records a rename that may have reached the text of an expression, that text is marked `mayBeStale`: an expression of a table whose own name or one of whose columns was renamed, and every expression, a default too, when an enumerated type or a value of one was. Version 1 did not record what a text names, so nothing better can be said. What a rename did not reach is left as it is, and a document that records no rename at all (one written by hand) is not touched.
- A document that states no version is read as one of the current version: one written by hand says what it means.

`migrate` reports how many expressions it marked. For a database that came from PostgreSQL migrations, running `init` again gives a schema that says exactly what each text names; a marked expression is only refused where it would have to be written into another database (`generate-migration`).

Format 4 is still read, and not written: a session that would save to a format 4 directory is refused with the instruction to migrate, as for every earlier format. A build from before format 5 refuses a format 5 directory by its version numbers, and looks at nothing else in it.

The single file stays format 1, and its schema document stays version 1: it can hold none of this. A database directory of TypeORM entities holds each column's canonical type and the enumerated types of the entities since format 5; `convert` to a single file leaves those out, since they are worked out from the entities whenever the application opens the file, and says so. Everything a source said itself (a schema from migrations) is refused there as before, not left out.

## Adding a format

1. Raise `CURRENT_FORMAT_VERSION` for the kind of storage and describe the format in `FORMAT_HISTORY` (`format-version.ts`).
2. Write the migration from the format before it and add it to `FORMAT_MIGRATIONS` (`migration-registry.ts`). It says what the result consists of; it does not write, lock, or publish.
3. Teach the reader the new manifest. Formats that this build reads share one manifest reader (`parseManifest`); what an earlier format did not have yet is optional there.
4. Add a database of the new format to `packages/storage-json/test/fixtures/formats/`, and keep the existing ones as they are. They stand for what is on people's disks.
5. Decide `minimumReaderVersion`: the new version, unless readers of the format before it read the new one correctly as it is.

The test `have a migration to the current one from every earlier format of the history` fails when a format is added without its migration.

A single-file database has had one format, so there is no migration for it and the engine has no executor for one. The first one will be a rewrite of the file through a temporary file and a rename, as every save of a single file is.

## Limits

- Downgrading is not supported: no command takes a database back to an earlier format.
- A build from before format versions were formal (it wrote directory format 3 without `minimumReaderVersion`) refuses a manifest that has the key, because it checked a manifest's keys strictly. Its own databases are read by this build as format 3 and need no migration; the key is written with their next save.
- Format 2 builds do not know the save lock of format 3. A format 2 build that saves while the directory is migrated can put its own, format 2, manifest back in place afterwards. Stop older builds before migrating.
- Files are not synced to disk before the rename, as for every save (D-025). After a power cut the database is the old format or the new one as far as the file system kept its promise about renames.
- `inspect` reads a directory's manifest once and then looks at the sizes of the files it names. While another process is saving, a file can be gone by then; that is reported as a note, not as an error.
