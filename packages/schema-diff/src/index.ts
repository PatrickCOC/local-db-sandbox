export { diffSchemas, renameEvidence, stringifySchemaDiff } from "./diff.ts";
export { formatSchemaChange, formatSchemaDiff } from "./format.ts";
export { CHANGE_ORDER, SCHEMA_DIFF_VERSION } from "./ir.ts";
export type {
  CheckState,
  ColumnState,
  ConstraintKind,
  DefaultState,
  EnumState,
  ForeignKeyState,
  IndexState,
  PrimaryKeyState,
  ReferentialAction,
  RenameEvidence,
  SchemaChange,
  SchemaChangeOp,
  SchemaDiff,
  TableState,
  TypeState,
  UniqueState,
} from "./ir.ts";
export { stableStringify } from "./stable-json.ts";
