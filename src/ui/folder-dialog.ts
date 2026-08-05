// The two questions worth stopping to ask about a folder on someone's machine.
//
//   **Opening one.** A template lives in storage this app created and nothing else can see. A
//   picked directory is somebody's actual work, and the runtime mounted on it can create, rewrite
//   and delete files in it for real — that is the entire point of the feature, and precisely why
//   it should be said once, in plain words, before the first time rather than discovered after.
//
//   **Scaffolding into an empty one.** Writing several thousand files into a directory is not
//   something to do because it happened to be empty when it was picked. It is a good default —
//   an empty folder is the "start a new project here" case — but it is a default worth confirming.
//
// A native modal `<dialog>` for the same reason the export dialog is one: the workspace it covers
// holds the keyboard, xterm consumes Escape as terminal input, and `showModal` hands Escape, focus
// containment and focus restoration to the browser rather than leaving them to fight over.
//
// One dialog element serving both questions, because they are the same shape — a title, a
// paragraph, some bullets and two buttons — and two nearly identical blocks of markup in
// `shell.ts` would be the only thing separating them.

import type { TemplateInfo } from "../project/template";
import type { ShellElements } from "./shell";

export interface FolderDialogController {
	/** Say what opening a real directory means. Resolves false if they think better of it. */
	confirmOpen(name: string): Promise<boolean>;
	/** Offer to unpack `info` into the empty folder `name`. */
	confirmScaffold(name: string, info: TemplateInfo): Promise<boolean>;
	close(): void;
}

interface Ask {
	kicker: string;
	title: string;
	copy: string;
	points: string[];
	confirm: string;
}

export function mountFolderDialog(el: ShellElements): FolderDialogController {
	/**
	 * Resolve for whatever is on screen, if anything.
	 *
	 * Held here rather than closed over per-`ask` so the listeners below — registered once, for
	 * the life of the page — can answer whichever question is actually open.
	 */
	let settle: ((ok: boolean) => void) | undefined;

	let finish = (ok: boolean) => {
		let resolve = settle;
		settle = undefined;
		if (el.folderDialog.open) el.folderDialog.close();
		resolve?.(ok);
	};

	el.folderDialogConfirm.addEventListener("click", () => finish(true));
	el.folderDialogCancel.addEventListener("click", () => finish(false));
	el.folderDialogClose.addEventListener("click", () => finish(false));
	el.folderDialog.addEventListener("click", (event) => {
		// The `<dialog>` element is the full-viewport backdrop and the panel is a child of it,
		// so a click that lands on the element itself is a click outside the panel.
		if (event.target === el.folderDialog) finish(false);
	});
	// Escape closes without any of the above firing, and an unanswered promise would leave boot
	// waiting forever. Declining is the only safe reading of "went away".
	//
	// `cancel` rather than `close`, which would be the obvious choice and is wrong. `close` is
	// dispatched as a *queued task*, so one left over from a question already answered can land
	// after the next `showModal` — closing that dialog and resolving it false, with nothing on
	// screen to explain why. `cancel` is dispatched synchronously as part of the Escape, so
	// there is no window for it to arrive late, and it does not fire for the `close()` inside
	// `finish` above — which has already resolved anyway.
	el.folderDialog.addEventListener("cancel", () => finish(false));

	let ask = (spec: Ask): Promise<boolean> => {
		// A second question while one is open would strand the first. Nothing does this today —
		// the two callers are on different branches of boot — so refusing is honest.
		if (settle) return Promise.resolve(false);

		el.folderDialogKicker.textContent = spec.kicker;
		el.folderDialogTitle.textContent = spec.title;
		el.folderDialogCopy.textContent = spec.copy;
		el.folderDialogConfirm.textContent = spec.confirm;
		el.folderDialogPoints.replaceChildren(
			...spec.points.map((text) => {
				let li = document.createElement("li");
				let span = document.createElement("span");
				span.className = "step-text";
				span.textContent = text;
				li.append(span);
				return li;
			})
		);

		return new Promise<boolean>((resolve) => {
			settle = resolve;
			el.folderDialog.showModal();
		});
	};

	return {
		confirmOpen(name) {
			return ask({
				kicker: "Open folder",
				title: `Open “${name}” as your project?`,
				copy: "The workspace mounts this folder directly, so what happens here happens to the real files on your machine.",
				points: [
					"Saving in the editor writes the file on disk. So does anything a program you run writes — and anything it deletes is deleted.",
					"Every file is read into memory so the tree and the editor can use them. A .git directory is skipped, since nothing here reads one.",
					"Permission lasts until you reload. After that the workspace asks for it again with one click.",
				],
				confirm: "Open folder",
			});
		},

		confirmScaffold(name, info) {
			return ask({
				kicker: "Empty folder",
				title: `“${name}” is empty`,
				copy: `Unpack the ${info.label} template into it? This writes ${info.files.toLocaleString()} files, including its ${info.packages} packages of node_modules.`,
				points: [
					"The files land in the folder you picked, so they are yours afterwards — this is how you start a new project on your own disk.",
					"Skip this to open the folder empty instead, and set it up yourself from the shell.",
				],
				confirm: "Unpack template",
			});
		},

		close: () => finish(false),
	};
}
