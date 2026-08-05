// Resolving URLs against wherever this build happens to be deployed.
//
// The build uses a relative base (see vite.config.ts), so the app has no fixed path: the same dist
// serves from `/` and from `/labs/node/`. Vite rewrites the URLs it knows about — `?url` imports,
// asset references in HTML and CSS — but a path the app builds itself at runtime is invisible to
// it, and a leading-slash path would look for `/templates/…` on a deployment rooted three
// directories down.

/**
 * An absolute URL for `path`, which is relative to the app's root.
 *
 * Resolved against `document.baseURI` rather than left relative, because a relative URL is resolved
 * against whatever document happens to be current — fine on the page, wrong in a worker, where the
 * script's own URL is the base instead. An absolute URL means the same thing everywhere.
 */
export function appUrl(path: string): string {
	return new URL(path, new URL(import.meta.env.BASE_URL, document.baseURI)).href;
}
