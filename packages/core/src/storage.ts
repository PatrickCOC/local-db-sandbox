import type { DatabaseState } from "./state.ts";

/**
 * Persistence contract. The core never knows where or how state is stored;
 * JSON files, memory, or other backends implement this interface.
 */
export interface StorageAdapter {
  load(): Promise<DatabaseState>;
  save(state: DatabaseState): Promise<void>;
}
