import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CategoriesModule } from "./categories/categories.module";
import { databaseOptions } from "./database.config";
import { InfoController } from "./info.controller";
import { MailController } from "./mail.controller";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [TypeOrmModule.forRootAsync({ useFactory: databaseOptions }), UsersModule, CategoriesModule],
  controllers: [InfoController, MailController],
})
export class AppModule {}
