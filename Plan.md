# Plan: send post images to Gemini as visual context

## The problem

`extractPostData()` already scrapes image URLs into `post.images`, but nothing downstream uses them.
`buildPrompt()` never mentions them and `callGemini()` sends a single text part. So an image-only
post reaches the model as an empty (or garbage) `Post text:` block, and the suggestions are generic.

Two things compound it on the case you hit:

1. **Reply mode drops images too.** `extractCommentData()` pulls the parent post via `extractPostData()`,
   so the URLs are there — they just go nowhere.
2. **Text-less posts fall back to junk.** `content.js:~270` does
   `if (!text) text = (post.innerText || "").trim().slice(0, 3000)`, which sweeps in the author block,
   "Follow", reaction counts, and comment previews. The model then treats that chrome as the post body.

## Feasibility (verified)

- **Fetching the bytes works.** `media.licdn.com` responds with `Access-Control-Allow-Origin: *`.
  Regardless, the fetch will run in `sidebar.js`, which is an extension-origin document — with
  `https://*.licdn.com/*` in `host_permissions`, Chrome bypasses CORS there entirely. This is why the
  fetch must **not** move into `content.js`: MV3 content-script fetches use the *page's* origin and
  stay subject to CORS.
- **Gemini takes images as extra parts** on the same `v1beta/…:generateContent` endpoint already in use:
  ```json
  { "contents": [ { "role": "user", "parts": [
      { "text": "<the existing prompt>" },
      { "inline_data": { "mime_type": "image/jpeg", "data": "<base64>" } }
  ] } ] }
  ```
  Total request (text + inline bytes) must stay under 20MB. Accepted types: `image/png`, `image/jpeg`,
  `image/webp`, `image/heic`, `image/heif`.
- **The models in the dropdown are multimodal.** `gemini-3.7-flash`, `gemini-3.6-flash` and
  `gemini-3.5-flash-lite` all accept image input, so no model gating is needed.

**Not verified:** whether `content.js`'s image filter actually matches your feed's DOM — Playwright hits
LinkedIn's authwall, so I could not read a logged-in feed. Step 0 below settles it in ten seconds.

## Step 0 — confirm the URLs are being captured (do this first)

Open the post that failed, click **AI Comment**, and look at the JSON block at the top of the panel.

- `images: ["https://media.licdn.com/..."]` → the scraper is fine, go straight to Phase 1.
- `images: []` but `mediaType` is `"image"`/`"images"` → the filter is too narrow; Phase 0 applies.
- `mediaType: "none"` on a post that clearly has an image → Phase 0 applies.

## Phase 0 — widen image detection (only if Step 0 says so)

`content.js`, in `extractPostData()`:

```js
.filter((img) => /feedshare|feedimage/i.test(img.src) || img.alt === "View image")
```

This matches two URL slugs and one exact English alt string. Widen it to reject avatars/logos rather
than allow-list URL slugs, which is the same anchoring rule the rest of the scraper follows:

- Drop anything inside an `a[href*="/in/"]` or a `[aria-label^="View "]` (avatars).
- Drop `img.naturalWidth < 200` (icons, logos, tracking pixels).
- Prefer the largest candidate in `img.srcset` over `img.src` — LinkedIn lazy-loads a low-res
  placeholder first, and a 100px thumbnail is worth little to the model.
- Keep the existing `feedshare|feedimage` matches as a fast path.

## Phase 1 — carry images into the request

### 1a. `manifest.json`

Add `"https://*.licdn.com/*"` to `host_permissions`. Nothing else changes; no service worker needed.

### 1b. `sidebar.js` — fetch and encode

New helper near `callGemini()`:

```js
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const OK_IMAGE_TYPES = /^image\/(png|jpeg|webp|heic|heif)$/;
```

`async function fetchImageParts(urls)`:
- take the first `MAX_IMAGES` urls
- `fetch(url)` → `blob()`, run them with `Promise.allSettled` so one dead URL can't sink the batch
- skip blobs failing `OK_IMAGE_TYPES` or over `MAX_IMAGE_BYTES`
- base64 via `FileReader.readAsDataURL`, then strip the `data:...;base64,` prefix
- return `[{ inline_data: { mime_type, data } }]`, `[]` on total failure

### 1c. `sidebar.js` — send them

`callGemini(prompt)` becomes `callGemini(prompt, imageParts = [])` and builds
`parts: [{ text: prompt }, ...imageParts]`. The retry/backoff loop, `friendlyError`,
`RETRYABLE_STATUS` and `parseStyledComments` are all untouched — `body` is just computed once with
the extra parts.

In `fetchComments()`, after the existing guards:

```js
const imageUrls = (currentPost && currentPost.images) || [];   // reply mode included
let imageParts = [];
if (imageUrls.length) {
    setStatus("Reading post image…");
    imageParts = await fetchImageParts(imageUrls);
}
```

`currentPost` is the parent post in reply mode, so replies get the image for free — that is exactly
your case.

### 1d. `sidebar.js` — tell the model the images are there

`buildPrompt()` gains a small block, placed right after the `Post text:` fence. It needs the count,
so pass it in (`buildPrompt(post, experience, take, imageCount)`) rather than re-deriving it.

- When there are images and the post has real text:
  `N image(s) from this post are attached. Use what they show as part of the context.`
- When there are images and the post text is empty or boilerplate:
  `This post has no meaningful text — the attached image(s) ARE the post. Base the comment on what
   they actually show, and reference a specific detail from them.`

The style rules, the `"1. StyleName: ..."` output contract, and `parseStyledComments()` all stay as
they are.

Note: `renderPrompt()` shows the prompt preview before any fetch happens, so it should render the
image line from `currentPost.images.length` — the preview then honestly reflects what will be sent.

### 1e. Fix the text fallback (`content.js`)

Replace the `post.innerText.slice(0, 3000)` fallback with `text = ""`. It was a guess that mostly
injects feed chrome, and with images attached it now actively competes with the real signal. An
honest empty body is what triggers the stronger "the image IS the post" prompt above.

## Phase 2 — failure handling

- Any image fetch failing → proceed text-only, and append to the status line:
  `Couldn't load the post image; generated from text only.` Never block generation on an image.
- Video posts: `mediaType === "video"` yields no frames. Out of scope — say so in the status
  (`Video posts aren't read yet`) rather than silently producing a generic comment.
- The `MAX_TOKENS` / `SAFETY` / `blockReason` handling in `fetchComments()` already covers the new
  failure surface; images make `SAFETY` blocks somewhat more likely, and that path already reports.

## Phase 3 — verification (manual, in your browser)

No test harness exists in this repo, so:

1. Reload the unpacked extension, hard-reload the LinkedIn tab.
2. **Image-only post** — the one that failed. JSON shows `images: [...]`; prompt preview shows the
   "the attached image(s) ARE the post" line; suggestions name something visible in the image.
3. **Reply on that post** — same, with the image carried through as parent-post context.
4. **Text-only post** — no image line in the prompt, no extra latency, output unchanged from today.
5. **Carousel / multi-image post** — capped at 4, no request error.
6. **Video post** — falls back cleanly with the status note.
7. Sidebar console (right-click in the panel → Inspect): no CORS errors on `media.licdn.com`.

Quick pre-flight you can run from the **sidebar iframe's** console (not the page console) once
`host_permissions` is updated, pasting a real image URL from the JSON block:

```js
fetch("<media.licdn.com URL>").then(r => r.blob()).then(b => console.log(b.type, b.size));
```

Expect something like `image/jpeg 184213`. A CORS error here means Phase 1a did not take effect —
reload the extension from `chrome://extensions`.

## Deliberately skipped

- **A settings toggle for images.** Default it on. Add the checkbox only if the extra latency or free-tier
  quota turns out to bother you.
- **Client-side downscaling via canvas.** The 4-image / 4MB caps keep requests well under the 20MB
  limit; add resizing only if real posts start tripping it.
- **Files API uploads.** Only needed above 20MB, which a feed image never is.
- **Video frame extraction.** Meaningfully harder than images; separate piece of work.

## Files touched

| File | Change |
|---|---|
| `manifest.json` | add `https://*.licdn.com/*` host permission |
| `content.js` | widen image filter (Phase 0, conditional); drop the `innerText` text fallback |
| `sidebar.js` | `fetchImageParts()`; `callGemini` takes image parts; `buildPrompt` image block; status handling |

`sidebar.html` and `styles.css` are unchanged unless the optional toggle is added.
