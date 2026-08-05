import { defineConfig } from "vite";

// output file names must be all lowercase: the name part is inlined into the
// pattern lowercased, and base36 hashes are lowercase alphanumeric only
const lowercase = (name: string) => name.toLowerCase().replaceAll(/[[\]]/g, "_");

const lowercaseNames = {
	hashCharacters: "base36",
	entryFileNames: (chunk: { name: string }) => `assets/${lowercase(chunk.name)}-[hash].js`,
	chunkFileNames: (chunk: { name: string }) => `assets/${lowercase(chunk.name)}-[hash].js`,
	assetFileNames: (asset: { names: string[] }) => {
		const name = asset.names[0] ?? "asset";
		const dot = name.lastIndexOf(".");
		return `assets/${lowercase(dot > 0 ? name.slice(0, dot) : name)}-[hash][extname]`;
	},
} as const;

export default defineConfig({
	// Relative, so one build runs from any path: `/`, `/labs/node/`, a file:// tree. Vite emits
	// asset URLs computed from `import.meta.url` instead of rooted at `/`, which is what lets the
	// same dist be deployed twice at different depths. Anything the app fetches by hand has to go
	// through `appUrl` (src/base.ts) to get the same treatment.
	//
	// This requires the page be served at a directory URL with a trailing slash (`/labs/node/`, not
	// `/labs/node`) — relative URLs resolve against the *document*, so a missing slash drops a
	// segment. Dev is unaffected: Vite forces base to `/` when serving.
	base: "./",
	build: {
		chunkSizeWarningLimit: Infinity,
		rolldownOptions: {
			checks: {
				pluginTimings: false,
			},
			output: {
				...lowercaseNames,
				manualChunks: (id) => {
					if (id.includes("monaco-editor")) {
						return "monaco";
					}
					// A single prebuilt bundle with every command in it — npm ships no sources, so
					// there is nothing to tree-shake. Its own chunk, so it is cached on its own.
					if (id.includes("just-bash")) {
						return "just-bash";
					}
				},
			},
		},
	},
	worker: {
		rolldownOptions: {
			output: lowercaseNames,
		},
	},
})
