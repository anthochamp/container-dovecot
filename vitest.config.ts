import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 60_000,
		isolate: true,
		fileParallelism: false,
		sequence: {
			concurrent: false,
		},
	},
});
