// LinkedIn AI Comment Companion - content script
// Attaches a floating "AI Comment" button to every feed post. Clicking it opens
// a sidebar and loads that post's text so an API can suggest comments.
//
// We deliberately avoid depending on LinkedIn's frequently-renamed CSS classes
// for placement. Posts are detected by their stable activity data-attributes,
// and the button is positioned on the post container itself.

const DEBUG = true;
const log = (...args) => DEBUG && console.log("[LN-AI]", ...args);

// LinkedIn's feed uses fully obfuscated (hashed) CSS classes, and which
// attributes land on the post element varies between accounts/experiments — some
// feeds carry `componentkey` on the post, others don't. The one marker present on
// every real post across variants is its control-menu button, whose aria-label
// reads "Open control menu for post by <name>". We anchor on that and climb to
// the post container, rather than matching the post element directly.
const POST_MENU_SELECTOR = '[aria-label^="Open control menu for post by"]';

// Candidate outermost-post containers, tried in priority order so we normalize to
// the whole post (the list item) instead of a nested wrapper. `[role="listitem"]`
// is the post row in current feeds; the rest cover older/other variants.
const POST_CONTAINER_SELECTORS = [
    '[role="listitem"]',
    "div.feed-shared-update-v2",
    '[data-id^="urn:li:activity"]',
    '[data-urn^="urn:li:activity"]',
    "[componentkey]",
];

// Climb from any element to its post container, preferring the widest match.
function resolvePostContainer(el) {
    for (const sel of POST_CONTAINER_SELECTORS) {
        const found = el.closest(sel);
        if (found) return found;
    }
    return null;
}

// LinkedIn encodes reaction types in the SVG ids of the "reactions" ring row.
const REACTION_NAMES = {
    like: "Like",
    praise: "Celebrate",
    empathy: "Support",
    interest: "Insightful",
    entertainment: "Funny",
    appreciation: "Love",
    love: "Love",
    maybe: "Curious",
};

let sidebarIframe = null;

// --- Sidebar ---------------------------------------------------------------

// Keep the iframe shell background in sync with the sidebar's theme so there's
// no white flash behind the panel while it slides in (or in dark mode).
function shellBg(theme) {
    return theme === "dark" ? "#1b1f23" : "#ffffff";
}

function applyIframeTheme(theme) {
    if (sidebarIframe) sidebarIframe.style.backgroundColor = shellBg(theme);
}

function createSidebar() {
    if (sidebarIframe) return;

    sidebarIframe = document.createElement("iframe");
    sidebarIframe.src = chrome.runtime.getURL("sidebar.html");
    sidebarIframe.id = "ln-ai-sidebar";
    // Required so the clipboard API works inside this cross-origin iframe.
    sidebarIframe.allow = "clipboard-write";

    Object.assign(sidebarIframe.style, {
        position: "fixed",
        top: "0",
        right: "-420px",
        width: "400px",
        height: "100%",
        zIndex: "2147483647",
        border: "none",
        boxShadow: "-4px 0 12px rgba(0,0,0,0.15)",
        transition: "right 0.3s ease",
        backgroundColor: "#ffffff",
    });

    // Paint the shell with the last-known theme before the sidebar reports in.
    try {
        chrome.storage.sync.get("ln_ai_settings", (res) => {
            const s = res && res.ln_ai_settings;
            if (!s || !s.theme || s.theme === "system") {
                const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
                applyIframeTheme(dark ? "dark" : "light");
            } else {
                applyIframeTheme(s.theme);
            }
        });
    } catch {
        // storage unavailable; keep the default white shell
    }

    document.body.appendChild(sidebarIframe);
    log("sidebar iframe created");
}

// payload: { mode: "comment"|"reply", post, comment }. The sidebar can be slow
// to boot, so we resend a few times until its listener is ready.
function toggleSidebar(open = true, payload = null) {
    if (!sidebarIframe) createSidebar();

    if (open) {
        sidebarIframe.style.right = "0";
        const message = {
            type: "LN_AI_POST_DATA",
            mode: (payload && payload.mode) || "comment",
            post: (payload && payload.post) || null,
            comment: (payload && payload.comment) || null,
        };
        const send = () =>
            sidebarIframe.contentWindow &&
            sidebarIframe.contentWindow.postMessage(message, "*");
        send();
        setTimeout(send, 150);
        setTimeout(send, 400);
    } else {
        sidebarIframe.style.right = "-420px";
    }
}

// --- Button injection ------------------------------------------------------

function cleanUrl(href) {
    if (!href) return null;
    try {
        const u = new URL(href, location.origin);
        return u.origin + u.pathname; // drop tracking query/hash
    } catch {
        return href;
    }
}

// Parse LinkedIn count strings like "2,349", "1.2K", "3M" into a number.
function parseCount(str) {
    if (!str) return null;
    const m = String(str).replace(/,/g, "").match(/([\d.]+)\s*([KkMm])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (m[2]) n = Math.round(n * (/k/i.test(m[2]) ? 1e3 : 1e6));
    return Number.isFinite(n) ? n : null;
}

function firstMatch(text, regex) {
    const m = (text || "").match(regex);
    return m ? m[0].trim() : null;
}

// The post author's name is reliably embedded in the control-menu label.
function getAuthorName(post) {
    const menu = post.querySelector(
        '[aria-label^="Open control menu for post by"],[aria-label^="Hide post by"]'
    );
    if (menu) {
        const m = menu.getAttribute("aria-label").match(/post by\s+(.+)$/i);
        if (m) return m[1].trim();
    }
    return null;
}

// The author's headline/job title. LinkedIn's author link holds only the name
// and connection degree; the headline is the first real text line AFTER that
// author block and BEFORE the timestamp. Everything that trips the old code —
// "Suggested", "Following", "Promoted by LinkedIn", "X commented on this" — sits
// either before the author block or is a CTA/time line, so we anchor on the
// author link's position and skip those explicitly.
function getHeadline(post, textBox, authorLink) {
    if (!authorLink) return null;

    // Short, own-text header lines above the post body, in DOM order.
    const leaves = [...post.querySelectorAll("p, span")].filter((el) => {
        if (textBox && textBox.contains(el)) return false;
        const hasOwnText = [...el.childNodes].some(
            (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
        );
        const t = el.innerText.trim();
        return hasOwnText && t && t.length < 200;
    });

    // The author block (name + degree) lives inside the author link; the headline
    // is the first qualifying line after it.
    let lastAuthorIdx = -1;
    leaves.forEach((el, i) => {
        if (authorLink.contains(el)) lastAuthorIdx = i;
    });
    if (lastAuthorIdx === -1) return null;

    // CTA / feed-reason noise to skip over.
    const SKIP = /^(\+?\s*follow(ing)?|connect|message|subscribe|promoted( by linkedin)?|visit\b.*|edited)$/i;
    // Timestamp or engagement/action row — headline never appears past here.
    const STOP =
        /^\s*\d+\s*(s|m|h|d|w|mo|yr|min|hour|day|week|month|year)s?\b|\b(reaction|comment|repost|follower)s?\b|^(feed post|like|comment|repost|send|play video|video player)/i;

    for (let i = lastAuthorIdx + 1; i < leaves.length; i++) {
        const t = leaves[i].innerText.trim();
        if (STOP.test(t)) break;
        if (SKIP.test(t) || /^[•·\s]+$/.test(t)) continue;
        return t;
    }
    return null;
}

// Below this width an <img> is an icon, logo, or tracking pixel, not post content.
const MIN_CONTENT_IMAGE_PX = 200;

function isContentImage(img) {
    if (!img.src || img.src.startsWith("data:")) return false;
    if (/feedshare|feedimage/i.test(img.src) || img.alt === "View image") return true;
    // Avatars: inside a profile link, or labelled "View <name>'s profile".
    if (img.closest('a[href*="/in/"]')) return false;
    if (/^View\s/.test(img.alt || "") && PROFILE_ALT_RE.test(img.alt)) return false;
    // naturalWidth is 0 until the image decodes; fall back to layout width so a
    // still-loading content image isn't discarded.
    const w = img.naturalWidth || img.width || 0;
    return w >= MIN_CONTENT_IMAGE_PX;
}

// LinkedIn lazy-loads a low-res placeholder into `src` and lists the real
// resolutions in `srcset`; a 100px thumbnail tells the model almost nothing, so
// prefer the widest candidate available.
function bestImageSrc(img) {
    const set = img.getAttribute("srcset");
    if (!set) return img.src;
    let best = null;
    for (const part of set.split(",")) {
        const [url, size] = part.trim().split(/\s+/);
        if (!url) continue;
        const w = size && size.endsWith("w") ? parseInt(size, 10) : 0;
        if (!best || w > best.w) best = { url, w };
    }
    return best && best.w ? new URL(best.url, location.href).href : img.src;
}

// Pull as much structured data as the DOM reliably exposes for one post.
function extractPostData(post) {
    const textBox = post.querySelector('[data-testid="expandable-text-box"]');
    let text = textBox ? textBox.innerText.trim() : "";
    text = text.replace(/\s*…\s*more\s*$/i, "").trim();
    // No deliberate body text. The old fallback scraped `post.innerText`, which
    // sweeps in the author block, CTAs, and reaction counts — noise the model then
    // treats as the post. Leave it empty; the sidebar reads that as "the attached
    // image(s) are the post" and prompts accordingly.

    const name = getAuthorName(post);

    // Author profile URL + avatar: prefer the link/image matching the name so
    // we don't grab the reactor from a "X likes this" social-context row.
    const inLinks = [...post.querySelectorAll('a[href*="/in/"]')];
    // The author's own profile link — prefer the one that mentions the author's
    // name so we don't grab a reactor from a "X likes this" social-context row.
    const authorLink =
        (name &&
            inLinks.find(
                (a) =>
                    (a.getAttribute("aria-label") || "").includes(name) ||
                    (a.innerText || "").includes(name)
            )) ||
        inLinks[0] ||
        null;

    const profileUrl = authorLink ? cleanUrl(authorLink.href) : null;
    let avatarUrl = null;
    if (name) {
        const avatar = [...post.querySelectorAll("img")].find(
            (img) => img.alt && img.alt.includes(name) && /profile/i.test(img.alt)
        );
        if (avatar) avatarUrl = avatar.src;
    }

    // Social context, e.g. "Angie Aguilar likes this".
    const socialContext =
        [...post.querySelectorAll("p, span")]
            .map((el) => el.innerText.trim())
            .find((t) =>
                /\b(likes|loves|celebrates|commented on|reposted|reacted to|shared)\b.*\bthis\b/i.test(t)
            ) || null;

    // Header lines (everything outside the body text) hold degree/time.
    const headerLines = [...post.querySelectorAll("p, span")]
        .filter((el) => !textBox || !textBox.contains(el))
        .map((el) => el.innerText.trim())
        .filter(Boolean);

    const degree = firstMatch(headerLines.join(" | "), /\b(1st|2nd|3rd)\b/);

    const timeStr = headerLines.find((s) => /^\s*\d+\s*(s|m|h|d|w|mo|yr)\b/i.test(s));
    const postedTime = firstMatch(timeStr, /\d+\s*(s|m|h|d|w|mo|yr|min|hour|day|week|month|year)s?/i);

    // Positional headline extraction (anchored to the author link) — replaces the
    // old keyword-guessing that leaked "Suggested" / "Following" / context rows.
    const headline = getHeadline(post, textBox, authorLink);

    const visSvg = post.querySelector('svg[aria-label^="Visibility"]');
    const visibility = visSvg
        ? (visSvg.getAttribute("aria-label").split(":")[1] || "").trim()
        : null;

    const hashtags = [...new Set(text.match(/#[\p{L}\p{N}_]+/gu) || [])];

    const mentions = textBox
        ? [...new Set(
              [...textBox.querySelectorAll('a[href*="/in/"]')]
                  .map((a) => a.innerText.trim())
                  .filter(Boolean)
          )]
        : [];

    const externalLinks = textBox
        ? [...new Set(
              [...textBox.querySelectorAll('a[href^="http"]')]
                  .map((a) => a.href)
                  .filter((h) => !/linkedin\.com/.test(h))
          )]
        : [];

    // Content images only — skip avatars and logos. The `feedshare|feedimage`
    // URL slugs and the English "View image" alt are the fast path; when neither
    // matches (localized UI, or a slug LinkedIn has since renamed) we fall back to
    // rejecting what an image *isn't* — avatars live inside profile links or carry
    // a "View <name>'s profile" label, and icons/logos/tracking pixels are small.
    const images = [...new Set(
        [...post.querySelectorAll("img")]
            .filter(isContentImage)
            .map(bestImageSrc)
            .filter(Boolean)
    )];

    const hasVideo = !!post.querySelector("video");
    const imageCount = images.length;
    const mediaType = hasVideo
        ? "video"
        : imageCount > 1
        ? "images"
        : imageCount === 1
        ? "image"
        : "none";

    // Which reaction types the post has received (from the ring-icon SVG ids).
    const reactionTypes = [...new Set(
        [...post.querySelectorAll('svg[id$="-consumption-ring-small"]')]
            .map((svg) => svg.id.replace(/-consumption-ring-small$/, ""))
            .map((k) => REACTION_NAMES[k] || k)
    )];

    const isRepost = /\brepost/i.test(socialContext || "");
    // A "Follow" CTA on the post means you're not already following the author.
    const canFollow = !!post.querySelector('button[aria-label^="Follow "]');

    const reactions = parseCount(
        (post.querySelector('[aria-label^="Reaction button state"]') || {}).innerText ||
            firstMatch(post.innerText, /([\d.,]+[KkMm]?)\s+reactions?/)
    );
    const comments = parseCount((post.querySelector('button[aria-label="Comment"]') || {}).innerText);
    const reposts = parseCount((post.querySelector('button[aria-label="Repost"]') || {}).innerText);

    return {
        id: post.getAttribute("componentkey") || null,
        author: { name, jobTitle: headline, degree, profileUrl, avatarUrl, canFollow },
        socialContext,
        isRepost,
        postedTime,
        visibility,
        text,
        hashtags,
        mentions,
        mediaType,
        imageCount,
        images,
        externalLinks,
        counts: { reactions, comments, reposts },
        reactionTypes,
        url: location.href,
        extractedAt: new Date().toISOString(),
    };
}

// --- Comments (for replies) ------------------------------------------------
//
// LinkedIn's comment DOM is fully hashed (no stable class or data-id on the
// comment container), so we can't select comments directly. Three hooks survive
// and we anchor on them instead:
//   1. Every posted comment has a `button[aria-label="Reply"]`; the post does
//      not. That button is our per-comment marker and our button's placement.
//   2. Comment text lives in `[data-testid="expandable-text-box"]` (same testid
//      the post body uses — we scope it to the comment to disambiguate).
//   3. The avatar's alt / aria-label reads "View <Name>'s profile".

// The comment's "View <Name>'s profile" avatar → the commenter's name.
const PROFILE_ALT_RE = /View\s+(.+?)['’`]s\s+profile/i;

// Reply buttons; the exact-match form covers English, the prefix covers
// localized "Reply to <name>" variants some UIs render.
const REPLY_BTN_SELECTOR = 'button[aria-label="Reply"], button[aria-label^="Reply to"]';

// Walk up from a Reply button to the tightest comment block: the first ancestor
// that holds both this comment's text box and its "View…profile" avatar. That
// pairing lands on the individual comment, not the whole post or a nested reply.
function commentScopeFrom(replyBtn) {
    let el = replyBtn.parentElement;
    for (let i = 0; el && i < 15; i++, el = el.parentElement) {
        const hasText = el.querySelector('[data-testid="expandable-text-box"]');
        const hasAvatar = el.querySelector('img[alt^="View "], svg[aria-label^="View "]');
        if (hasText && hasAvatar) return el;
    }
    return null;
}

function getCommentAuthor(scope) {
    const el = scope.querySelector('img[alt^="View "], svg[aria-label^="View "]');
    const label = el ? el.getAttribute("alt") || el.getAttribute("aria-label") : "";
    const m = (label || "").match(PROFILE_ALT_RE);
    if (m) return m[1].trim();
    // Fallback: a profile link's visible text.
    const link = scope.querySelector('a[href*="/in/"]');
    const t = link ? (link.innerText || "").trim().split("\n")[0].trim() : "";
    return t || null;
}

function getCommentText(scope) {
    const box = scope.querySelector('[data-testid="expandable-text-box"]');
    let text = box ? box.innerText.trim() : "";
    text = text.replace(/\s*…\s*more\s*$/i, "").trim();
    return text;
}

function extractCommentData(scope) {
    const parentEl = resolvePostContainer(scope);
    // Reuse the full post extractor for context; guard against it throwing on
    // unusual layouts so a reply can still be generated from the comment alone.
    let parentPost = null;
    if (parentEl) {
        try {
            parentPost = extractPostData(parentEl);
        } catch {
            parentPost = null;
        }
    }
    return {
        comment: {
            author: { name: getCommentAuthor(scope) },
            text: getCommentText(scope),
            url: location.href,
            extractedAt: new Date().toISOString(),
        },
        post: parentPost,
    };
}

function buildReplyButton(scope) {
    const btn = document.createElement("button");
    btn.className = "ln-ai-comment-btn ln-ai-reply-btn";
    btn.type = "button";
    btn.title = "Get AI reply suggestions";
    btn.innerHTML = `<span class="ln-ai-icon" aria-hidden="true">🤖</span><span class="ln-ai-text">AI Reply</span>`;

    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const { comment, post } = extractCommentData(scope);
        toggleSidebar(true, { mode: "reply", post, comment });
    });

    return btn;
}

// Attach an "AI Reply" button next to one native Reply button.
function injectReplyButton(replyBtn) {
    if (replyBtn.dataset.lnAiReplyDone === "1") return;

    const scope = commentScopeFrom(replyBtn);
    // No resolvable comment (e.g. the reply-editor's submit button) → skip, but
    // mark it so we don't re-scan the same button every mutation.
    if (!scope || scope.querySelector('[contenteditable="true"]')) {
        replyBtn.dataset.lnAiReplyDone = "1";
        return;
    }

    replyBtn.dataset.lnAiReplyDone = "1";
    const btn = buildReplyButton(scope);
    if (replyBtn.parentElement) {
        replyBtn.parentElement.insertBefore(btn, replyBtn.nextSibling);
    }
}

function scanAndInjectComments(root = document) {
    if (root.querySelectorAll) root.querySelectorAll(REPLY_BTN_SELECTOR).forEach(injectReplyButton);
    if (root.matches && root.matches(REPLY_BTN_SELECTOR)) injectReplyButton(root);
}

// --- Post button injection -------------------------------------------------

function buildButton(post) {
    const btn = document.createElement("button");
    btn.className = "ln-ai-comment-btn ln-ai-comment-btn--floating";
    btn.type = "button";
    btn.title = "Get AI comment suggestions";
    btn.innerHTML = `<span class="ln-ai-icon" aria-hidden="true">🤖</span><span class="ln-ai-text">AI Comment</span>`;

    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebar(true, { mode: "comment", post: extractPostData(post) });
    });

    return btn;
}

function injectAIButton(candidate) {
    // Normalize to the outermost post container so nested matches don't double up.
    const post = resolvePostContainer(candidate) || candidate;

    if (post.dataset.lnAiInjected === "1") return;
    // Skip if an ancestor post already got a button (avoids nested duplicates).
    if (post.parentElement && post.parentElement.closest('[data-ln-ai-injected="1"]')) return;

    post.dataset.lnAiInjected = "1";
    post.setAttribute("data-ln-ai-injected", "1");

    if (getComputedStyle(post).position === "static") {
        post.style.position = "relative";
    }

    post.appendChild(buildButton(post));
}

function scanAndInject(root = document) {
    let count = 0;
    if (root.querySelectorAll) {
        root.querySelectorAll(POST_MENU_SELECTOR).forEach((menu) => {
            injectAIButton(menu);
            count++;
        });
    }
    // The added node itself may be a control-menu button (observer edge case).
    if (root.matches && root.matches(POST_MENU_SELECTOR)) {
        injectAIButton(root);
        count++;
    }
    return count;
}

// --- Boot ------------------------------------------------------------------

function boot() {
    log("content script loaded on", location.href);
    createSidebar();

    const found = scanAndInject();
    scanAndInjectComments();
    log("initial scan matched", found, "candidate(s)");

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                scanAndInject(node);
                scanAndInjectComments(node);
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Safety net: re-scan periodically for the first ~15s while the feed hydrates.
    let ticks = 0;
    const interval = setInterval(() => {
        scanAndInject();
        scanAndInjectComments();
        if (++ticks >= 10) clearInterval(interval);
    }, 1500);
}

window.addEventListener("message", (event) => {
    if (!event.data) return;
    if (event.data.type === "LN_AI_CLOSE_SIDEBAR") {
        toggleSidebar(false);
    } else if (event.data.type === "LN_AI_THEME") {
        applyIframeTheme(event.data.theme);
    }
});

// Content scripts run at document_idle, but the feed can still be empty; boot now
// and let the observer + interval catch the rest.
boot();
