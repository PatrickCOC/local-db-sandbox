import { TypeOrmModuleOptions } from "@nestjs/typeorm";

/** The real database of this application: an in-memory SQLite database. */
export function databaseOptions(): TypeOrmModuleOptions {
  console.log("Connecting to the original database");
  return { type: "sqljs", autoLoadEntities: true, synchronize: true };
}
