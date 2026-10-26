// Stands in for compiled JavaScript output of a TypeORM entity.
const { Column, Entity, PrimaryGeneratedColumn } = require("typeorm");

class Thing {}
PrimaryGeneratedColumn()(Thing.prototype, "id");
Column({ type: "varchar" })(Thing.prototype, "label");
Entity("things")(Thing);

exports.Thing = Thing;
