# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension ("LinkedIn AI Comment Companion") that injects AI comment/reply buttons into the LinkedIn feed and generates suggestions via the Gemini API.

**No build step, no bundler, no package.json, no test suite.** The files in the repo root *are* the shipped extension.

## Development

- Load: `chrome://extensions` → Developer mode → "Load unpacked" → repo root.
- After editing `content.js`/`manifest.json`: click Reload on the extension card, then hard-reload the LinkedIn tab.
- After editing `sidebar.html`/`sidebar.js`/`styles.css`: the iframe reloads with the page, so a tab refresh is usually enough.
- Debugging: content script logs to the LinkedIn page console with the `[LN-AI]` prefix (`DEBUG` flag at the top of [content.js](content.js)). Sidebar logs go to a *separate* console — inspect the iframe (right-click inside the panel → Inspect) or pick the `sidebar.html` context in DevTools.
- Testing changes is manual: open the LinkedIn feed, confirm buttons appear on posts and next to comments, open the panel, generate. The one automated check is `node test.js` (asserts the `srcset` parser in `content.js`); there is no framework and no runner.
- **The sidebar can be driven without LinkedIn or Chrome.** Copy `sidebar.html`/`sidebar.js`/`styles.css`/`icons/` to a temp dir, inject a stub for the two `chrome.*` APIs it touches before the `sidebar.js` tag, serve over `http://` (not `file://`), and drive it by posting `LN_AI_POST_DATA` messages with a fake post object:

  ```js
  window.chrome = {
      storage: { sync: { get: (k, cb) => cb({}), set: () => {} } },
      runtime: { getURL: (p) => p },
  };
  ```

  This is how the image strip, the prompt preview, and both themes get checked; scraping changes in `content.js` still need a real logged-in feed.

## Architecture

Two isolated JS contexts talking over `window.postMessage`:

```
content.js  (LinkedIn page, content script)
    │  scrapes post/comment DOM → JSON
    │  postMessage LN_AI_POST_DATA ──────────►  sidebar.js  (iframe, extension origin)
    │  ◄────────── LN_AI_CLOSE_SIDEBAR                │  builds prompt, calls Gemini
    │  ◄────────── LN_AI_THEME                        │  renders suggestion cards
```

- `content.js` creates a single fixed-position iframe (`sidebar.html`) once, slides it in/out with `style.right`. `chrome.*` APIs are only used for `runtime.getURL` and `storage.sync`; there is **no background/service worker** — the Gemini `fetch` happens in the sidebar iframe, which is why `generativelanguage.googleapis.com` is in `host_permissions`.
- **All network calls belong in `sidebar.js`, not `content.js`.** The sidebar is an extension-origin document, so `host_permissions` lets it fetch cross-origin; an MV3 content-script fetch uses the *page's* origin and is still subject to CORS. This is why post images (`https://*.licdn.com/*`) are downloaded and base64'd in `fetchImageParts()` rather than in the scraper.
- The panel never writes into LinkedIn's comment box; output is copy-to-clipboard only. `sidebarIframe.allow = "clipboard-write"` is required for that, plus a `document.execCommand` fallback in `copyToClipboard`.
- Theme lives in the sidebar; it messages `LN_AI_THEME` back so the content script repaints the iframe shell background and avoids a white flash.

### DOM scraping (the fragile part)

LinkedIn ships fully hashed CSS classes and varies attributes per account/experiment, so **never anchor on class names**. The existing anchors, all deliberate:

- **Posts**: `[aria-label^="Open control menu for post by"]` marks a real post across every feed variant; `resolvePostContainer()` climbs to the outermost container via a priority list (`[role="listitem"]` first).
- **Author name**: parsed out of that same control-menu aria-label.
- **Headline**: `getHeadline()` is *positional* — first qualifying text line after the author link, before the timestamp — with explicit SKIP (Follow/Promoted/…) and STOP (timestamp/engagement row) regexes. Keyword guessing was tried and leaked "Suggested"/"Following"; don't reintroduce it.
- **Comments**: `button[aria-label="Reply"]` is the per-comment marker (posts don't have one); `commentScopeFrom()` walks up ≤15 levels to the first ancestor holding both an `[data-testid="expandable-text-box"]` and a `View <Name>'s profile` avatar.
- **Post/comment body text**: `[data-testid="expandable-text-box"]` (same testid for both — always scope it).

Injection idempotency: posts are marked `data-ln-ai-injected="1"`, reply buttons `dataset.lnAiReplyDone = "1"`. A `MutationObserver` on `document.body` plus a 10-tick / 1.5s interval covers feed hydration and infinite scroll.

### Sidebar

- Settings (`chrome.storage.sync`, key `ln_ai_settings`): API key, model, theme, "about me" experience blurb, and the user-editable comment **styles** array. `defaultStyles()` seeds five built-ins **only on first run** — an empty `styles` array means the user deleted them all, so don't re-seed it.
- `RETIRED_MODELS` silently upgrades stored ids Google has dropped. When the model dropdown in [sidebar.html](sidebar.html) changes, add the old ids there and keep `SETTINGS_DEFAULTS.model` in sync with the recommended option.
- **The prompt mentions media in exactly one place** — the image block after `Post text:`, emitted only when images are actually attached. A `Media:` line built from the scraped `mediaType` used to sit in the post-context block and printed regardless, so a post whose images were withheld still announced them and the model invented their contents. Media the model isn't given must not appear in the prompt at all.
- The panel shows the post's images as a thumbnail strip with a "Send to AI" checkbox (`settings.sendImages`, persisted, default on). Unticking it drops the images from the request *and* the image block from the prompt preview — `imageUrlsToSend()` is the single gate both read, so they can't drift apart.
- Post images are sent to Gemini as extra `contents[].parts[]` entries (`{inline_data: {mime_type, data}}`) alongside the prompt text, capped at 4 images / 4MB each (the API's ceiling is 20MB for the whole request). Image failures are never fatal — `fetchImageParts()` swallows them and generation continues text-only with a status note. Reply mode inherits the parent post's images for free via `currentImageUrls()`.
- A post with no body text yields `text: ""` on purpose (there used to be a `post.innerText` fallback; it scraped feed chrome and the model treated it as the post). `buildPrompt()` reads that empty string as "the attached image IS the post" and prompts accordingly.
- `buildPrompt()` is the heart of the product: one function producing both comment and reply prompts (`currentMode`), assembling ABOUT ME / post context / comment being replied to / the user's own draft, then one numbered instruction per enabled style. It ends by demanding `"1. StyleName: ..."` lines — `parseStyledComments()` parses exactly that shape, so **changing the output format instruction means changing the parser**.
- `callGemini()` retries 429/500/503 and network errors 3× with jittered backoff, and surfaces `MAX_TOKENS` truncation and safety blocks as user-visible status text rather than failing silently. `friendlyError()` maps statuses to actionable messages.

## Conventions

- Vanilla ES modules-free JS, 4-space indent, double quotes, no dependencies. Keep it that way — adding a build step means the "load unpacked" workflow above stops matching reality.
- All extension-owned DOM uses the `ln-ai-` class/id prefix so it can't collide with LinkedIn's.
- The scraping code is comment-heavy on purpose: each selector's comment records *why* that anchor survives LinkedIn's churn. Update the comment when you change the selector.

## Assets

`icons/` holds the extension logo: a white speech bubble with a sparkle on LinkedIn blue, generated
with Higgsfield (`nano_banana_pro`). `icon512.png` is the master; the manifest sizes are derived from
it, and the transparent rounded-square corners were masked in with ffmpeg (no ImageMagick or Pillow on
this machine). To regenerate the sizes after replacing the master:

```sh
for s in 128 48 32 16; do
  ffmpeg -v error -y -i icons/icon512.png -vf "scale=${s}:${s}:flags=lanczos" -frames:v 1 "icons/icon${s}.png"
done
```

The sidebar header and favicon reference `icons/` with plain relative paths — `sidebar.html` is an
extension-origin page, so it needs no `web_accessible_resources` entry. The in-page buttons injected by
`content.js` still use the 🤖 emoji; switching those to the image *would* need a `web_accessible_resources`
entry, since they render in the LinkedIn page's origin.
