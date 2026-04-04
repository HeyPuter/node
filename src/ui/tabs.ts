// The editor's tab strip.
//
// Owns which files are open and which one is showing; the editor owns their contents.
// Splitting it that way keeps the strip a pure function of a path list.

export interface TabsController {
	open(path: string): void;
	close(path: string): void;
	readonly active: string | undefined;
	readonly paths: readonly string[];
	/** Mark a tab as having unsaved edits (the mock's dot). */
	setDirty(path: string, dirty: boolean): void;
	dispose(): void;
}

export interface TabsHandlers {
	onSelect: (path: string) => void;
	onClose: (path: string) => void;
}

export function mountTabs(host: HTMLElement, handlers: TabsHandlers): TabsController {
	let paths: string[] = [];
	let active: string | undefined;
	let dirty = new Set<string>();

	let esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

	let render = () => {
		host.innerHTML = paths
			.map((path) => {
				let name = path.split("/").pop() ?? path;
				let classes = ["tab"];
				if (path === active) classes.push("active");
				if (dirty.has(path)) classes.push("dirty");
				return (
					`<button class="${classes.join(" ")}" type="button" data-path="${esc(path)}"` +
					` title="${esc(path)}"><span class="dot"></span>${esc(name)}` +
					`<span class="x" data-close="${esc(path)}">&times;</span></button>`
				);
			})
			.join("");
	};

	let onClick = (event: MouseEvent) => {
		let target = event.target as HTMLElement;
		let closing = target.dataset.close;
		if (closing !== undefined) {
			// Stop the click from also selecting the tab it just removed.
			event.stopPropagation();
			handlers.onClose(closing);
			return;
		}
		let tab = target.closest<HTMLElement>(".tab");
		if (tab?.dataset.path) handlers.onSelect(tab.dataset.path);
	};

	host.addEventListener("click", onClick);

	return {
		get active() {
			return active;
		},
		get paths() {
			return paths;
		},

		open(path) {
			if (!paths.includes(path)) paths.push(path);
			active = path;
			render();
		},

		close(path) {
			let at = paths.indexOf(path);
			if (at === -1) return;
			paths.splice(at, 1);
			dirty.delete(path);
			if (active === path) {
				// Prefer the tab that took its place, then the one before it — the same
				// thing every editor does, and it keeps focus near where the user was.
				active = paths[at] ?? paths[at - 1];
			}
			render();
		},

		setDirty(path, isDirty) {
			let had = dirty.has(path);
			if (isDirty === had) return;
			if (isDirty) dirty.add(path);
			else dirty.delete(path);
			render();
		},

		dispose() {
			host.removeEventListener("click", onClick);
		},
	};
}
