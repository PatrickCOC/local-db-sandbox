import { Column, Entity, OneToMany } from "typeorm";
import { BaseRecord } from "./base";
import { Post } from "./post.entity";

export enum UserRole {
  Admin = "admin",
  Editor = "editor",
  Reader = "reader",
}

export enum Tier {
  Free,
  Paid,
}

@Entity("users")
export class User extends BaseRecord {
  @Column()
  name!: string;

  @Column({ type: "varchar", length: 200, unique: true })
  email!: string;

  @Column({ type: "text", nullable: true })
  bio!: string | null;

  @Column({ default: true })
  active!: boolean;

  @Column({ type: "int", default: 0 })
  loginCount!: number;

  @Column({ type: "enum", enum: UserRole, default: UserRole.Reader })
  role!: UserRole;

  @Column({ type: "enum", enum: Tier, default: Tier.Free })
  tier!: Tier;

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  lastSeenAt!: Date;

  @Column({ type: "jsonb", default: { theme: "light" } })
  settings!: Record<string, unknown>;

  @OneToMany(() => Post, (post) => post.author)
  posts!: Post[];
}
