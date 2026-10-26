import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from "@nestjs/common";
import { User } from "./user.entity.ts";
import { UsersService } from "./users.service.ts";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@Body() body: { name: string; active?: boolean }): Promise<User> {
    return this.users.create(body);
  }

  @Get()
  findAll(): Promise<User[]> {
    return this.users.findAll();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number): Promise<User> {
    return this.users.findOne(id);
  }

  @Patch(":id")
  update(@Param("id", ParseIntPipe) id: number, @Body() body: { name?: string; active?: boolean }): Promise<User> {
    return this.users.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id", ParseIntPipe) id: number): Promise<void> {
    return this.users.remove(id);
  }
}
