

import { App, Editor, MarkdownView, Menu, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { RangeSetBuilder } from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from '@codemirror/view';

// A line that conveys an emotion or a thought, e.g. `~ feeling restless`.
// The `~` glyph renders as itself; the plugin only marks the line so styles.css
// can give it a distinct (muted/italic) look. The actual marker glyphs for
// tasks/events/migration are handled entirely in styles.css, keyed on the
// `data-task` attribute Obsidian sets on each list item — see that file for the
// canonical glyph table.
const EMOTION_LINE = /^~\s/;

// Matches the `- [o]` / `- [p]` / `- [O]` lead of an event line; group 1 is
// everything before the marker character, group 2 the marker itself.
const EVENT_MARKER = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([oOp])\]/;

// Clicking an event steps it through open → in-progress → done → open.
function cycleEvent(cur: string): string {
	return cur === 'o' ? 'p' : cur === 'p' ? 'O' : 'o';
}

// Matches the `- [ ]` / `- [/]` / `- [x]` lead of a task; groups mirror
// EVENT_MARKER (group 2 is the marker, possibly a space for an open task).
const TASK_MARKER = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX/])\]/;

// Clicking a task steps it through open → in-progress → done → open.
function cycleTask(cur: string): string {
	return cur === ' ' ? '/' : cur === '/' ? 'x' : ' ';
}

// Rewrite the marker character on the given line of a note's contents, mapping
// the current marker to its replacement via `next`. Returns the data unchanged
// if the line doesn't match.
function setMarker(
	data: string,
	lineNo: number,
	regex: RegExp,
	next: (cur: string) => string
): string {
	const lines = data.split('\n');
	const line = lines[lineNo] ?? '';
	const match = regex.exec(line);
	if (!match) {
		return data;
	}
	const markerAt = (match[1] ?? '').length;
	lines[lineNo] = line.slice(0, markerAt) + next(match[2] ?? '') + line.slice(markerAt + 1);
	return lines.join('\n');
}

// The bullet types a line can be switched between (commands + right-click
// menu). `marker` is the character inside `[ ]`; `null` is a plain note dash
// (no checkbox), and `' '` is an open task `[ ]`.
const BULLET_TYPES: { id: string; name: string; marker: string | null }[] = [
	{ id: 'note', name: 'Note', marker: null },
	{ id: 'task', name: 'Task', marker: ' ' },
	{ id: 'task-in-progress', name: 'Task in progress', marker: '/' },
	{ id: 'done', name: 'Done', marker: 'x' },
	{ id: 'cancelled', name: 'Cancelled', marker: '-' },
	{ id: 'migrated', name: 'Migrated', marker: '>' },
	{ id: 'future', name: 'Future log', marker: '<' },
	{ id: 'event', name: 'Event', marker: 'o' },
	{ id: 'event-in-progress', name: 'Event in progress', marker: 'p' },
	{ id: 'event-done', name: 'Event done', marker: 'O' },
	{ id: 'feeling', name: 'Feeling', marker: '~' },
];

// A list line: group 1 the bullet lead (`- `, `* `, `1. ` …), group 2 the
// optional existing `[m] ` marker, group 3 the remaining text.
const LIST_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)(\[[^\]]?\]\s+)?(.*)$/;

// Rewrite a single line to the given bullet type. Lines that aren't list items
// are returned unchanged.
function applyBulletType(line: string, marker: string | null): string {
	const match = LIST_LINE.exec(line);
	if (!match) {
		return line;
	}
	const lead = match[1] ?? '';
	const rest = match[3] ?? '';
	return marker === null ? lead + rest : `${lead}[${marker}] ${rest}`;
}

// ---- Live Preview / Source mode: tag `~ ` lines for styling. -----------------

const emotionLine = Decoration.line({ class: 'bb-emotion' });
// Wraps the leading `~` so styles.css can box it into the marker column.
const emotionMarker = Decoration.mark({ class: 'bb-emotion-marker' });

class EmotionView implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = this.build(update.view);
		}
	}

	private build(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();
		for (const { from, to } of view.visibleRanges) {
			let pos = from;
			while (pos <= to) {
				const line = view.state.doc.lineAt(pos);
				if (EMOTION_LINE.test(line.text)) {
					builder.add(line.from, line.from, emotionLine);
					builder.add(line.from, line.from + 1, emotionMarker);
				}
				pos = line.to + 1;
			}
		}
		return builder.finish();
	}
}

const emotionExtension = ViewPlugin.fromClass(EmotionView, {
	decorations: (value) => value.decorations,
});

// ---- Time-based events: `- [9:30 AM] …` → a clock on the bullet + the time. --

// Group 1: the bullet lead. Group 2: the time inside the brackets.
const TIME_EVENT_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(\d{1,2}:\d{2}\s*[AaPp][Mm])\]/;
// The same time bracket, anchored to the start of a list item's rendered text.
const TIME_EVENT_TEXT = /^\[(\d{1,2}:\d{2}\s*[AaPp][Mm])\]/;

const clockLine = Decoration.line({ class: 'bb-clock-line' });

// Live Preview: replace the `[9:30 AM]` source with just the time; the clock
// glyph itself is drawn on the list bullet by styles.css.
class ClockWidget extends WidgetType {
	constructor(private readonly time: string) {
		super();
	}

	eq(other: ClockWidget): boolean {
		return other.time === this.time;
	}

	toDOM(): HTMLElement {
		return createSpan({ cls: 'bb-clock-time', text: this.time });
	}
}

class ClockView implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.viewportChanged || update.selectionSet) {
			this.decorations = this.build(update.view);
		}
	}

	private build(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();
		const { selection } = view.state;
		for (const { from, to } of view.visibleRanges) {
			let pos = from;
			while (pos <= to) {
				const line = view.state.doc.lineAt(pos);
				const match = TIME_EVENT_LINE.exec(line.text);
				if (match) {
					const time = match[2] ?? '';
					const start = line.from + (match[1] ?? '').length;
					const end = start + time.length + 2; // '[' + time + ']'
					// Reveal the raw source while editing on the brackets.
					const editing = selection.ranges.some((r) => r.from <= end && r.to >= start);
					if (!editing) {
						builder.add(line.from, line.from, clockLine);
						builder.add(start, end, Decoration.replace({ widget: new ClockWidget(time) }));
					}
				}
				pos = line.to + 1;
			}
		}
		return builder.finish();
	}
}

const clockExtension = ViewPlugin.fromClass(ClockView, {
	decorations: (value) => value.decorations,
});

interface BetterBujoSettings {
	strikeDoneTasks: boolean;
	dottedGrid: boolean;
	gridSpacing: number;
}

const DEFAULT_SETTINGS: BetterBujoSettings = {
	strikeDoneTasks: false,
	dottedGrid: false,
	gridSpacing: 20,
};

export default class BetterBujoPlugin extends Plugin {
	settings: BetterBujoSettings = DEFAULT_SETTINGS;

	// Every document we've tagged, so unload can untag pop-out windows too.
	private styledDocs = new Set<Document>();

	// Reading-mode marker checkboxes (events, in-progress) → the edit each one
	// applies on click. Bound in the post-processor, where the section context
	// needed to locate the source line lives; consumed by the document-level
	// click handler.
	private readingToggles = new WeakMap<HTMLElement, () => Promise<void>>();

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as Partial<BetterBujoSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		this.addSettingTab(new BetterBujoSettingTab(this.app, this));
		// All glyph styling is scoped under this class so disabling the plugin
		// fully reverts to Obsidian's native rendering. Pop-out windows have
		// their own <body>, so tag the main window, any windows already open
		// (plugin enabled mid-session), and each window opened later.
		this.styleDoc(activeDocument);
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves((leaf) => {
				this.styleDoc(leaf.view.containerEl.ownerDocument);
			});
		});
		this.registerEvent(
			this.app.workspace.on('window-open', (win) => {
				this.styleDoc(win.doc);
			})
		);

		// Reading mode: tag `~ ` paragraphs so styles.css can style them, and
		// move the `~` into a marker span so it can sit in the marker column.
		this.registerMarkdownPostProcessor((el, ctx) => {
			// Bind a click action to each event/in-progress checkbox. The section
			// info is resolved at click time, so line numbers stay correct after
			// edits. Events cycle o ↔ O; in-progress completes to x.
			const bindReading = (
				selector: string,
				regex: RegExp,
				next: (cur: string) => string
			): void => {
				for (const input of Array.from(el.querySelectorAll<HTMLInputElement>(selector))) {
					this.readingToggles.set(input, async () => {
						const info = ctx.getSectionInfo(el);
						const file = this.app.vault.getFileByPath(ctx.sourcePath);
						if (!info || !file) {
							return;
						}
						const lineNo = info.lineStart + Number(input.dataset.line ?? '0');
						await this.app.vault.process(file, (data) => setMarker(data, lineNo, regex, next));
					});
				}
			};
			bindReading(
				':is(li[data-task="o"], li[data-task="O"], li[data-task="p"]) > input.task-list-item-checkbox, ' +
					':is(li[data-task="o"], li[data-task="O"], li[data-task="p"]) > p > input.task-list-item-checkbox',
				EVENT_MARKER,
				cycleEvent
			);
			// Open tasks carry no data-task (or an empty/space one), so match those
			// plus the in-progress/done markers to cover the whole task cycle.
			const taskStates = ':is(:not([data-task]), [data-task=""], [data-task=" "], [data-task="/"], [data-task="x"], [data-task="X"])';
			bindReading(
				`li.task-list-item${taskStates} > input.task-list-item-checkbox, ` +
					`li.task-list-item${taskStates} > p > input.task-list-item-checkbox`,
				TASK_MARKER,
				cycleTask
			);

			for (const p of Array.from(el.querySelectorAll('p'))) {
				const first = p.firstChild;
				if (first?.nodeType !== Node.TEXT_NODE) {
					continue;
				}
				const text = first.textContent ?? '';
				if (!EMOTION_LINE.test(text)) {
					continue;
				}
				p.addClass('bb-emotion');
				const marker = p.ownerDocument.createElement('span');
				marker.className = 'bb-emotion-marker';
				marker.textContent = '~';
				first.textContent = text.replace(EMOTION_LINE, '');
				p.insertBefore(marker, first);
			}

			// Time-based events: tag `- [9:30 AM] …` items and drop the brackets
			// so styles.css can draw a clock on the bullet, leaving the time text.
			for (const li of Array.from(el.querySelectorAll('li:not(.task-list-item)'))) {
				const host = li.firstElementChild instanceof HTMLParagraphElement ? li.firstElementChild : li;
				let node: ChildNode | null = host.firstChild;
				while (node && node.nodeType !== Node.TEXT_NODE) {
					node = node.nextSibling;
				}
				const text = node?.textContent ?? '';
				const match = TIME_EVENT_TEXT.exec(text);
				if (!node || !match) {
					continue;
				}
				li.addClass('bb-clock');
				node.textContent = text.replace(TIME_EVENT_TEXT, match[1] ?? '');
			}
		});

		// Live Preview / Source mode equivalents.
		this.registerEditorExtension([emotionExtension, clockExtension]);

		// A command per bullet type (so each can take a hotkey) plus a
		// right-click submenu — both rewrite the selected line(s) to that type.
		for (const type of BULLET_TYPES) {
			this.addCommand({
				id: `set-${type.id}`,
				name: `Change bullet to: ${type.name}`,
				editorCallback: (editor) => this.setBulletType(editor, type.marker),
			});
		}
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor) => {
				menu.addItem((item) => {
					item.setTitle('Change bullet type').setIcon('list');
					const submenu = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();
					for (const type of BULLET_TYPES) {
						submenu.addItem((sub) =>
							sub.setTitle(type.name).onClick(() => this.setBulletType(editor, type.marker))
						);
					}
				});
			})
		);
	}

	onunload(): void {
		for (const doc of this.styledDocs) {
			doc.body.classList.remove('better-bujo', 'bb-strike-done', 'bb-dotted-grid');
			doc.body.style.removeProperty('--bb-grid-spacing');
		}
		this.styledDocs.clear();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Re-apply setting-dependent classes everywhere.
		for (const doc of this.styledDocs) {
			this.styleDoc(doc);
		}
	}

	private styleDoc(doc: Document): void {
		doc.body.classList.add('better-bujo');
		doc.body.classList.toggle('bb-strike-done', this.settings.strikeDoneTasks);
		doc.body.classList.toggle('bb-dotted-grid', this.settings.dottedGrid);
		doc.body.style.setProperty('--bb-grid-spacing', `${this.settings.gridSpacing}px`);
		if (!this.styledDocs.has(doc)) {
			this.styledDocs.add(doc);
			// Capture phase, so this runs before Obsidian's own checkbox
			// handling — which would toggle [o]/[O] to [ ]/[x].
			this.registerDomEvent(doc, 'click', (evt) => this.onDocClick(evt), {
				capture: true,
			});
		}
	}

	// Intercept clicks on markers the plugin owns: events cycle [o]→[p]→[O],
	// tasks cycle [ ]→[/]→[x]. Open tasks carry no data-task. Other markers
	// (>, <, ~, -) fall through to Obsidian.
	private onDocClick(evt: MouseEvent): void {
		const input = evt.target;
		if (!(input instanceof HTMLInputElement) || !input.classList.contains('task-list-item-checkbox')) {
			return;
		}
		const marker = input.closest('[data-task]')?.getAttribute('data-task');
		let regex: RegExp;
		let next: (cur: string) => string;
		if (marker === 'o' || marker === 'O' || marker === 'p') {
			regex = EVENT_MARKER;
			next = cycleEvent;
		} else if (marker == null || marker === '' || marker === ' ' || marker === '/' || marker === 'x' || marker === 'X') {
			regex = TASK_MARKER;
			next = cycleTask;
		} else {
			return;
		}
		evt.preventDefault();
		evt.stopImmediatePropagation();
		const readingToggle = this.readingToggles.get(input);
		if (readingToggle) {
			void readingToggle();
			return;
		}
		this.editMarkerInEditor(input, regex, next);
	}

	// Live Preview: locate the editor that rendered this checkbox and rewrite
	// the marker character on its line.
	private editMarkerInEditor(input: HTMLElement, regex: RegExp, next: (cur: string) => string): void {
		const view = this.findMarkdownView(input);
		if (!view) {
			return;
		}
		const editor = view.editor;
		// Editor.cm (the underlying EditorView) is not in the public typings,
		// but is the only way to map a DOM node back to a document position.
		const cm = (editor as unknown as { cm: EditorView }).cm;
		const lineNo = cm.state.doc.lineAt(cm.posAtDOM(input)).number - 1;
		const match = regex.exec(editor.getLine(lineNo));
		if (!match) {
			return;
		}
		const ch = (match[1] ?? '').length;
		editor.replaceRange(next(match[2] ?? ''), { line: lineNo, ch }, { line: lineNo, ch: ch + 1 });
	}

	// Rewrite every line touched by the selection (or the cursor line) to the
	// given bullet type.
	private setBulletType(editor: Editor, marker: string | null): void {
		const from = editor.getCursor('from').line;
		const to = editor.getCursor('to').line;
		for (let line = from; line <= to; line++) {
			const next = applyBulletType(editor.getLine(line), marker);
			if (next !== editor.getLine(line)) {
				editor.setLine(line, next);
			}
		}
	}

	private findMarkdownView(el: HTMLElement): MarkdownView | null {
		let found: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(el)) {
				found = leaf.view;
			}
		});
		return found;
	}
}

class BetterBujoSettingTab extends PluginSettingTab {
	plugin: BetterBujoPlugin;

	constructor(app: App, plugin: BetterBujoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Strike through completed tasks')
			.setDesc('Draw a line through the text of completed tasks.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.strikeDoneTasks)
					.onChange(async (value) => {
						this.plugin.settings.strikeDoneTasks = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Dotted grid')
			.setDesc('Show a dotted grid background that scrolls with the page, like dot-grid paper.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.dottedGrid)
					.onChange(async (value) => {
						this.plugin.settings.dottedGrid = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Grid spacing')
			.setDesc('Distance between dots, in pixels. Smaller values make a tighter grid.')
			.addSlider((slider) =>
				slider
					.setLimits(10, 50, 1)
					.setValue(this.plugin.settings.gridSpacing)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.gridSpacing = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
