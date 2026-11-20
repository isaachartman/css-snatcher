# Computed-to-Clean CSS Snatcher

A small Chrome extension that turns any element's computed styles into clean, minimal CSS. Click an element and get a handful of meaningful declarations instead of a 400-line computed-style dump.

## Features

- Click any element on the page; a panel shows its CSS, ready to **Copy**
- **Defaults removed**: values are diffed against a pristine element of the same tag
- **Inherited values removed** when they match the parent (toggle: *Keep inherited*)
- **Layout noise removed**: resolved `width`/`height`/`top`/`left` are kept only when a stylesheet or inline style actually set them (toggle: *Keep sizes*); authored `margin: auto` is restored
- **Shorthands collapsed**: `margin`, `padding`, `border`, `border-radius`, `overflow`, `gap`, `flex`, `inset`, `outline`, `text-decoration`, `transition`
- **Values tidied**: `rgb()` to hex, `0px` to `0`, rounded decimals, sensible property order
- Output as **CSS**, inline `style=""`, a **React** style object, or **Tailwind** classes
- Optional `::before` / `::after` rules, and **Include children** to snatch a whole subtree
- **↑ Parent** walks up the DOM from the picked element
- Options are remembered between uses
- Works offline and sends nothing anywhere
- Styled after the Teenage Engineering K.O. II

## Install

The extension isn't on the Chrome Web Store, so load it unpacked:

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder.
4. Pin the extension from the puzzle-piece menu, then click it (or press **Alt+Shift+S**) on any page and click an element. **Esc** cancels.

## Notes

- Permissions: `activeTab` and `scripting` to inject the picker when you click the icon, `storage` for your options, `clipboardWrite` for the Copy button.
- Doesn't run on `chrome://` pages or the Web Store; Chrome blocks content scripts there.
- Cross-origin stylesheets can't be read, so their authored sizes can't be detected; turn on *Keep sizes* for those pages.
- Tailwind output is best-effort and covers only the picked element: common properties become utilities, the rest become arbitrary `[prop:value]` classes.
- `test/test.html` loads `content.js` as a page script for manual testing (`window.__cssSnatcher.snatch(el)`).
- Icons are generated with `python3 make_icons.py` (standard library only).

## License

[MIT](LICENSE)
