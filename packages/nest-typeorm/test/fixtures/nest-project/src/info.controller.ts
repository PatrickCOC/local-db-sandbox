import { Controller, Get } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

@Controller("info")
export class InfoController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  info(): { database: string } {
    return { database: this.dataSource.options.type };
  }
}
