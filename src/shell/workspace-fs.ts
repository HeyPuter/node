// The project, as a filesystem the shell can read and write.
//
// just-bash takes an `IFileSystem`, so the whole question is which files the shell sees. Pointing
// it at its own in-memory tree would give a shell over nothing; pointing it at a second view of
// the project would give two answers to "what is in src/". So this is one adapter over
// `ProjectMirror` — the same read model the tree and the editor render from — and every write goes
// back through the mirror, which persists it the way an editor save is persisted: through the
// running worker's filesystem, so `fs.watch` fires and a dev server rebuilds.
//
// That is also why the mirror is the right backing and OPFS is not. The interface is async, but
// the *tree walks* underneath it are not: `readdirWithFileTypes` is one synchronous map lookup
// here, and it is what globs, `find`, `ls -R` and `grep -r` all run on. Against OPFS each of those
// would be a handle open per entry.
//
// Paths outside `/project` are handed to an `InMemoryFs` this owns, which is what makes `/tmp`,
// `~`, `> /dev/null` and even symlinks work without any of it touching the project.
//
// One deliberate omission: no `writeFileSync`/`mkdirSync`. just-bash duck-types those to decide
// whether to write `/bin/<cmd>` stub files and create `/usr/bin`, and its command resolver falls
// back to the command *registry* only while `/usr/bin` does not exist. Custom commands (`node`,
// `npm`, every node_modules binary) live only in that registry, so growing a synchronous writer
// here would make them all stop resolving. See `interpreter/command-resolution.ts` in just-bash.

import { InMemoryFs } from "just-bash/browser";
import type { BufferEncoding, FileContent, FsStat, IFileSystem } from "just-bash/browser";

import { PROJECT_ROOT, type ProjectMirror } from "../project/mirror";
import { normalizePath, parentOf, resolveAgainst, toProjectRelative } from "./paths";

/** Not exported by `just-bash/browser`, and structural anyway. */
interface DirentEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}
interface ReadFileOptions {
	encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
	encoding?: BufferEncoding;
}
interface MkdirOptions {
	recursive?: boolean;
}
interface RmOptions {
	recursive?: boolean;
	force?: boolean;
}
interface CpOptions {
	recursive?: boolean;
}

const FILE_MODE = 0o644;
const EXEC_MODE = 0o755;
const DIR_MODE = 0o755;

/**
 * The error shapes just-bash's own filesystem throws.
 *
 * Commands read the *message* rather than a `code` property — `ls` turns "ENOENT: no such file or
 * directory" into "ls: x: No such file or directory" — so these have to match its wording, not
 * node's, and not each other's.
 */
function fsError(message: string): Error {
	return new Error(message);
}
const enoent = (op: string, path: string) =>
	fsError(`ENOENT: no such file or directory, ${op} '${path}'`);
const eisdir = (op: string, path: string) =>
	fsError(`EISDIR: illegal operation on a directory, ${op} '${path}'`);
const enotdir = (path: string) => fsError(`ENOTDIR: not a directory, scandir '${path}'`);

function assertNoNullByte(path: string, op: string): void {
	if (path.includes("\0")) {
		throw fsError(`ENOENT: path contains null byte, ${op} '${path}'`);
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodingOf(
	options?: ReadFileOptions | WriteFileOptions | BufferEncoding
): BufferEncoding | undefined {
	if (options == null) return undefined;
	if (typeof options === "string") return options;
	return options.encoding ?? undefined;
}

/** Bytes as text, honouring the encodings `IFileSystem` promises. */
function decodeBytes(bytes: Uint8Array, encoding?: BufferEncoding): string {
	if (encoding === "base64") {
		let latin1 = "";
		for (let i = 0; i < bytes.length; i += 0x8000) {
			latin1 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}
		return btoa(latin1);
	}
	if (encoding === "hex") {
		return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	}
	if (encoding === "binary" || encoding === "latin1") {
		// One char per byte, which is what the pipeline means by "bytes".
		let out = "";
		for (let i = 0; i < bytes.length; i += 0x8000) {
			out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}
		return out;
	}
	return decoder.decode(bytes);
}

/** The inverse, and the reason a binary redirect survives a round trip. */
function encodeContent(content: FileContent, encoding?: BufferEncoding): Uint8Array {
	if (content instanceof Uint8Array) return content;
	if (encoding === "base64") return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
	if (encoding === "hex") {
		let out = new Uint8Array(Math.floor(content.length / 2));
		for (let i = 0; i + 1 < content.length; i += 2) {
			out[i / 2] = parseInt(content.slice(i, i + 2), 16);
		}
		return out;
	}
	if (encoding === "binary" || encoding === "latin1") {
		let out = new Uint8Array(content.length);
		for (let i = 0; i < content.length; i++) out[i] = content.charCodeAt(i) & 0xff;
		return out;
	}
	return encoder.encode(content);
}

export class WorkspaceFs implements IFileSystem {
	private mirror: ProjectMirror;
	/** Everything that is not the project: `/tmp`, `$HOME`, `/dev/null`. */
	private scratch: InMemoryFs;
	/**
	 * Project paths someone ran `chmod +x` on.
	 *
	 * The mirror stores bytes, not modes, and the difference matters in exactly one place: bash
	 * runs a file as a script when it looks executable. Reporting everything executable would feed
	 * `src/main.ts` to the shell parser when someone types `./src/main.ts`; reporting nothing
	 * executable would break `chmod +x run.sh && ./run.sh`. So the bit lives here, for this
	 * session only.
	 */
	private execBits = new Set<string>();
	/** Directories have no mtime in the mirror, and a moving one would make `ls -t` unstable. */
	private dirMtime = new Date();
	private allPaths: string[] | undefined;
	private release: () => void;

	constructor(mirror: ProjectMirror) {
		this.mirror = mirror;
		this.scratch = new InMemoryFs();
		// What `fs/init.ts` would have created if this filesystem had synchronous writers — minus
		// `/bin` and `/usr/bin`, whose mere existence would switch command resolution off the
		// registry (see the header). `/dev/null` needs no entry: a write creates its parents.
		this.scratch.mkdirSync("/tmp", { recursive: true });
		this.scratch.mkdirSync("/home/user", { recursive: true });
		this.release = mirror.onChange(() => {
			this.allPaths = undefined;
		});
	}

	dispose(): void {
		this.release();
	}

	// ------------------------------------------------------------------ paths

	resolvePath(base: string, path: string): string {
		return resolveAgainst(base, path);
	}

	/** The project-relative form of `path`, or undefined when it belongs to the scratch tree. */
	private project(path: string, op: string): string | undefined {
		assertNoNullByte(path, op);
		return toProjectRelative(path);
	}

	// ------------------------------------------------------------------ reads

	async readFileBuffer(path: string): Promise<Uint8Array> {
		let relative = this.project(path, "open");
		if (relative === undefined) return this.scratch.readFileBuffer(path);
		let data = this.mirror.read(relative);
		if (data === undefined) {
			throw this.mirror.isDir(relative) ? eisdir("read", path) : enoent("open", path);
		}
		return data;
	}

	async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
		return decodeBytes(await this.readFileBuffer(path), encodingOf(options));
	}

	async exists(path: string): Promise<boolean> {
		let relative = this.project(path, "stat");
		if (relative === undefined) return this.scratch.exists(path);
		return this.mirror.has(relative) || this.mirror.isDir(relative);
	}

	async stat(path: string): Promise<FsStat> {
		let relative = this.project(path, "stat");
		if (relative === undefined) return this.scratch.stat(path);
		return this.statProject(relative, path);
	}

	/** No symlinks in the project, so there is nothing for `lstat` to see differently. */
	async lstat(path: string): Promise<FsStat> {
		let relative = this.project(path, "lstat");
		if (relative === undefined) return this.scratch.lstat(path);
		return this.statProject(relative, path);
	}

	private statProject(relative: string, path: string): FsStat {
		let absolute = normalizePath(path);
		if (this.mirror.isDir(relative)) {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: DIR_MODE,
				size: 0,
				mtime: this.dirMtime,
				// A stable identity is what stops `cp -r a a/b` from recursing forever, and saves
				// the traversal walker from falling back to `realpath` for every entry.
				identity: absolute,
			};
		}
		let data = this.mirror.read(relative);
		if (data === undefined) throw enoent("stat", path);
		return {
			isFile: true,
			isDirectory: false,
			isSymbolicLink: false,
			mode: this.execBits.has(absolute) ? EXEC_MODE : FILE_MODE,
			size: data.byteLength,
			mtime: new Date(this.mirror.mtimeOf(relative) ?? 0),
			identity: absolute,
		};
	}

	async readdir(path: string): Promise<string[]> {
		return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
	}

	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		let relative = this.project(path, "scandir");
		if (relative === undefined) return this.scratch.readdirWithFileTypes(path);
		if (!this.mirror.isDir(relative)) {
			throw this.mirror.has(relative) ? enotdir(path) : enoent("scandir", path);
		}
		return this.mirror.list(relative).map((entry) => ({
			name: entry.name,
			isFile: entry.kind === "file",
			isDirectory: entry.kind === "dir",
			isSymbolicLink: false,
		}));
	}

	/**
	 * Every path, for the one caller that needs them all at once: `ls` given a *quoted* glob,
	 * which it matches itself rather than letting the interpreter expand. Unquoted globs walk
	 * `readdirWithFileTypes` instead, so this is not on the path that matters — but it is called
	 * synchronously, so it is cached and dropped whenever the project changes.
	 *
	 * Directories appear only when they contain something; an empty one has no file to imply it.
	 */
	getAllPaths(): string[] {
		if (this.allPaths) return this.allPaths;
		let seen = new Set<string>(this.scratch.getAllPaths());
		seen.add(PROJECT_ROOT);
		for (let { path } of this.mirror.allFiles()) {
			let absolute = `${PROJECT_ROOT}/${path}`;
			seen.add(absolute);
			for (let dir = parentOf(absolute); dir !== "/" && !seen.has(dir); dir = parentOf(dir)) {
				seen.add(dir);
			}
		}
		this.allPaths = [...seen].sort();
		return this.allPaths;
	}

	// ----------------------------------------------------------------- writes

	async writeFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding
	): Promise<void> {
		let relative = this.project(path, "write");
		if (relative === undefined) return this.scratch.writeFile(path, content, options);
		if (relative === "" || this.mirror.isDir(relative)) throw eisdir("write", path);
		this.mirror.write(relative, encodeContent(content, encodingOf(options)));
	}

	async appendFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding
	): Promise<void> {
		let relative = this.project(path, "append");
		if (relative === undefined) return this.scratch.appendFile(path, content, options);
		if (relative === "" || this.mirror.isDir(relative)) throw eisdir("write", path);
		let addition = encodeContent(content, encodingOf(options));
		let existing = this.mirror.read(relative);
		if (!existing) {
			this.mirror.write(relative, addition);
			return;
		}
		let joined = new Uint8Array(existing.byteLength + addition.byteLength);
		joined.set(existing);
		joined.set(addition, existing.byteLength);
		this.mirror.write(relative, joined);
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		let relative = this.project(path, "mkdir");
		if (relative === undefined) return this.scratch.mkdir(path, options);
		if (this.mirror.has(relative)) throw fsError(`EEXIST: file already exists, mkdir '${path}'`);
		if (this.mirror.isDir(relative)) {
			if (options?.recursive) return;
			throw fsError(`EEXIST: directory already exists, mkdir '${path}'`);
		}
		// The mirror creates parents unconditionally, so a non-recursive mkdir has to check for
		// itself or `mkdir a/b/c` would silently succeed.
		let parent = parentOf(normalizePath(path));
		if (!options?.recursive && !(await this.exists(parent))) throw enoent("mkdir", path);
		this.mirror.mkdir(relative);
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		let relative = this.project(path, "rm");
		if (relative === undefined) return this.scratch.rm(path, options);
		if (relative === "") {
			throw fsError(`EPERM: operation not permitted, rm '${path}'`);
		}
		let isDir = this.mirror.isDir(relative);
		if (!isDir && !this.mirror.has(relative)) {
			if (options?.force) return;
			throw enoent("rm", path);
		}
		if (isDir && !options?.recursive && this.mirror.list(relative).length > 0) {
			throw fsError(`ENOTEMPTY: directory not empty, rm '${path}'`);
		}
		this.execBits.delete(normalizePath(path));
		this.mirror.delete(relative);
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		assertNoNullByte(src, "cp");
		assertNoNullByte(dest, "cp");
		let from = normalizePath(src);
		let to = normalizePath(dest);
		if (from === to) return;
		if (to.startsWith(`${from}/`)) {
			throw fsError(`EINVAL: cannot copy '${src}' into itself, '${dest}'`);
		}
		let stat = await this.stat(from).catch(() => undefined);
		if (!stat) throw enoent("cp", src);
		if (!stat.isDirectory) {
			await this.writeFile(to, await this.readFileBuffer(from));
			if (stat.mode === EXEC_MODE) this.execBits.add(to);
			return;
		}
		if (!options?.recursive) throw fsError(`EISDIR: is a directory, cp '${src}'`);
		// Written through the same methods, so a copy that crosses between the project and the
		// scratch tree needs no special case.
		await this.mkdir(to, { recursive: true });
		for (let entry of await this.readdirWithFileTypes(from)) {
			await this.cp(`${from}/${entry.name}`, `${to}/${entry.name}`, options);
		}
	}

	async mv(src: string, dest: string): Promise<void> {
		assertNoNullByte(src, "mv");
		assertNoNullByte(dest, "mv");
		let from = normalizePath(src);
		let to = normalizePath(dest);
		if (from === to) return;
		if (to.startsWith(`${from}/`)) {
			throw fsError(`EINVAL: cannot move '${src}' into itself, '${dest}'`);
		}
		let stat = await this.stat(from).catch(() => undefined);
		if (!stat) throw enoent("mv", src);
		// Copy then remove: the mirror has no rename, and this is the only form that also works
		// when the two paths are on opposite sides of the project boundary.
		await this.cp(from, to, { recursive: true });
		await this.rm(from, { recursive: true, force: true });
	}

	async chmod(path: string, mode: number): Promise<void> {
		let relative = this.project(path, "chmod");
		if (relative === undefined) return this.scratch.chmod(path, mode);
		if (!this.mirror.has(relative) && !this.mirror.isDir(relative)) {
			throw enoent("chmod", path);
		}
		let absolute = normalizePath(path);
		if (mode & 0o111) this.execBits.add(absolute);
		else this.execBits.delete(absolute);
	}

	async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
		let relative = this.project(path, "utimes");
		if (relative === undefined) return this.scratch.utimes(path, atime, mtime);
		let data = this.mirror.read(relative);
		if (data === undefined) {
			// Directories have no mtime to set, which is a normal answer rather than an error.
			if (this.mirror.isDir(relative)) return;
			throw enoent("utimes", path);
		}
		this.mirror.writeMany([{ path: relative, data, mtimeMs: mtime.getTime() }]);
	}

	// -------------------------------------------------------------- symlinks
	//
	// The runtime has none — the project is mounted from a directory handle, and npm's own
	// `node_modules/.bin` shims are resolved out of each package's `bin` field precisely because
	// there is nothing to link with. The scratch tree does support them, so `ln -s` still works
	// under `/tmp`.

	async symlink(target: string, linkPath: string): Promise<void> {
		if (this.project(linkPath, "symlink") === undefined) {
			return this.scratch.symlink(target, linkPath);
		}
		throw fsError(`EPERM: operation not permitted, symlink '${linkPath}'`);
	}

	async link(existingPath: string, newPath: string): Promise<void> {
		if (this.project(newPath, "link") === undefined) {
			return this.scratch.link(existingPath, newPath);
		}
		throw fsError(`EPERM: operation not permitted, link '${newPath}'`);
	}

	async readlink(path: string): Promise<string> {
		if (this.project(path, "readlink") === undefined) return this.scratch.readlink(path);
		throw fsError(`EINVAL: invalid argument, readlink '${path}'`);
	}

	async realpath(path: string): Promise<string> {
		let relative = this.project(path, "realpath");
		if (relative === undefined) return this.scratch.realpath(path);
		if (!this.mirror.has(relative) && !this.mirror.isDir(relative)) {
			throw enoent("realpath", path);
		}
		return normalizePath(path);
	}
}
