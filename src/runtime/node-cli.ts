// `node`'s command line.
//
// Parsed the way node parses it, so that what works in a terminal works here: options
// come before the script, everything after the script belongs to the script, `--` ends
// options, and `process.argv` has a script slot only when there is a script.
//
// Options this runtime cannot honour are still *recognized*. `node --watch app.js`
// deserves "--watch is not supported by this runtime", not "bad option" — the second
// reads like a typo and sends you looking in the wrong place.

/** Options that exist in node but need runtime support this does not have. */
const UNSUPPORTED: Record<string, string> = {
	"-c": "syntax-only checking needs a parse-without-execute path the runtime does not expose",
	"--check": "syntax-only checking needs a parse-without-execute path the runtime does not expose",
	"-i": "there is no REPL",
	"--interactive": "there is no REPL",
	"-r": "module preloading is not implemented",
	"--require": "module preloading is not implemented",
	"--watch": "file watching for restarts is not implemented",
	"--watch-path": "file watching for restarts is not implemented",
	"--inspect": "there is no inspector",
	"--inspect-brk": "there is no inspector",
	"--inspect-wait": "there is no inspector",
	"--prof": "there is no profiler",
	"--test": "the test runner is not implemented",
};

export type NodeInvocation =
	| { kind: "version" }
	| { kind: "help" }
	| {
			kind: "eval";
			code: string;
			/** `-p`: print the value the code evaluates to. */
			print: boolean;
			/** `--input-type=module`. Node defaults `--eval` to CommonJS. */
			module: boolean;
			/** Arguments after the options; `process.argv` gets no script slot. */
			args: string[];
	  }
	| { kind: "script"; path: string; args: string[] }
	| { kind: "error"; message: string };

/**
 * Parse the arguments that follow `node`.
 *
 * Returns an `error` invocation rather than throwing: a bad command line is ordinary
 * output on stderr and a non-zero status, not an exception.
 */
export function parseNodeArgv(argv: string[]): NodeInvocation {
	let evalCode: string | undefined;
	let print = false;
	let inputType: string | undefined;
	let i = 0;

	for (; i < argv.length; i++) {
		let arg = argv[i];

		if (arg === "--") {
			i++;
			break;
		}
		// A lone "-" is stdin, and anything not starting with "-" is the script.
		if (arg === "-" || !arg.startsWith("-")) break;

		// `--input-type=module`, and the general `--opt=value` form.
		let equals = arg.indexOf("=");
		let name = equals === -1 ? arg : arg.slice(0, equals);
		let inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);

		if (name in UNSUPPORTED) {
			return {
				kind: "error",
				message: `node: ${name} is not supported by this runtime — ${UNSUPPORTED[name]}`,
			};
		}

		let value = () => {
			if (inlineValue !== undefined) return inlineValue;
			return argv[++i];
		};

		switch (name) {
			case "-v":
			case "--version":
				return { kind: "version" };
			case "-h":
			case "--help":
				return { kind: "help" };
			case "-e":
			case "--eval": {
				let code = value();
				if (code === undefined) return { kind: "error", message: `node: ${name} requires an argument` };
				evalCode = code;
				continue;
			}
			case "-p":
			case "--print": {
				let code = value();
				if (code === undefined) return { kind: "error", message: `node: ${name} requires an argument` };
				evalCode = code;
				print = true;
				continue;
			}
			// Node accepts the two clustered, and it is how `-p` is usually typed.
			case "-pe":
			case "-ep": {
				let code = value();
				if (code === undefined) return { kind: "error", message: `node: ${name} requires an argument` };
				evalCode = code;
				print = true;
				continue;
			}
			case "--input-type": {
				let type = value();
				if (type === undefined) return { kind: "error", message: `node: ${name} requires an argument` };
				if (type !== "module" && type !== "commonjs") {
					return { kind: "error", message: `node: --input-type must be "module" or "commonjs"` };
				}
				inputType = type;
				continue;
			}
			default:
				// Node's own wording for an option it does not know.
				return { kind: "error", message: `node: bad option: ${name}` };
		}
	}

	let rest = argv.slice(i);

	if (evalCode !== undefined) {
		// Node ignores a script path once --eval is given; the remainder is argv.
		return {
			kind: "eval",
			code: evalCode,
			print,
			module: inputType === "module",
			args: rest,
		};
	}

	let script = rest[0];
	if (script === undefined) {
		return {
			kind: "error",
			message: "node: no script given, and there is no REPL — pass a file, or use node -e <code>",
		};
	}
	if (script === "-") {
		return { kind: "error", message: "node: reading a script from stdin is not supported" };
	}

	return { kind: "script", path: script, args: rest.slice(1) };
}

export const NODE_USAGE = [
	"Usage: node [options] [script.js] [arguments]",
	"       node [options] -e <code> [arguments]",
	"",
	"Options:",
	"  -v, --version           print the runtime's node version",
	"  -h, --help              print this message",
	"  -e, --eval <code>       evaluate <code> (CommonJS unless --input-type=module)",
	"  -p, --print <code>      evaluate <code> and print the result",
	"      --input-type=TYPE   'module' or 'commonjs', for -e and -p",
	"  --                      end of options; the next argument is the script",
];
