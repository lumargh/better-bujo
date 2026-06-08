# Better Bujo

Render bullet-journal (BuJo) markers in your notes instead of Obsidian's
checkboxes — in both **Reading mode** and **Live Preview**.

## Markers

At the beginning of a line:

| You type   | Renders as | Meaning                       |
| ---------- | ---------- | ----------------------------- |
| `- item`   | `–`        | Plain note (a dash, not a bullet) |
| `- [ ]`    | `•`        | Open task                     |
| `- [x]`    | `x`        | Done                          |
| `- [>]`    | `>`        | Migrated to the month note    |
| `- [<]`    | `<`        | Sent to the future log        |
| `- [o]`    | `⊙`        | Event                         |
| `- [O]`    | `⊗`        | Completed event               |
| `~ ...`    | `~` (styled) | An emotion or a thought     |

## How it works

The marker glyphs are pure CSS, keyed on the `data-task` attribute Obsidian
sets on each list item, so they render identically in Reading mode and Live
Preview. Emotion lines (`~ …`) are tagged by a small markdown post-processor
and a CodeMirror extension so they can be styled.

All styling is scoped under a `better-bujo` body class — disabling the
plugin restores Obsidian's native rendering.

## Acknowledgements

Inspired by [obsidian-bujo-bullets](https://github.com/frankolson/obsidian-bujo-bullets) by Frank Olson — a great starting point for BuJo-style checkboxes in Obsidian.

## My other Obsidian plugins

- **[Date List](https://github.com/lumargh/obsidian-date-list)** — Returns a list of dates according to the conditions you supply.
- **[Calendar List](https://github.com/lumargh/obsidian-calendar-list)** — Insert macOS Calendar events into your notes.
- **[File Filter](https://github.com/lumargh/obsidian-file-filter)** — Filter your pages and sidebar by a search term; everything else fades away.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # production build + type-check
npm run lint
```
