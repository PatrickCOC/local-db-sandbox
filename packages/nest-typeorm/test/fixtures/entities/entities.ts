import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
  ViewEntity,
} from "typeorm";

@Entity("authors")
export class Author {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column({ type: "int", default: 0 })
  score!: number;

  @Column({ type: "text", nullable: true })
  bio!: string | null;

  @Column({ type: "timestamp", nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @VersionColumn()
  version!: number;
}

/** Primary key that is neither generated nor named `id`. */
@Entity()
export class Country {
  @PrimaryColumn()
  code!: string;

  @Column()
  name!: string;
}

/** Generated primary key that is not named `id`. */
@Entity("tokens")
export class Token {
  @PrimaryGeneratedColumn("uuid")
  uuid!: string;

  @Column()
  label!: string;
}

@Entity()
export class Ticket {
  @PrimaryGeneratedColumn()
  number!: number;

  @Column()
  title!: string;

  @ManyToOne(() => Author)
  author!: Author;

  @Column({ nullable: true })
  authorId!: number | null;
}

@Entity()
export class Membership {
  @PrimaryColumn()
  accountId!: number;

  @PrimaryColumn()
  groupId!: number;
}

/** Read with hand-written PostgreSQL-style SQL (`WHERE "uar"."userId" = $1`) by the application of a regression. */
@Entity()
export class UserAbilityRule {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int", nullable: true })
  userId!: number | null;

  @Column({ type: "varchar", length: 50, nullable: true })
  action!: string | null;

  @Column({ type: "varchar", length: 50, nullable: true })
  subject!: string | null;
}

@ViewEntity({ expression: "SELECT 1" })
export class Summary {
  @Column()
  total!: number;
}

export class NotAnEntity {}
