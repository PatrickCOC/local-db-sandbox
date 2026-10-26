import { ChildEntity, Column, Entity, EntitySchema, PrimaryGeneratedColumn, TableInheritance, ViewColumn, ViewEntity } from "typeorm";

@ViewEntity({ expression: "SELECT 1 AS id" })
export class Summary {
  @ViewColumn()
  id!: number;
}

@Entity()
@TableInheritance({ column: { type: "varchar", name: "kind" } })
export class Content {
  @PrimaryGeneratedColumn()
  id!: number;
}

@ChildEntity()
export class Photo extends Content {
  @Column()
  size!: string;
}

export const LegacySchema = new EntitySchema({ name: "legacy", columns: { id: { type: Number, primary: true } } });
