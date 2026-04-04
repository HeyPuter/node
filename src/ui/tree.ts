// The file tree.
//
// Renders synchronously out of the mirror, with no worker round trip, which is why it
// stays responsive while a program is running and why it can be re-rendered wholesale
// on every change instead of being patched.
//
// Only expanded directories are walked, so having a `node_modules` in the project costs
// nothing until someone opens it.

import type { ProjectMirror } from "../project/mirror";

const COLLAPSED_BY_DEFAULT = ["node_modules"];

export interface TreeController {
	render(): void;
	/** Reveal a path's ancestors, so a newly-opened file is visible. */
	reveal(path: string): void;
	setActive(path: string | undefined): void;
	dispose(): void;
}

export function mountTree(
	host: HTMLElement,
	mirror: ProjectMirror,
	onOpenFile: (path: string) => void
): TreeController {
	let expanded = new Set<string>([""]);
	let active: string | undefined;
	let seededCollapse = false;

	let esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

	/**
	 * Expand everything at the top level except the directories that are noise —
	 * done once the mirror first has content rather than up front, since an empty
	 * mirror has nothing to decide about.
	 */
	let seedCollapse = () => {
		if (seededCollapse || mirror.fileCount === 0) return;
		seededCollapse = true;
		for (let entry of mirror.list("")) {
			if (entry.kind === "dir" && !COLLAPSED_BY_DEFAULT.includes(entry.name)) {
				expanded.add(entry.path);
			}
		}
	};

	let rowsFor = (dir: string, depth: number, out: string[]) => {
		for (let entry of mirror.list(dir)) {
			let isDir = entry.kind === "dir";
			let isOpen = isDir && expanded.has(entry.path);
			let classes = ["row"];
			if (entry.path === active) classes.push("active");
			// node_modules is dimmed for the same reason it starts closed: it is the
			// project's furniture, not its content.
			if (entry.name === "node_modules") classes.push("muted");

			let chevron = isDir
				? `<span class="chev${isOpen ? "" : " closed"}">&#9662;</span>`
				: `<span class="chev"></span>`;
			let badge =
				entry.name === "node_modules"
					? `<span class="badge">${mirror.packageCount()}</span>`
					: "";

			out.push(
				`<div class="${classes.join(" ")}" style="--depth:${depth}"` +
					` data-path="${esc(entry.path)}" data-kind="${entry.kind}">` +
					`${chevron}<span class="name">${esc(entry.name)}</span>${badge}</div>`
			);

			if (isOpen) rowsFor(entry.path, depth + 1, out);
		}
	};

	let render = () => {
		seedCollapse();
		let rows: string[] = [
			`<div class="row" style="--depth:0" data-path="" data-kind="dir">` +
				`<span class="chev${expanded.has("") ? "" : " closed"}">&#9662;</span>` +
				`<span class="name">/project</span></div>`,
		];
		if (expanded.has("")) rowsFor("", 1, rows);
		host.innerHTML = rows.join("");
	};

	let onClick = (event: MouseEvent) => {
		let row = (event.target as HTMLElement).closest<HTMLElement>(".row");
		if (!row || !host.contains(row)) return;
		let path = row.dataset.path ?? "";
		if (row.dataset.kind === "dir") {
			if (expanded.has(path)) expanded.delete(path);
			else expanded.add(path);
			render();
			return;
		}
		onOpenFile(path);
	};

	host.addEventListener("click", onClick);
	let detachMirror = mirror.onChange(render);
	render();

	return {
		render,
		reveal(path) {
			let parts = path.split("/");
			let at = "";
			// Every ancestor but the file itself.
			for (let i = 0; i < parts.length - 1; i++) {
				at = at === "" ? parts[i] : `${at}/${parts[i]}`;
				expanded.add(at);
			}
			expanded.add("");
			render();
		},
		setActive(path) {
			active = path;
			render();
		},
		dispose() {
			host.removeEventListener("click", onClick);
			detachMirror();
		},
	};
}
