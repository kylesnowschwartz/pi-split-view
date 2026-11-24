/** Paths in the tree's form: absolute, '/' separators, no trailing slash. */

export function join(dir: string, name: string): string {
	return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "/" : path.slice(0, i);
}

export function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function isAbsolute(path: string): boolean {
	return path.startsWith("/");
}

export function inside(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Whether `id` or a folder above it (up to `root`) is in `set`. */
export function underAny(id: string, set: Set<string>, root: string): boolean {
	if (set.size === 0) return false;
	let cur = id;
	while (cur.length >= root.length) {
		if (set.has(cur)) return true;
		const up = dirname(cur);
		if (up === cur) break;
		cur = up;
	}
	return false;
}

/** The folders between `root` and `id`, nearest first; `root` itself is not included. */
export function ancestorsOf(id: string, root: string): string[] {
	const out: string[] = [];
	if (!root) return out;
	for (
		let dir = dirname(id), prev = id;
		dir !== prev && dir !== root && inside(root, dir);
		prev = dir, dir = dirname(dir)
	)
		out.push(dir);
	return out;
}

export function relative(root: string, path: string): string {
	return path === root ? "" : path.slice(root.endsWith("/") ? root.length : root.length + 1);
}

function tidy(path: string): string {
	const s = path.replace(/\/+$/, "");
	return s === "" ? "/" : s;
}

/** `p` as an absolute path: `~` expands to `home`, a relative path resolves
 * against `cwd`, and `.` and `..` segments are folded. */
export function resolve(cwd: string, p: string, home = ""): string {
	let path = p;
	if (home && (path === "~" || path.startsWith("~/"))) path = home + path.slice(1);
	const parts = isAbsolute(path) ? [""] : cwd.replace(/\/+$/, "").split("/");
	for (const seg of path.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") {
			if (parts.length > 1) parts.pop();
		} else parts.push(seg);
	}
	return tidy(parts.join("/"));
}

/** Folders the tree does not open or list on its own: the tree shows each as
 * a closed folder that only a click opens. */
export const PRUNE = [".git", "node_modules", "target", ".venv", "__pycache__", "dist", ".next"];
const HOME_PRUNE = ["Library", "AppData", ".Trash"];

/** The home folder or the disk root, where the system folders are pruned too. */
function broad(root: string, home: string): boolean {
	return root === home || root === "/";
}

function prunedNames(root: string, home: string): string[] {
	return broad(root, home) ? [...PRUNE, ...HOME_PRUNE] : PRUNE;
}

/** Whether `dir`, or a folder between `root` and it, has a pruned name. */
export function prunedUnder(root: string, home: string, dir: string): boolean {
	const names = prunedNames(root, home);
	return dir
		.split("/")
		.slice(Math.max(0, root.split("/").length - 1))
		.some((name) => names.includes(name));
}
