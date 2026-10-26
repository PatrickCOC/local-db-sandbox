import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from "@nestjs/common";
import { User } from "./user.entity";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@Body() body: { name: string; active?: boolean }): Promise<User> {
    return this.users.create(body);
  }

  @Post("batch")
  createMany(@Body() body: { names: string[] }): Promise<User[]> {
    return this.users.createMany(body.names);
  }

  @Get()
  findAll(): Promise<User[]> {
    return this.users.findAll();
  }

  @Get("search")
  search(@Query("name") name: string): Promise<User[]> {
    return this.users.search(name);
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
