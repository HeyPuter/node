import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { NodeWorker } from "node-worker";
import "@xterm/xterm/css/xterm.css";

// xterm rather than the mock's HTML transcript with an `<input>`: real programs need a
// real TTY. vite's dev server repaints, `tsc` colours its diagnostics, readline expects
// raw mode, and ctrl-C has to arrive as a byte. None of that survives being rendered as
// paragraphs.
//
// The cost is that the shell prompt has to be implemented — a terminal has no notion of
// one. Hence two modes: in **shell** mode this module owns the line, echoing keystrokes
// and interpreting editing keys; in **program** mode keystrokes go to the worker's stdin
// and it owns the screen.

/** The mock's shell pane colours, so the terminal sits in the card seamlessly. */
const THEME = {
	background: "#fafbfc",
	foreground: "#3b3d40",
	cursor: "#1d49e7",
	cursorAccent: "#fafbfc",
	selectionBackground: "#1d49e733",
	black: "#3b3d40",
	red: "#d73a49",
	green: "#16a34a",
	yellow: "#b45309",
	blue: "#1d49e7",
	magenta: "#a626a4",
	cyan: "#0b7285",
	white: "#6b7280",
	brightBlack: "#9aa1ad",
	brightRed: "#d73a49",
	brightGreen: "#16a34a",
	brightYellow: "#b45309",
	brightBlue: "#4f74ff",
	brightMagenta: "#a626a4",
	brightCyan: "#0b7285",
	brightWhite: "#111827",
};

const PROMPT = "\x1b[38;2;154;161;173m/project $\x1b[0m ";
const MAX_HISTORY = 200;

export interface TerminalController {
	/** Write a line of program-style output, translating newlines. */
	writeLine(line: string): void;
	write(text: string): void;
	clear(): void;
	/** Draw the prompt and start reading a command. */
	prompt(): void;
	/** Hand the keyboard to a running program's stdin. */
	attachConsole(workerConsole: NodeWorker["console"]): void;
	/** The terminal's current dimensions, for `process.stdout.columns`/`rows`. */
	readonly size: { columns: number; rows: number };
	/** Take it back, and stop forwarding the program's output. */
	detachConsole(): void;
	/** Rewrite a clicked URL before opening it — localhost becomes a preview URL. */
	setLinkHandler(handler: (uri: string) => string | undefined): void;
	/**
	 * Observe everything a program writes.
	 *
	 * A tap here rather than a second reader on the worker's streams, because a
	 * ReadableStream has exactly one: whoever wants to watch output has to watch what
	 * the terminal received.
	 */
	onOutput(listener: (text: string) => void): void;
	/**
	 * The whole buffer as plain text, scrollback included.
	 *
	 * Only the visible rows exist in the DOM, so this is the only way to read output
	 * that has scrolled — which matters for anything driving the shell from outside,
	 * and for reporting a failure that happened twenty lines ago.
	 */
	snapshot(): string;
	fit(): void;
	dispose(): void;
}

export interface TerminalHandlers {
	/** A command line was entered. The prompt stays hidden until `prompt()`. */
	onCommand: (line: string) => void;
	/** The terminal was resized, so a running program's `columns` is now stale. */
	onResize?: (size: { columns: number; rows: number }) => void;
	/**
	 * ctrl-C pressed twice while a program is running: the first press is delivered
	 * to it as a byte, and only a second one asks the host to stop it outright.
	 */
	onInterrupt: () => void;
}

export function mountTerminal(
	container: HTMLElement,
	handlers: TerminalHandlers
): TerminalController {
	let encoder = new TextEncoder();
	let terminal = new Terminal({
		fontSize: 12.5,
		fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
		lineHeight: 1.35,
		theme: THEME,
		cursorBlink: true,
		convertEol: false,
		scrollback: 5000,
	});

	let linkHandler: ((uri: string) => string | undefined) | undefined;

	let fit = new FitAddon();
	terminal.loadAddon(fit);
	// The mock linkified localhost URLs in program output with a regex over its own
	// HTML; this is the real version, and the rewrite to a preview URL is the caller's
	// through `setLinkHandler`.
	terminal.loadAddon(
		new WebLinksAddon((event, uri) => {
			event.preventDefault();
			window.open(linkHandler?.(uri) ?? uri, "_blank", "noreferrer");
		})
	);
	terminal.open(container);

	let resize = () => {
		try {
			fit.fit();
		} catch {
			// fit throws while the container is display:none (the splash is up).
		}
	};
	resize();
	requestAnimationFrame(resize);
	let observer = new ResizeObserver(resize);
	observer.observe(container);
	// xterm's own event, not the observer's: `fit` decides the cell grid, and the grid
	// is what a program's `columns` has to match.
	terminal.onResize(({ cols, rows }) => handlers.onResize?.({ columns: cols, rows }));

	// xterm has no ONLCR: a bare "\n" moves down without returning the carriage, so
	// program output (which uses "\n" line endings, like a real TTY) staircases.
	// Translate every newline to CRLF for display, acting as the terminal driver would.
	// ANSI colour sequences pass through untouched.
	const toCrlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

	// ------------------------------------------------------------- shell mode

	let mode: "shell" | "program" | "idle" = "idle";
	let line = "";
	let cursor = 0;
	let history: string[] = [];
	let historyAt = 0;
	/** What was being typed before the user started walking history. */
	let draft = "";

	let redraw = () => {
		// Rewrite the whole line: cheaper to reason about than tracking what changed,
		// and imperceptible at these lengths.
		terminal.write(`\r\x1b[K${PROMPT}${line}`);
		let back = line.length - cursor;
		if (back > 0) terminal.write(`\x1b[${back}D`);
	};

	let submit = () => {
		let entered = line;
		terminal.write("\r\n");
		line = "";
		cursor = 0;
		historyAt = history.length;
		mode = "idle";
		if (entered.trim()) {
			// Deduplicate only against the immediately previous entry, as shells do.
			if (history[history.length - 1] !== entered) history.push(entered);
			if (history.length > MAX_HISTORY) history.shift();
			historyAt = history.length;
		}
		handlers.onCommand(entered);
	};

	let recall = (delta: number) => {
		if (history.length === 0) return;
		if (historyAt === history.length) draft = line;
		let next = historyAt + delta;
		if (next < 0 || next > history.length) return;
		historyAt = next;
		line = next === history.length ? draft : history[next];
		cursor = line.length;
		redraw();
	};

	let onShellKey = (data: string) => {
		// Multi-byte pastes arrive as one chunk; handling them character-wise keeps
		// bracketed text from being mistaken for control input.
		for (let i = 0; i < data.length; i++) {
			let ch = data[i];

			if (ch === "\r" || ch === "\n") {
				submit();
				return;
			}
			if (ch === "\x7f" || ch === "\b") {
				if (cursor > 0) {
					line = line.slice(0, cursor - 1) + line.slice(cursor);
					cursor -= 1;
					redraw();
				}
				continue;
			}
			if (ch === "\x03") {
				// ctrl-C: abandon the line, as a shell does.
				terminal.write("^C\r\n");
				line = "";
				cursor = 0;
				historyAt = history.length;
				mode = "idle";
				handlers.onCommand("");
				return;
			}
			if (ch === "\x15") {
				line = line.slice(cursor);
				cursor = 0;
				redraw();
				continue;
			}
			if (ch === "\x01") {
				cursor = 0;
				redraw();
				continue;
			}
			if (ch === "\x05") {
				cursor = line.length;
				redraw();
				continue;
			}
			if (ch === "\x1b") {
				// CSI sequences for the arrow keys. Anything else is swallowed rather
				// than echoed as garbage.
				let seq = data.slice(i, i + 3);
				if (seq === "\x1b[A") recall(-1);
				else if (seq === "\x1b[B") recall(1);
				else if (seq === "\x1b[C") {
					if (cursor < line.length) {
						cursor += 1;
						redraw();
					}
				} else if (seq === "\x1b[D") {
					if (cursor > 0) {
						cursor -= 1;
						redraw();
					}
				}
				i += seq.length - 1;
				continue;
			}
			// Printable only: a stray control byte would corrupt the redraw.
			if (ch >= " ") {
				line = line.slice(0, cursor) + ch + line.slice(cursor);
				cursor += 1;
				redraw();
			}
		}
	};

	// ----------------------------------------------------------- program mode

	let toStdin: ((data: string) => void) | undefined;
	let detach = () => {};
	/** ctrl-C presses during the current run, for the escalation below. */
	let interrupts = 0;
	let outputListeners: ((text: string) => void)[] = [];

	/** Render program output, and let anyone watching see the same bytes. */
	let emit = (text: string) => {
		terminal.write(toCrlf(text));
		for (let listener of outputListeners) listener(text);
	};

	let onData = (data: string) => {
		if (mode === "shell") {
			onShellKey(data);
			return;
		}
		if (mode !== "program") return;

		if (data === "\x03") {
			interrupts += 1;
			// The first press is the program's to handle — that is what ctrl-C means, and
			// a well-behaved CLI cleans up and exits. Only once it has visibly ignored
			// one does the host kill it, because killing loses whatever it was doing.
			if (interrupts === 1 && toStdin) {
				toStdin(data);
				terminal.write("\r\n\x1b[38;2;154;161;173m^C — press again to stop\x1b[0m\r\n");
				return;
			}
			handlers.onInterrupt();
			return;
		}

		toStdin?.(data);
	};

	terminal.onData(onData);

	const attachConsole = (workerConsole: NodeWorker["console"]) => {
		detach();

		let closed = false;
		let stdin = workerConsole.stdin.getWriter();
		let inputTail = Promise.resolve();
		let readers: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>[] = [];

		toStdin = (data: string) => {
			if (closed) return;
			inputTail = inputTail
				.then(async () => {
					await stdin.ready;
					await stdin.write(encoder.encode(data));
				})
				.catch(() => {
					// The worker is gone (it exited, or was stopped). Its stdin going
					// away is the expected end of a run, not an error to report.
				});
		};

		const pipe = (stream: ReadableStream<Uint8Array<ArrayBuffer>>) => {
			let reader = stream.getReader();
			readers.push(reader);
			let decoder = new TextDecoder();

			void (async () => {
				try {
					while (!closed) {
						let { value, done } = await reader.read();
						if (done) break;
						if (value) emit(decoder.decode(value, { stream: true }));
					}
					let trailing = decoder.decode();
					if (!closed && trailing) emit(trailing);
				} catch {
					// Same: a terminated worker tears its streams down mid-read.
				} finally {
					reader.releaseLock();
				}
			})();
		};

		pipe(workerConsole.stdout);
		pipe(workerConsole.stderr);

		mode = "program";
		interrupts = 0;

		detach = () => {
			if (closed) return;
			closed = true;
			toStdin = undefined;
			for (let reader of readers) void reader.cancel().catch(() => {});
			void inputTail.finally(() => {
				try {
					stdin.releaseLock();
				} catch {
					// Already released by the stream shutting down.
				}
			});
			detach = () => {};
		};
	};

	return {
		get size() {
			return { columns: terminal.cols, rows: terminal.rows };
		},

		writeLine(text: string) {
			terminal.write(toCrlf(text) + "\r\n");
		},

		write(text: string) {
			terminal.write(toCrlf(text));
		},

		clear() {
			// 2J the screen, 3J the scrollback, H home the cursor. xterm's own `clear()`
			// keeps the current line, which in shell mode is the prompt about to be
			// redrawn — and neither it nor 2J alone touches the scrollback, so without 3J
			// everything above the fold survives a "Clear".
			terminal.write("\x1b[2J\x1b[3J\x1b[H");
			if (mode === "shell") redraw();
		},

		prompt() {
			mode = "shell";
			line = "";
			cursor = 0;
			historyAt = history.length;
			terminal.write(`\r\n${PROMPT}`);
			terminal.focus();
		},

		attachConsole,

		detachConsole() {
			detach();
			mode = "idle";
		},

		setLinkHandler(handler) {
			linkHandler = handler;
		},

		onOutput(listener) {
			outputListeners.push(listener);
		},

		snapshot() {
			let buffer = terminal.buffer.active;
			let lines: string[] = [];
			for (let y = 0; y < buffer.length; y++) {
				lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
			}
			// Trailing blanks are the unwritten remainder of the viewport, not output.
			while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
			return lines.join("\n");
		},

		fit: resize,

		dispose() {
			detach();
			observer.disconnect();
			terminal.dispose();
		},
	};
}
