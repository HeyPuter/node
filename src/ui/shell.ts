// The workspace's DOM.
//
// Markup and class names come from ui-mock.html; this module's job is to build it once
// and hand back typed references, so nothing else in the app does `querySelector` with
// a string literal and discovers at runtime that it renamed an id.
//
// Differences from the mock, all of them where the mock could fake something the real
// thing cannot:
//   - `#code` hosts Monaco and `#shell` hosts xterm, rather than being hand-rendered.
//   - the splash grows a token field, since the runtime needs a Puter token for
//     networking and there is nowhere else to ask for one.

import "./styles.css";
// The favicon from nodejs.org, which the project only publishes as a bitmap.
import NODE_LOGO from "./node-logo.png";

const lockup = () => `
	<div class="logo-lockup">
		<span class="logo-tile"><img src="${NODE_LOGO}" alt="Node.js" /></span>
	</div>`;

const PUTER_MARK =
	"data:image/svg+xml,%3C%3Fxml%20version%3D%221.0%22%20encoding%3D%22utf-8%22%3F%3E%3Csvg%20x%3D%220px%22%20y%3D%220px%22%20width%3D%2248px%22%20height%3D%2248px%22%20viewBox%3D%220%200%2048%2048%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cg%20stroke-width%3D%222%22%20transform%3D%22matrix(0%2C%201%2C%20-1%2C%200%2C%2047.999504%2C%200.000014)%22%3E%3Cpolyline%20points%3D%2239%2024%2025%2024%2025%2028%22%20fill%3D%22none%22%20stroke%3D%22%23444444%22%20stroke-linecap%3D%22square%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%20stroke-linejoin%3D%22miter%22%2F%3E%3Cpolyline%20points%3D%2235.879%2010.121%2032%2014%2025%2014%2025%2018%22%20fill%3D%22none%22%20stroke%3D%22%23444444%22%20stroke-linecap%3D%22square%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%20stroke-linejoin%3D%22miter%22%2F%3E%3Cpath%20d%3D%22M13%2C26a10.29%2C10.29%2C0%2C0%2C1-7.2-3%22%20fill%3D%22none%22%20stroke%3D%22%23444444%22%20stroke-linecap%3D%22square%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%20stroke-linejoin%3D%22miter%22%2F%3E%3Cpath%20d%3D%22M17%2C31.6A5.826%2C5.826%2C0%2C0%2C1%2C13%2C26a5.731%2C5.731%2C0%2C0%2C1%2C2-4.4%22%20fill%3D%22none%22%20stroke%3D%22%23444444%22%20stroke-linecap%3D%22square%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%20stroke-linejoin%3D%22miter%22%2F%3E%3Cpath%20d%3D%22M35.879%2C37.879%2C32%2C34H25v2A9.9%2C9.9%2C0%2C0%2C1%2C15%2C46%2C9.9%2C9.9%2C0%2C0%2C1%2C5%2C36a9.058%2C9.058%2C0%2C0%2C1%2C.6-3.2A5.627%2C5.627%2C0%2C0%2C1%2C3%2C28a5.888%2C5.888%2C0%2C0%2C1%2C2.8-5A9.994%2C9.994%2C0%2C0%2C1%2C3%2C16%2C9.9%2C9.9%2C0%2C0%2C1%2C13%2C6h.4A5.826%2C5.826%2C0%2C0%2C1%2C19%2C2a5.893%2C5.893%2C0%2C0%2C1%2C6%2C6%22%20fill%3D%22none%22%20stroke%3D%22%23444444%22%20stroke-linecap%3D%22square%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%20stroke-linejoin%3D%22miter%22%2F%3E%3Ccircle%20cx%3D%2238%22%20cy%3D%228%22%20r%3D%223%22%20fill%3D%22none%22%20stroke%3D%22%23444444%22%20stroke-linecap%3D%22square%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%20data-color%3D%22color-2%22%20stroke-linejoin%3D%22miter%22%2F%3E%3Ccircle%20cx%3D%2242%22%20cy%3D%2224%22%20r%3D%223%22%20fill%3D%22none%22%20stroke%3D%22%23444444%22%20stroke-linecap%3D%22square%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%20data-color%3D%22color-2%22%20stroke-linejoin%3D%22miter%22%2F%3E%3Ccircle%20cx%3D%2238%22%20cy%3D%2240%22%20r%3D%223%22%20fill%3D%22none%22%20stroke%3D%22%23444444%22%20stroke-linecap%3D%22square%22%20stroke-miterlimit%3D%2210%22%20stroke-width%3D%222%22%20data-color%3D%22color-2%22%20stroke-linejoin%3D%22miter%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E";

const GITHUB_URL = "https://github.com/HeyPuter/node-worker";
const DOCS_URL = "https://developer.puter.com/";

const MARKUP = `
<header class="top-nav">
	<div class="nav-left">
		<a class="nav-brand" href="${DOCS_URL}" target="_blank" rel="noreferrer" aria-label="Puter">
			<img src="${PUTER_MARK}" alt="Puter" height="30" />
		</a>
		<a class="nav-brand-label" href="${DOCS_URL}" target="_blank" rel="noreferrer">
			Puter <span class="labs-badge">Labs</span>
		</a>
	</div>
	<div class="nav-links">
		<a class="nav-link" href="${DOCS_URL}" target="_blank" rel="noreferrer" aria-label="Docs">Docs</a>
		<a class="nav-link" href="${GITHUB_URL}" target="_blank" rel="noreferrer" aria-label="GitHub">
			<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
				<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
			</svg>
		</a>
	</div>
</header>

<section class="splash" id="splash">
	<div class="stage-inner">
		${lockup()}
		<h1 class="splash-title">Node.js Runtime</h1>
		<p class="project-copy">
			Node.js in the browser, running in a worker. 
		</p>

		<div class="launch-panel">
			<div class="launch-progress" id="launchProgress">
				<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="progressTrack">
					<div class="progress-fill" id="progressFill"></div>
				</div>
				<div class="progress-meta">
					<span id="progressPhase">Starting up</span>
					<span id="progressPercent">0%</span>
				</div>
				<p class="splash-status" id="splashStatus">Preparing the Node.js runtime…</p>
			</div>

			<form class="token-form" id="tokenPanel" hidden>
				<label class="token-label" for="tokenInput">Puter auth token</label>
				<input class="token-input" id="tokenInput" type="password" autocomplete="off"
					spellcheck="false" placeholder="paste a token" />
				<p class="token-hint">
					The runtime needs one for networking and storage. Launch this as a Puter app,
					or set <code>VITE_DEV_TOKEN</code>, to skip this step.
				</p>
				<button class="start-btn" id="tokenSubmit" type="submit">Start runtime</button>
			</form>
		</div>

		<section class="startup-console" aria-label="Startup log">
			<p class="phase-kicker">Startup log</p>
			<div class="console-box" id="startupLog" role="log"></div>
		</section>
	</div>
</section>

<div class="app" id="app" hidden>
	<div class="app-body">
		<div class="app-head">
			<div class="title-block">
				${lockup()}
				<div class="title-copy">
					<h1>Node.js Runtime</h1>
					<p>Node.js in the browser, running in a worker.</p>
				</div>
			</div>

			<div class="head-actions">
				<span class="status-pill" id="statusPill" data-state="booting">
					<span class="status-dot"></span>
					Worker <strong id="statusText">starting</strong>
				</span>
				<button class="btn btn-primary" id="runBtn" type="button">
					<svg width="10" height="11" viewBox="0 0 10 11" aria-hidden="true" id="runBtnIcon">
						<path d="M0 0v11l10-5.5z" fill="currentColor" />
					</svg>
					<span id="runBtnLabel">Run dev server</span>
				</button>
				<button class="btn" id="exportBtn" type="button">
					<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<path d="M8 10.5V1.5m0 0L5 4.5m3-3 3 3M2 9.5v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"
							stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
					Export to Puter
				</button>
				<button class="btn" id="restartBtn" type="button">Restart worker</button>
			</div>
		</div>

		<main class="workspace">
			<section class="card">
				<div class="split">
					<div class="pane files">
						<div class="pane-head">
							<span class="kicker">Files</span>
							<span class="spacer"></span>
							<span class="select-pill">
								<select id="presetSelect" aria-label="Project template"></select>
							</span>
						</div>
						<div class="tree" id="tree"></div>
					</div>

					<div class="pane">
						<div class="pane-head flush">
							<div class="tabs" id="tabs"></div>
							<span class="spacer"></span>
							<button class="btn btn-ghost" id="runFileBtn" type="button" style="margin-right: 8px">
								Run file
							</button>
						</div>
						<div class="code" id="code"></div>
					</div>
				</div>
			</section>

			<section class="card">
				<div class="pane-head">
					<span class="kicker">Shell</span>
					<span class="spacer"></span>
					<a class="preview-chip" id="previewChip" href="#" target="_blank" rel="noreferrer" hidden>
						<span class="live"></span>
						<span id="previewChipLabel">Preview</span>
						<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
							<path d="M2.5 7.5 7.5 2.5M7.5 2.5H3.8M7.5 2.5v3.7" stroke="currentColor"
								stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					</a>
					<button class="btn btn-ghost" id="clearBtn" type="button">Clear</button>
				</div>
				<div class="shell" id="shell"></div>
			</section>
		</main>

		<div class="status-bar">
			<a class="powered-badge" href="${DOCS_URL}" target="_blank" rel="noreferrer">
				<span class="powered-dot" aria-hidden="true"></span>
				Networking and storage powered by <strong>Puter.js</strong>
			</a>
		</div>
	</div>
</div>
`;

export interface ShellElements {
	splash: HTMLElement;
	launchProgress: HTMLElement;
	progressTrack: HTMLElement;
	progressFill: HTMLElement;
	progressPhase: HTMLElement;
	progressPercent: HTMLElement;
	splashStatus: HTMLElement;
	startupLog: HTMLElement;
	tokenPanel: HTMLFormElement;
	tokenInput: HTMLInputElement;

	app: HTMLElement;
	statusPill: HTMLElement;
	statusText: HTMLElement;
	runBtn: HTMLButtonElement;
	runBtnIcon: SVGElement;
	runBtnLabel: HTMLElement;
	exportBtn: HTMLButtonElement;
	restartBtn: HTMLButtonElement;
	presetSelect: HTMLSelectElement;
	tree: HTMLElement;
	tabs: HTMLElement;
	runFileBtn: HTMLButtonElement;
	code: HTMLElement;
	previewChip: HTMLAnchorElement;
	previewChipLabel: HTMLElement;
	clearBtn: HTMLButtonElement;
	shell: HTMLElement;
}

/** Replace `root`'s contents with the workspace and return its elements. */
export function buildShell(root: Element): ShellElements {
	root.innerHTML = MARKUP;

	let pick = <T extends Element>(id: string): T => {
		let el = root.querySelector<T>(`#${id}`);
		if (!el) throw new Error(`shell markup is missing #${id}`);
		return el;
	};

	return {
		splash: pick("splash"),
		launchProgress: pick("launchProgress"),
		progressTrack: pick("progressTrack"),
		progressFill: pick("progressFill"),
		progressPhase: pick("progressPhase"),
		progressPercent: pick("progressPercent"),
		splashStatus: pick("splashStatus"),
		startupLog: pick("startupLog"),
		tokenPanel: pick("tokenPanel"),
		tokenInput: pick("tokenInput"),

		app: pick("app"),
		statusPill: pick("statusPill"),
		statusText: pick("statusText"),
		runBtn: pick("runBtn"),
		runBtnIcon: pick("runBtnIcon"),
		runBtnLabel: pick("runBtnLabel"),
		exportBtn: pick("exportBtn"),
		restartBtn: pick("restartBtn"),
		presetSelect: pick("presetSelect"),
		tree: pick("tree"),
		tabs: pick("tabs"),
		runFileBtn: pick("runFileBtn"),
		code: pick("code"),
		previewChip: pick("previewChip"),
		previewChipLabel: pick("previewChipLabel"),
		clearBtn: pick("clearBtn"),
		shell: pick("shell"),
	};
}
