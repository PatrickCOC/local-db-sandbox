// A process that serves the control of a runtime and does nothing else. It prints where, and has to end by
// itself: serving a runtime is no reason for a process to keep running. Used by the tests of the control.
import { startControlServer } from "../../src/index.ts";
import { open } from "./fixture.ts";

const { access } = await open();
const server = await startControlServer({ access });
console.log(server.url);
