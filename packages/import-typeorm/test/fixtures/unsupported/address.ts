import { Column } from "typeorm";

export class Address {
  @Column()
  city!: string;
}
