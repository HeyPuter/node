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
