// LinkedIn AI Comment Companion - content script
// Attaches a floating "AI Comment" button to every feed post. Clicking it opens
// a sidebar and loads that post's text so an API can suggest comments.
//
// We deliberately avoid depending on LinkedIn's frequently-renamed CSS classes
// for placement. Posts are detected by their stable activity data-attributes,
// and the button is positioned on the post container itself.

const DEBUG = true;
const log = (...args) => DEBUG && console.log("[LN-AI]", ...args);

// LinkedIn's current feed uses fully obfuscated (hashed) CSS classes, so we
// anchor on the attributes it keeps stable for accessibility/testing instead:
//   - a feed post is a [role="listitem"] carrying a componentkey
//   - its body text lives in [data-testid="expandable-text-box"]
// The older class-based selectors are kept last as fallbacks for any account
// still served the previous UI.
const POST_SELECTORS = [
    '[role="listitem"][componentkey]',
    'div.feed-shared-update-v2',
    '[data-urn^="urn:li:activity"]',
    '[data-id^="urn:li:activity"]',
    'div.fie-impression-container',
];

// Selector for the outermost single-post container, used to de-dupe nested
// matches so one post gets exactly one button.
const POST_CONTAINER_SELECTOR = '[role="listitem"][componentkey], div.feed-shared-update-v2';

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

    document.body.appendChild(sidebarIframe);
    log("sidebar iframe created");
}

function toggleSidebar(open = true, postData = null) {
    if (!sidebarIframe) createSidebar();

    if (open) {
        sidebarIframe.style.right = "0";
        const send = () =>
            sidebarIframe.contentWindow &&
            sidebarIframe.contentWindow.postMessage({ type: "LN_AI_POST_DATA", post: postData }, "*");
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

// Pull as much structured data as the DOM reliably exposes for one post.
function extractPostData(post) {
    const textBox = post.querySelector('[data-testid="expandable-text-box"]');
    let text = textBox ? textBox.innerText.trim() : "";
    text = text.replace(/\s*…\s*more\s*$/i, "").trim();
    if (!text) text = (post.innerText || "").trim().slice(0, 3000);

    const name = getAuthorName(post);

    // Author profile URL + avatar: prefer the link/image matching the name so
    // we don't grab the reactor from a "X likes this" social-context row.
    const inLinks = [...post.querySelectorAll('a[href*="/in/"]')];
    let profileUrl = null;
    let avatarUrl = null;
    if (name) {
        const byName = inLinks.find(
            (a) =>
                (a.getAttribute("aria-label") || "").includes(name) ||
                (a.innerText || "").includes(name)
        );
        if (byName) profileUrl = cleanUrl(byName.href);
        const avatar = [...post.querySelectorAll("img")].find(
            (img) => img.alt && img.alt.includes(name) && /profile/i.test(img.alt)
        );
        if (avatar) avatarUrl = avatar.src;
    }
    if (!profileUrl && inLinks[0]) profileUrl = cleanUrl(inLinks[0].href);

    // Social context, e.g. "Angie Aguilar likes this".
    const socialContext =
        [...post.querySelectorAll("p")]
            .map((p) => p.innerText.trim())
            .find((t) =>
                /\b(likes|loves|celebrates|commented on|reposted|reacted to|shared)\b.*\bthis\b/i.test(t)
            ) || null;

    // Header paragraphs (everything outside the body text) hold degree/headline/time.
    const headerPs = [...post.querySelectorAll("p")]
        .filter((p) => !textBox || !textBox.contains(p))
        .map((p) => p.innerText.trim())
        .filter(Boolean);

    const degree = firstMatch(headerPs.join(" | "), /\b(1st|2nd|3rd)\b/);

    const timeStr = headerPs.find((s) =>
        /^\s*\d+\s*(s|m|h|d|w|mo|yr)\b/i.test(s)
    );
    const postedTime = firstMatch(timeStr, /\d+\s*(s|m|h|d|w|mo|yr|min|hour|day|week|month|year)s?/i);

    const headline =
        headerPs.find(
            (t) =>
                t !== name &&
                t !== socialContext &&
                !/\b(1st|2nd|3rd)\b/.test(t) &&
                !/^\s*\d+\s*(s|m|h|d|w|mo|yr)/i.test(t) &&
                !/\b(likes|commented on|reposted|reacted)\b/i.test(t) &&
                !/^[•\s]+$/.test(t)
        ) || null;

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

    // Content images only — skip avatars and logos.
    const images = [...new Set(
        [...post.querySelectorAll("img")]
            .filter((img) => /feedshare|feedimage/i.test(img.src) || img.alt === "View image")
            .map((img) => img.src)
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

function buildButton(post) {
    const btn = document.createElement("button");
    btn.className = "ln-ai-comment-btn ln-ai-comment-btn--floating";
    btn.type = "button";
    btn.title = "Get AI comment suggestions";
    btn.innerHTML = `<span class="ln-ai-icon" aria-hidden="true">🤖</span><span class="ln-ai-text">AI Comment</span>`;

    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebar(true, extractPostData(post));
    });

    return btn;
}

function injectAIButton(candidate) {
    // Normalize to the outermost post container so nested matches don't double up.
    const post = candidate.closest(POST_CONTAINER_SELECTOR) || candidate;

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
    for (const sel of POST_SELECTORS) {
        root.querySelectorAll(sel).forEach((el) => {
            injectAIButton(el);
            count++;
        });
    }
    return count;
}

// --- Boot ------------------------------------------------------------------

function boot() {
    log("content script loaded on", location.href);
    createSidebar();

    const found = scanAndInject();
    log("initial scan matched", found, "candidate(s)");

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                for (const sel of POST_SELECTORS) {
                    if (node.matches && node.matches(sel)) injectAIButton(node);
                }
                if (node.querySelectorAll) scanAndInject(node);
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Safety net: re-scan periodically for the first ~15s while the feed hydrates.
    let ticks = 0;
    const interval = setInterval(() => {
        scanAndInject();
        if (++ticks >= 10) clearInterval(interval);
    }, 1500);
}

window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "LN_AI_CLOSE_SIDEBAR") {
        toggleSidebar(false);
    }
});

// Content scripts run at document_idle, but the feed can still be empty; boot now
// and let the observer + interval catch the rest.
boot();
