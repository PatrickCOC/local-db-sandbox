import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "post_categories" })
export class Category {
  @PrimaryColumn({ type: "varchar", length: 20 })
  code!: string;

  @Column()
  label!: string;
}
