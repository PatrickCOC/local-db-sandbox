import { Column, Entity, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn } from "typeorm";
import { Category } from "./category.entity";
import { User } from "./user.entity";

@Entity()
export class Post {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  title!: string;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  price!: string | null;

  @Column({ type: "simple-array", default: "" })
  keywords!: string[];

  @ManyToOne(() => User, (user) => user.posts, { nullable: false })
  author!: User;

  @Column({ nullable: true })
  categoryCode!: string;

  @ManyToOne(() => Category)
  @JoinColumn({ name: "categoryCode" })
  category!: Category;

  @OneToOne(() => Post)
  @JoinColumn({ name: "previous_id" })
  previous!: Post | null;
}
