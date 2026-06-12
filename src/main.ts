// TODO
// Add commands for all bullets -- command allows you to change bullets to another type.
// Add right-click functionality on all bullets. Reveals menu that allows users to change a bullet's type. 

import { App, MarkdownView, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { RangeSetBuilder } from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
} from '@codemirror/view';

// A line that conveys an emotion or a thought, e.g. `~ feeling restless`.
// The `~` glyph renders as itself; the plugin only marks the line so styles.css
// can give it a distinct (muted/italic) look. The actual marker glyphs for
// tasks/events/migration are handled entirely in styles.css, keyed on the
// `data-task` attribute Obsidian sets on each list item — see that file for the
// canonical glyph table.
const EMOTION_LINE = /^~\s/;

// Matches the `- [o]` / `- [O]` lead of an event line; group 1 is everything
// before the marker character, group 2 the marker itself.
const EVENT_MARKER = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([oO])\]/;

// Flip the event marker (o ↔ O) on the given line of a note's contents.
function toggleEventLine(data: string, lineNo: number): string {
	const lines = data.split('\n');
	const line = lines[lineNo] ?? '';
	const match = EVENT_MARKER.exec(line);
	if (!match) {
		return data;
	}
	const markerAt = (match[1] ?? '').length;
	const flipped = match[2] === 'o' ? 'O' : 'o';
	lines[lineNo] = line.slice(0, markerAt) + flipped + line.slice(markerAt + 1);
	return lines.join('\n');
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

interface BetterBujoSettings {
	strikeDoneTasks: boolean;
}

const DEFAULT_SETTINGS: BetterBujoSettings = {
	strikeDoneTasks: false,
};

export default class BetterBujoPlugin extends Plugin {
	settings: BetterBujoSettings = DEFAULT_SETTINGS;

	// Every document we've tagged, so unload can untag pop-out windows too.
	private styledDocs = new Set<Document>();

	// Reading-mode event checkboxes → their toggle actions. Bound in the
	// post-processor, where the section context needed to locate the source
	// line lives; consumed by the document-level click handler.
	private readingEventToggles = new WeakMap<HTMLElement, () => Promise<void>>();

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
			// Bind a toggle action to each event checkbox. The section info is
			// resolved at click time, so line numbers stay correct after edits.
			const eventBoxes = el.querySelectorAll<HTMLInputElement>(
				':is(li[data-task="o"], li[data-task="O"]) > input.task-list-item-checkbox, ' +
					':is(li[data-task="o"], li[data-task="O"]) > p > input.task-list-item-checkbox'
			);
			for (const input of Array.from(eventBoxes)) {
				this.readingEventToggles.set(input, async () => {
					const info = ctx.getSectionInfo(el);
					const file = this.app.vault.getFileByPath(ctx.sourcePath);
					if (!info || !file) {
						return;
					}
					const lineNo = info.lineStart + Number(input.dataset.line ?? '0');
					await this.app.vault.process(file, (data) => toggleEventLine(data, lineNo));
				});
			}

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
		});

		// Live Preview / Source mode equivalent.
		this.registerEditorExtension(emotionExtension);
	}

	onunload(): void {
		for (const doc of this.styledDocs) {
			doc.body.classList.remove('better-bujo', 'bb-strike-done');
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
		if (!this.styledDocs.has(doc)) {
			this.styledDocs.add(doc);
			// Capture phase, so this runs before Obsidian's own checkbox
			// handling — which would toggle [o]/[O] to [ ]/[x].
			this.registerDomEvent(doc, 'click', (evt) => this.onDocClick(evt), {
				capture: true,
			});
		}
	}

	// Clicking an event marker cycles it: [o] ↔ [O].
	private onDocClick(evt: MouseEvent): void {
		const input = evt.target;
		if (!(input instanceof HTMLInputElement) || !input.classList.contains('task-list-item-checkbox')) {
			return;
		}
		const marker = input.closest('[data-task]')?.getAttribute('data-task');
		if (marker !== 'o' && marker !== 'O') {
			return;
		}
		evt.preventDefault();
		evt.stopImmediatePropagation();
		const readingToggle = this.readingEventToggles.get(input);
		if (readingToggle) {
			void readingToggle();
			return;
		}
		this.toggleEventInEditor(input);
	}

	// Live Preview: locate the editor that rendered this checkbox and flip the
	// marker character on its line.
	private toggleEventInEditor(input: HTMLElement): void {
		const view = this.findMarkdownView(input);
		if (!view) {
			return;
		}
		const editor = view.editor;
		// Editor.cm (the underlying EditorView) is not in the public typings,
		// but is the only way to map a DOM node back to a document position.
		const cm = (editor as unknown as { cm: EditorView }).cm;
		const lineNo = cm.state.doc.lineAt(cm.posAtDOM(input)).number - 1;
		const match = EVENT_MARKER.exec(editor.getLine(lineNo));
		if (!match) {
			return;
		}
		const ch = (match[1] ?? '').length;
		editor.replaceRange(
			match[2] === 'o' ? 'O' : 'o',
			{ line: lineNo, ch },
			{ line: lineNo, ch: ch + 1 }
		);
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
	}
}
