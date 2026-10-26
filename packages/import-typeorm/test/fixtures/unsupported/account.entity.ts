import {
  BeforeInsert, Column, Entity, Index, JoinColumn, JoinTable, ManyToMany, ManyToOne,
  PrimaryColumn, PrimaryGeneratedColumn, RelationId, VirtualColumn,
} from "typeorm";
import { Address } from "./address";
import { Outside } from "../outside/outside.entity";

@Entity()
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number;
}

@Entity()
export class Membership {
  @PrimaryColumn()
  accountId!: number;

  @PrimaryColumn()
  groupId!: number;
}

@Entity()
@Index(["nickname"])
export class Account {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", transformer: { to: (v: string) => v, from: (v: string) => v } })
  nickname!: string;

  @Column({ type: "geometry" })
  location!: unknown;

  @Column({ type: "bytea", select: false })
  secret!: unknown;

  @Column()
  misc!: string | number;

  @Column({ type: "enum", enum: () => ["a", "b"] } as never)
  dynamic!: string;

  @Column({ type: "int", array: true })
  scores!: number[];

  @Column({ type: "enum", enum: ["red", "blue"], array: true })
  colors!: string[];

  @Column(() => Address)
  address!: Address;

  @VirtualColumn({ query: (alias) => `SELECT 1 FROM x WHERE id = ${alias}.id` })
  total!: number;

  @ManyToMany(() => Tag)
  @JoinTable()
  tags!: Tag[];

  @ManyToOne(() => Membership)
  membership!: Membership;

  @ManyToOne(() => Outside)
  outside!: Outside;

  @ManyToOne(() => Tag)
  @JoinColumn({ referencedColumnName: "missing" })
  odd!: Tag;

  @RelationId((account: Account) => account.tags)
  tagIds!: number[];

  @BeforeInsert()
  normalize(): void {}
}
