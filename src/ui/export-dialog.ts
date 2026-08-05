// What to do with an export once it lands.
//
// Export is the one action whose result is not visible anywhere on this page: the project
// it copies lives on Drive, and this workspace runs `/project` out of local storage. What
// makes the copy useful is the terminal integration in `main.ts` — the Puter Terminal
// launches this app by name and hands it a command line, against the directory it was
// launched from — so the dialog is the steps that join the two: open the Terminal, cd to
// the export, and run it there. Plus the one thing the desktop does not hand you: a server
// the project starts is a peer server, not a public address, so the step for reaching it
// is the desktop's Browser app rather than a URL to paste anywhere.
//
// Shown only after an export succeeds, since instructions for a project that is not there
// would be worse than nothing.
//
// A native modal `<dialog>` rather than an overlay of our own, because the workspace it
// covers holds the keyboard: xterm consumes Escape as terminal input, so an overlay
// listening for it never hears one while the shell has focus. `showModal` makes the rest of
// the page inert, which hands Escape, focus containment and focus restoration to the
// browser instead of leaving them to fight over.

import { TERMINAL_APP, type ShellElements } from "./shell";

export interface ExportDialogController {
	/**
	 * Show the steps for a finished export.
	 *
	 * `startCommand` is the template's own start line — `npm run dev`, say — so the last
	 * step is what the Run button here runs rather than a guess at what the project wants.
	 * Shown prefixed with the app name, which is how the Terminal reaches this runtime.
	 */
	show(destination: string, startCommand: string): void;
	close(): void;
}

const COPY_IDLE = "Copy commands";
const COPY_DONE = "Copied";
const COPY_FAILED = "Click a line to select";

/** How long the copy button stays in its confirmed state before going back. */
const COPY_FEEDBACK_MS = 1400;

export function mountExportDialog(el: ShellElements): ExportDialogController {
	/** The lines the copy button hands over, in the order the steps list them. */
	let commands: string[] = [];
	let copyTimer: number | undefined;

	let resetCopy = () => {
		if (copyTimer !== undefined) clearTimeout(copyTimer);
		copyTimer = undefined;
		el.exportDialogCopy.textContent = COPY_IDLE;
	};

	let close = () => {
		if (el.exportDialog.open) el.exportDialog.close();
	};

	let copy = async () => {
		let text = commands.join("\n") + "\n";
		if (copyTimer !== undefined) clearTimeout(copyTimer);
		try {
			await navigator.clipboard.writeText(text);
			el.exportDialogCopy.textContent = COPY_DONE;
		} catch {
			// Clipboard writes need a permission this page may not have been granted. Each
			// command block selects whole on a click (`user-select: all`), so point at that
			// rather than leaving the button looking broken.
			el.exportDialogCopy.textContent = COPY_FAILED;
		}
		copyTimer = setTimeout(resetCopy, COPY_FEEDBACK_MS) as unknown as number;
	};

	let onBackdropClick = (event: MouseEvent) => {
		// The `<dialog>` element is the full-viewport backdrop and the panel is a child of
		// it, so a click that lands on the element itself is a click outside the panel.
		if (event.target === el.exportDialog) close();
	};

	el.exportDialogClose.addEventListener("click", close);
	el.exportDialogDone.addEventListener("click", close);
	el.exportDialogCopy.addEventListener("click", () => void copy());
	el.exportDialog.addEventListener("click", onBackdropClick);
	// Fires for every way out, Escape included, so the copy button is never found mid-
	// feedback the next time an export finishes.
	el.exportDialog.addEventListener("close", resetCopy);

	return {
		show(destination, startCommand) {
			commands = [`cd ${quotePath(destination)}`, `${TERMINAL_APP} ${startCommand}`];
			el.exportDialogPath.textContent = destination;
			el.exportDialogCd.textContent = commands[0];
			el.exportDialogStart.textContent = commands[1];
			resetCopy();
			// Focus lands on Done, which carries `autofocus`: closing is what most people
			// want after reading, and it is where Escape leaves off anyway.
			if (!el.exportDialog.open) el.exportDialog.showModal();
		},

		close,
	};
}

/**
 * A Drive path as it has to be typed at the Puter Terminal.
 *
 * The Terminal is a real shell, so a path with a space in it is two arguments unless it is
 * quoted — and the destination is `<home>/Documents/…`, which is only space-free because
 * of how `prepareExport` builds it today. Quoted the way `command.ts` quotes an argument,
 * for the same reason: the escaping a Drive path might need is not worth the guesswork.
 */
function quotePath(path: string): string {
	return /[\s"'\\$`]/.test(path) ? `'${path.replace(/'/g, "")}'` : path;
}
