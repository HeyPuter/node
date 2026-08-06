// The first-run splash.
//
// Its percentages are real, unlike the mock's timed script: the download reports bytes
// against the archive's known size, the extract reports entries against the manifest's
// file count, and the save reports files written. Weighted so the bar advances at a
// roughly even rate rather than sitting at 90% through the slowest phase.
//
// A phase nothing reports is worse than no phase at all — it is a slice of bar the run
// silently skips, which is exactly what "Populating filesystem" became once the worker
// started mounting the project instead of being filled with it. So the list below is kept
// to phases that something actually calls; see the `.phase(` callers in `src/workspace.ts`
// and `src/project/source.ts`.

import type { ShellElements } from "./shell";

export interface SplashPhase {
	key: string;
	/** Shown next to the percentage. */
	label: string;
	/** Share of the overall bar, relative to the other phases. */
	weight: number;
}

const PHASES: SplashPhase[] = [
	{ key: "download", label: "Downloading project image", weight: 3 },
	{ key: "extract", label: "Unpacking project", weight: 2 },
	// Weighted like the download because it costs like the download: a first visit writes
	// every one of the template's ~5,000 files out to disk here.
	{ key: "save", label: "Saving project", weight: 3 },
	{ key: "auth", label: "Connecting", weight: 1 },
	{ key: "worker", label: "Starting worker", weight: 1 },
	{ key: "probe", label: "Checking the runtime", weight: 1 },
];

const TOTAL_WEIGHT = PHASES.reduce((n, p) => n + p.weight, 0);

/** How long "Ready" stays on screen before the workspace takes over. */
const READY_DISMISS_MS = 450;

export interface SplashController {
	/** Advance to a phase; `fraction` is progress within it, 0..1. */
	phase(key: string, fraction?: number, detail?: string): void;
	log(text: string): void;
	/** 100%, then hand over to the workspace on its own. */
	finish(onOpen: () => void): void;
	fail(message: string): void;
	/** Ask for a token; resolves with what was entered. */
	requestToken(): Promise<string>;
	/**
	 * Ask for the click that re-grants a remembered folder.
	 *
	 * `grant` is called from inside the button's own handler, because that is the only place
	 * `requestPermission` can be called from — and it is why this is a splash concern at all
	 * rather than something the boot sequence could do by itself.
	 */
	requestFolder(req: {
		name: string;
		grant: () => Promise<boolean>;
	}): Promise<"opened" | "template">;
	hide(): void;
}

export function mountSplash(el: ShellElements): SplashController {
	let setBar = (fraction: number) => {
		let pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
		el.progressFill.style.width = `${pct}%`;
		el.progressPercent.textContent = `${pct}%`;
		el.progressTrack.setAttribute("aria-valuenow", String(pct));
	};

	let log = (text: string) => {
		let line = document.createElement("p");
		line.className = "sh-line";
		let span = document.createElement("span");
		span.className = "sh-dim";
		span.textContent = text;
		line.append(span);
		el.startupLog.append(line);
		el.startupLog.scrollTop = el.startupLog.scrollHeight;
	};

	return {
		phase(key, fraction = 0, detail) {
			let index = PHASES.findIndex((p) => p.key === key);
			if (index === -1) return;
			let before = PHASES.slice(0, index).reduce((n, p) => n + p.weight, 0);
			let within = PHASES[index].weight * Math.max(0, Math.min(1, fraction));
			setBar((before + within) / TOTAL_WEIGHT);
			el.progressPhase.textContent = PHASES[index].label;
			if (detail !== undefined) el.splashStatus.textContent = detail;
		},

		log,

		finish(onOpen) {
			setBar(1);
			el.progressPhase.textContent = "Ready";
			el.splashStatus.textContent = "Runtime ready.";
			// Long enough for the bar to land on 100% rather than jumping straight from
			// wherever it was, short enough not to read as a pause. There is nothing to
			// decide here, so a button would only be a step to click through.
			setTimeout(onOpen, READY_DISMISS_MS);
		},

		fail(message) {
			el.progressPhase.textContent = "Failed";
			el.splashStatus.textContent = message;
			el.progressFill.style.background = "var(--err)";
			log(`error: ${message}`);
		},

		requestToken() {
			// The progress bar is meaningless while we are blocked on the user, so it
			// steps aside rather than sitting at 0%.
			el.launchProgress.hidden = true;
			el.tokenPanel.hidden = false;
			el.tokenInput.focus();
			return new Promise<string>((resolve) => {
				el.tokenPanel.addEventListener("submit", (event) => {
					event.preventDefault();
					let token = el.tokenInput.value.trim();
					if (!token) return;
					el.tokenPanel.hidden = true;
					el.launchProgress.hidden = false;
					resolve(token);
				});
			});
		},

		requestFolder({ name, grant }) {
			// Same as the token form: the progress bar means nothing while we are blocked on
			// the user, so it steps aside rather than sitting at 0%.
			el.launchProgress.hidden = true;
			el.folderPanel.hidden = false;
			el.folderPanelName.textContent = name;
			el.folderOpenBtn.textContent = `Reopen “${name}”`;
			el.folderOpenBtn.focus();

			return new Promise<"opened" | "template">((resolve) => {
				let done = (outcome: "opened" | "template") => {
					el.folderPanel.hidden = true;
					el.launchProgress.hidden = false;
					resolve(outcome);
				};

				el.folderOpenBtn.addEventListener("click", () => {
					el.folderPanelError.hidden = true;
					el.folderOpenBtn.disabled = true;
					// Inside the handler, not after an await: the gesture is what buys the
					// prompt, and anything awaited first spends it.
					void grant()
						.then((granted) => {
							if (granted) {
								done("opened");
								return;
							}
							// Declining is not an error and not a dead end — the panel stays up
							// with both ways out still on it.
							el.folderPanelError.textContent =
								"Permission was not granted, so the folder cannot be read. Try again, or load a template instead.";
							el.folderPanelError.hidden = false;
						})
						.catch((err: unknown) => {
							el.folderPanelError.textContent =
								err instanceof Error ? err.message : String(err);
							el.folderPanelError.hidden = false;
						})
						.finally(() => {
							el.folderOpenBtn.disabled = false;
						});
				});

				el.folderTemplateBtn.addEventListener("click", () => done("template"));
			});
		},

		hide() {
			el.splash.hidden = true;
			el.app.hidden = false;
		},
	};
}
