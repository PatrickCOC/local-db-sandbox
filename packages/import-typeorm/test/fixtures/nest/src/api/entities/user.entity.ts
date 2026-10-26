import { Column, Entity } from "typeorm";
import { BaseRecord } from "@shared/base";
import { UserRole } from "src/api/constants/user-role.constants";

@Entity("users")
export class User extends BaseRecord {
  @Column({ type: "enum", enum: UserRole, default: UserRole.Member })
  role!: UserRole;
}
