import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "./user.entity.ts";

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  create(input: { name: string; active?: boolean }): Promise<User> {
    return this.users.save(this.users.create(input));
  }

  findAll(active?: boolean): Promise<User[]> {
    return this.users.find({ where: { active }, order: { id: "ASC" } });
  }

  async findOne(id: number): Promise<User> {
    const user = await this.users.findOneBy({ id });
    if (user === null) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async update(id: number, changes: { name?: string; active?: boolean }): Promise<User> {
    await this.users.update(id, changes);
    return this.findOne(id);
  }

  async remove(id: number): Promise<void> {
    const result = await this.users.delete(id);
    if (!result.affected) {
      throw new NotFoundException(`User ${id} not found`);
    }
  }
}
