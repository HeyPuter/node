// The first-run splash.
//
// Its percentages are real, unlike the mock's timed script: the download reports bytes
// against the archive's known size, the extract reports entries against the manifest's
// file count, and the populate reports batches. Weighted so the bar advances at a
// roughly even rate rather than sitting at 90% through the slowest phase.

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
	{ key: "worker", label: "Starting worker", weight: 1 },
	{ key: "populate", label: "Populating filesystem", weight: 3 },
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

		hide() {
			el.splash.hidden = true;
			el.app.hidden = false;
		},
	};
}
