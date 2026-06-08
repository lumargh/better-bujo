// TODO
// Add right-click functionality on all bullets. Reveals menu that allows users to change a bullet's type. 
// Clicking an open event turns it into a completed event. Clicking a completed event toggles back to open event.

import { Plugin } from 'obsidian';
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

// ---- Live Preview / Source mode: tag `~ ` lines for styling. -----------------

const emotionLine = Decoration.line({ class: 'bb-emotion' });

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

export default class BetterBujoPlugin extends Plugin {
	onload(): void {
		// All glyph styling is scoped under this class so disabling the plugin
		// fully reverts to Obsidian's native rendering.
		activeDocument.body.classList.add('better-bujo');

		// Reading mode: tag `~ ` paragraphs so styles.css can style them.
		this.registerMarkdownPostProcessor((el) => {
			for (const p of Array.from(el.querySelectorAll('p'))) {
				if (EMOTION_LINE.test(p.textContent ?? '')) {
					p.addClass('bb-emotion');
				}
			}
		});

		// Live Preview / Source mode equivalent.
		this.registerEditorExtension(emotionExtension);
	}

	onunload(): void {
		activeDocument.body.classList.remove('better-bujo');
	}
}
