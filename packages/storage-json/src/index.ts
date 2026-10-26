export { JsonStorageAdapter, JsonStorageError } from "./json-storage-adapter.ts";
export type { JsonStorageOptions } from "./json-storage-adapter.ts";
export {
  ABSOLUTE_MAX_FILE_SIZE_MB,
  DEFAULT_MAX_FILE_SIZE_MB,
  STRONG_WARNING_SIZE_MB,
  WARNING_SIZE_MB,
  assertWithinSizeLimit,
  formatSizeWarning,
  maxFileSizeMbProblem,
} from "./size-limits.ts";
export type { SizeWarning, SizeWarningListener } from "./size-limits.ts";
export { assignTableFiles, isSafeTableFile, tableFileBase, tableFileStem } from "./table-files.ts";
export { SCHEMA_VERSION, beyondFileFormat, mergeSchemas, mergeTypes, parseSchemaDocument, readSchemaDocument, sameDatabaseSchema, sameSchema, toSchemaDocument } from "./schema-document.ts";
export type { SchemaDocument, SchemaDocumentColumn, SchemaDocumentTable } from "./schema-document.ts";
export { DIRECTORY_FORMAT_VERSION, DirectoryStorageAdapter } from "./directory-storage-adapter.ts";
export type { DirectorySaveReport, DirectoryStorageOptions } from "./directory-storage-adapter.ts";
export { createDatabase, databaseFormatFor, openDatabaseStorage } from "./open-database.ts";
export type { CreateDatabaseOptions } from "./open-database.ts";
export type { DatabaseContents, DatabaseFormat, DatabaseMetadata, DatabaseStorage, DatabaseStorageOptions } from "./database-storage.ts";
export { SizeWatch, configuredLimitBytes } from "./size-limits.ts";
export { convertDatabase } from "./convert.ts";
export type { ConversionResult, ConvertDatabaseOptions } from "./convert.ts";
export { CURRENT_FORMAT_VERSION, DatabaseFormatError, FORMAT_HISTORY, assessFormat, findMigrationPath, formatNotice, migrateCommand, readProblem, writeProblem } from "./format-version.ts";
export type { DatabaseFormatErrorCode, FormatCompatibility, FormatDescription, FormatStamp, FormatStatus, MigrationEdge } from "./format-version.ts";
export type { DirectoryMigrationOutput, DirectoryMigrationSource, FormatMigration } from "./format-migration.ts";
export { FORMAT_MIGRATIONS } from "./migration-registry.ts";
export { inspectDatabase } from "./inspect.ts";
export type { DatabaseInspection, InspectOptions } from "./inspect.ts";
export { migrateDatabase, planMigration } from "./migrate.ts";
export type { MigrationOptions, MigrationProgress, MigrationReport, MigrationStepReport } from "./migrate.ts";
export { DatabaseOwnedError, OWNER_MARK_SUFFIX, OWNER_RECORD_SUFFIX, OWNER_RECORD_VERSION, SERVING_OWNER_KINDS, canonicalDatabasePath, claimDatabase, claimDatabaseIfThere, describeOwner, describeOwnerKind, inspectOwner, ownerRecordPath, probeOwnerControl } from "./writer-owner.ts";
export type { DatabaseClaim, OwnerControl, OwnerInspection, OwnerKind, OwnerOptions, OwnerProbe, OwnerRecord } from "./writer-owner.ts";
