import { openOwnedTypeormSandbox } from "./owned-sandbox.ts";
import type { OwnedTypeormSandbox } from "./owned-sandbox.ts";
import { loadTypeorm, openTypeormSandbox } from "./typeorm-runtime.ts";
import type { EntityClass, SandboxStorageOptions, TypeormSandbox } from "./typeorm-runtime.ts";

export interface SandboxModuleOptions extends SandboxStorageOptions {
  /** The entity classes the sandbox creates tables for; each also gets a repository provider. */
  entities: EntityClass[];
}

/** Injection token of the `RelationalRuntime` behind the sandbox's TypeORM DataSource. */
export const SANDBOX_RUNTIME = "LocalDbSandboxRuntime";

const SANDBOX_CONNECTION = "LocalDbSandboxConnection";

/** Token that `@InjectRepository(Entity)` of @nestjs/typeorm uses for the default data source. */
export function sandboxRepositoryToken(entity: EntityClass): string {
  return `${entity.name}Repository`;
}

/** Shape of a NestJS dynamic module; declared here so that NestJS is not a dependency. */
export interface SandboxDynamicModule {
  module: typeof SandboxModule;
  global: true;
  providers: { provide: unknown; useFactory: (...dependencies: any[]) => unknown; inject?: unknown[] }[];
  exports: unknown[];
}

/**
 * Opens the JSON database file as a SQLite runtime and returns a TypeORM
 * DataSource connected to it, without NestJS:
 * `(await createSandboxDataSource(options)).dataSource.getRepository(User)`.
 */
export function createSandboxDataSource(options: SandboxModuleOptions): Promise<TypeormSandbox> {
  return openTypeormSandbox(options);
}

function providers(typeorm: Record<string, any>, open: () => Promise<OwnedTypeormSandbox>, entities: EntityClass[]): SandboxDynamicModule["providers"] {
  return [
    {
      provide: SANDBOX_CONNECTION,
      useFactory: async () => {
        const sandbox = await open();
        // NestJS calls this hook on providers when the application closes: the DataSource is closed, and the database let go of.
        return { ...sandbox, onApplicationShutdown: () => sandbox.close() };
      },
    },
    { provide: typeorm.DataSource, useFactory: (sandbox: TypeormSandbox) => sandbox.dataSource, inject: [SANDBOX_CONNECTION] },
    { provide: typeorm.EntityManager, useFactory: (sandbox: TypeormSandbox) => sandbox.dataSource.manager, inject: [SANDBOX_CONNECTION] },
    { provide: SANDBOX_RUNTIME, useFactory: (sandbox: TypeormSandbox) => sandbox.runtime, inject: [SANDBOX_CONNECTION] },
    ...entities.map((entity) => ({
      provide: sandboxRepositoryToken(entity),
      useFactory: (sandbox: TypeormSandbox) => sandbox.dataSource.getRepository(entity),
      inject: [SANDBOX_CONNECTION],
    })),
  ];
}

/**
 * NestJS module that stands in for `TypeOrmModule.forRoot(...)`.
 *
 * It provides, globally and under TypeORM's own tokens, a real TypeORM
 * `DataSource` and `EntityManager` whose connection is the sandbox's SQLite
 * runtime, loaded from the JSON database file. Feature modules that import
 * `TypeOrmModule.forFeature([...])`, and the services that inject
 * repositories, stay as they are and get ordinary TypeORM repositories.
 *
 * The database is the application's while it runs (D-042): the module
 * claims it before it is read, serves the runtime to this machine so that
 * Local DB Studio can look into it, and lets go of it when the application
 * closes. A second application on the same database is refused.
 */
export class SandboxModule {
  static forRoot(options: SandboxModuleOptions): SandboxDynamicModule {
    const typeorm = options.typeorm ?? loadTypeorm();
    const all = providers(typeorm, () => openOwnedTypeormSandbox({ ...options, typeorm }), options.entities);
    return { module: SandboxModule, global: true, providers: all, exports: all.map((provider) => provider.provide) };
  }

  /**
   * The same for every entity class the application has loaded by the time
   * it starts, as used by the generated sandbox entry point. Repositories
   * come from `TypeOrmModule.forFeature`.
   */
  static forLoadedEntities(options: SandboxStorageOptions & { onWarnings?: (warnings: string[]) => void }): SandboxDynamicModule {
    const typeorm = options.typeorm ?? loadTypeorm();
    const open = async (): Promise<OwnedTypeormSandbox> => {
      const sandbox = await openOwnedTypeormSandbox({ ...options, typeorm });
      options.onWarnings?.(sandbox.warnings);
      return sandbox;
    };
    const all = providers(typeorm, open, []);
    return { module: SandboxModule, global: true, providers: all, exports: all.map((provider) => provider.provide) };
  }
}
