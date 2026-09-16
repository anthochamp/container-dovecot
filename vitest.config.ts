import { defineProject } from "@ac-kit/vitest-config";

export default defineProject({
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
