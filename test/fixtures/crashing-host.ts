// Starts both kernels, prints their pids, then waits to be SIGKILLed by the test.
import { createHarness, js, py, textOf } from "../harness.ts";

const h = await createHarness();
const [pyCell, jsCell] = await h.run([py("import os\nos.getpid()"), js("process.pid")]);
process.stdout.write(`${textOf(pyCell)} ${textOf(jsCell)}\n`);
setInterval(() => {}, 1000);
