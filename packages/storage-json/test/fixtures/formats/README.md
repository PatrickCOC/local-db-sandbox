# Databases of every format

Each entry is a database as a build of that format left it on disk. The tests
copy one to a temporary folder and inspect, open, or migrate the copy.

| Entry | What it is |
|---|---|
| `directory-format-2/` | Directory format 2: plain file names, no generation, table definitions without `declaredType`. |
| `directory-format-3/` | Directory format 3 after a few saves: one table and the schema have files named after a generation. |
| `directory-format-4/` | Directory format 4: the format 3 entry as the migration to format 4 leaves it (only `formatVersion` and `minimumReaderVersion` in the manifest differ). |
| `directory-format-5/` | Directory format 5: the format 4 entry as the migration to format 5 leaves it (the schema file written again as a schema document of version 2, under the name of a new generation; the table files are the same). |
| `file-format-1.db.json` | Single file, format 1, with `$meta.version`, `$config`, `$tableSchema`, and an extra key. |
| `file-unversioned.db.json` | Single file without `$meta`: read as format 1. |

They stand for what is on people's disks. Do not rewrite them with the
current build when a format changes: add an entry for the new format, and
keep these as they are.
