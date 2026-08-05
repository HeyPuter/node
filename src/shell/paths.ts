// Absolute paths, the way just-bash resolves them.
//
// Copied rather than derived: the shell and its filesystem have to agree with the interpreter
// about what `../a/./b` means, and the interpreter's answer is this exact algorithm — `..` pops a
// segment and bottoms out at the root, which is also what keeps `/project/../../etc` from
// escaping. The mirror's own `normalizeProjectPath` looks similar but answers a different
// question (project-relative, no leading slash), and using it here would quietly turn
// `/project/../tmp/x` into `/project/tmp/x`.

import { PROJECT_ROOT } from "../project/mirror";

/** Collapse `.`, `..` and duplicate slashes; always absolute, never trailing-slashed. */
export function normalizePath(path: string): string {
	if (!path || path === "/") return "/";
	let trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
	if (!trimmed.startsWith("/")) trimmed = `/${trimmed}`;
	let out: string[] = [];
	for (let segment of trimmed.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			out.pop();
			continue;
		}
		out.push(segment);
	}
	return out.length === 0 ? "/" : `/${out.join("/")}`;
}

/** Resolve `path` against `base`, as the interpreter does before calling the filesystem. */
export function resolveAgainst(base: string, path: string): string {
	if (path.startsWith("/")) return normalizePath(path);
	return normalizePath(base === "/" ? `/${path}` : `${base}/${path}`);
}

/**
 * An absolute path as a project-relative one — `""` for the project root itself — or undefined
 * if it is not in the project at all.
 *
 * The `..` in a path is resolved before this decides, so `node ../../etc/passwd` is refused
 * rather than clamped into the project.
 */
export function toProjectRelative(path: string): string | undefined {
	let absolute = normalizePath(path);
	if (absolute === PROJECT_ROOT) return "";
	if (absolute.startsWith(`${PROJECT_ROOT}/`)) return absolute.slice(PROJECT_ROOT.length + 1);
	return undefined;
}

/** The absolute path of a project-relative one. */
export function fromProjectRelative(relative: string): string {
	return relative === "" ? PROJECT_ROOT : `${PROJECT_ROOT}/${relative}`;
}

export function parentOf(path: string): string {
	let absolute = normalizePath(path);
	if (absolute === "/") return "/";
	let cut = absolute.lastIndexOf("/");
	return cut === 0 ? "/" : absolute.slice(0, cut);
}

export function baseNameOf(path: string): string {
	let absolute = normalizePath(path);
	return absolute.slice(absolute.lastIndexOf("/") + 1);
}
