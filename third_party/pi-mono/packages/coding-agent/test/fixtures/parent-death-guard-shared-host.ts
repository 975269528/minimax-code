import { createLocalBashOperations } from "../../src/core/tools/bash.ts";

const firstMarker = process.argv[2];
const secondMarker = process.argv[3];
if (!firstMarker || !secondMarker) throw new Error("two marker file arguments are required");

const operations = createLocalBashOperations({ parentDeathGuard: true });
const run = (marker: string) =>
	operations.exec(`echo $$ > "${marker}"; while true; do sleep 0.1; done`, process.cwd(), {
		onData: () => undefined,
	});

await Promise.all([run(firstMarker), run(secondMarker)]);
