// Sidebar logic: receives post data from the content script, builds a prompt,
// and calls the Gemini API (free tier) to fetch recommended comments in-panel.

const LEGACY_EXPERIENCE_KEY = "ln_ai_experience"; // old localStorage key, migrated once
const SETTINGS_KEY = "ln_ai_settings";

const SETTINGS_DEFAULTS = {
    apiKey: "",
    model: "gemini-3.7-flash",
    theme: "system",
    experience: "",
    styles: [], // real defaults come from defaultStyles() on first run
};

// The comment styles shipped out of the box. Users can edit, reorder-by-delete,
// toggle, or replace these entirely from Settings; only enabled ones with a name
// are written into the prompt. Returns fresh clones so stored state never
// aliases this template.
function defaultStyles() {
    return [
        {
            id: "curious",
            name: "Curious",
            enabled: true,
            instruction:
                "Ask one specific, hard-to-template question that only makes sense after actually " +
                "reading this post. Reference an exact detail, number, or claim from it. Skip " +
                'throat-clearing like "curious to know" or "quick question." Just ask it. One ' +
                "sentence, occasionally two if the second sets up the first.",
        },
        {
            id: "insightful",
            name: "Insightful",
            enabled: true,
            instruction:
                "Give one real opinion or reframe, not a summary of what the post already said. It " +
                "should sound like something you'd say out loud to a colleague, not a takeaway " +
                'slide. Ban list: no "underscores," "highlights the importance of," "at its core," ' +
                'no -ing tacked-on clauses ("...ensuring better outcomes"). 2 sentences max, plain ' +
                "declarative structure (is/are/has).",
        },
        {
            id: "story",
            name: "Story-driven",
            enabled: true,
            instruction:
                "One line, one concrete detail from your actual work, a tool, a client type, a " +
                "specific bug or number, not a narrative arc. If it doesn't fit in one sentence, " +
                "cut it down rather than adding a second.",
        },
        {
            id: "supportive",
            name: "Supportive",
            enabled: true,
            instruction:
                "Affirm something specific about the post (not the person in general), then fold " +
                'in one light question or detail so it\'s not just praise sitting there. No "great ' +
                'post," no "thanks for sharing," no generic enthusiasm. 1-2 sentences.',
        },
        {
            id: "witty",
            name: "Witty",
            enabled: true,
            instruction:
                "One line, one joke, done. No setup-punchline structure that telegraphs itself, no " +
                "forced wordplay. If it needs explaining, cut it.",
        },
    ];
}

function genStyleId() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Model ids Google has retired for new keys. Anything stored from an older
// version of the extension is silently upgraded to the current default.
const RETIRED_MODELS = new Set([
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
]);

let settings = { ...SETTINGS_DEFAULTS };
let currentMode = "comment"; // "comment" (on a post) | "reply" (to a comment)
let currentPost = null; // the post, or the reply's parent post used as context
let currentComment = null; // the comment being replied to, in reply mode

const els = {
    // header / views
    settingsToggle: document.getElementById("ln-ai-settings-toggle"),
    settingsBack: document.getElementById("ln-ai-settings-back"),
    settingsView: document.getElementById("ln-ai-settings"),
    mainView: document.getElementById("ln-ai-main"),
    close: document.getElementById("ln-ai-close"),
    // settings fields
    theme: document.getElementById("ln-ai-theme"),
    model: document.getElementById("ln-ai-model"),
    key: document.getElementById("ln-ai-key"),
    keyToggle: document.getElementById("ln-ai-key-toggle"),
    experience: document.getElementById("ln-ai-experience"),
    styles: document.getElementById("ln-ai-styles"),
    addStyle: document.getElementById("ln-ai-add-style"),
    resetStyles: document.getElementById("ln-ai-reset-styles"),
    settingsStatus: document.getElementById("ln-ai-settings-status"),
    // main fields
    mode: document.getElementById("ln-ai-mode"),
    json: document.getElementById("ln-ai-json"),
    copyJson: document.getElementById("ln-ai-copy-json"),
    take: document.getElementById("ln-ai-take"),
    prompt: document.getElementById("ln-ai-prompt"),
    copyPrompt: document.getElementById("ln-ai-copy-prompt"),
    generate: document.getElementById("ln-ai-generate"),
    status: document.getElementById("ln-ai-status"),
    results: document.getElementById("ln-ai-results"),
};

// --- Settings persistence --------------------------------------------------

function loadSettings() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(SETTINGS_KEY, (res) => {
            const stored = res[SETTINGS_KEY] || {};
            settings = { ...SETTINGS_DEFAULTS, ...stored };
            // Seed the built-in styles only on first run (no styles stored yet);
            // an empty array means the user deliberately removed them all.
            if (!Array.isArray(stored.styles)) {
                settings.styles = defaultStyles();
            }
            // Upgrade any retired model id to the current default.
            if (RETIRED_MODELS.has(settings.model)) {
                settings.model = SETTINGS_DEFAULTS.model;
                saveSettings();
            }
            // One-time migration of the old localStorage experience blurb.
            if (!settings.experience) {
                const legacy = localStorage.getItem(LEGACY_EXPERIENCE_KEY);
                if (legacy) {
                    settings.experience = legacy;
                    saveSettings();
                }
            }
            resolve();
        });
    });
}

function saveSettings() {
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

// --- Theming ---------------------------------------------------------------

const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

function effectiveTheme(theme) {
    if (theme === "system") return darkMedia.matches ? "dark" : "light";
    return theme;
}

function applyTheme() {
    const eff = effectiveTheme(settings.theme);
    document.documentElement.setAttribute("data-theme", eff);
    // Let the content script recolor the iframe shell so there's no flash.
    window.parent.postMessage({ type: "LN_AI_THEME", theme: eff }, "*");
}

// Re-apply when the OS theme flips and we're following "system".
darkMedia.addEventListener("change", () => {
    if (settings.theme === "system") applyTheme();
});

// --- Prompt building -------------------------------------------------------

// The enabled, named styles that should drive generation, in display order.
function activeStyles() {
    return (settings.styles || []).filter((s) => s.enabled && (s.name || "").trim());
}

function buildPrompt(post, experience, take) {
    const isReply = currentMode === "reply" && !!currentComment;
    if (isReply ? !currentComment : !post) {
        return isReply
            ? "Select a comment to generate a prompt."
            : "Select a post to generate a prompt.";
    }

    const styles = activeStyles();
    const n = styles.length;
    const plural = n === 1 ? "" : "s";

    const a = (post && post.author) || {};
    const c = (post && post.counts) || {};
    const exp = (experience || "").trim();
    const myTake = (take || "").trim();
    const commenter = (isReply && currentComment.author && currentComment.author.name) || "the commenter";
    const unit = isReply ? "reply" : "comment";
    const L = [];

    L.push(
        isReply
            ? "You are helping me write a thoughtful LinkedIn reply to a comment in the thread below."
            : "You are helping me write a thoughtful LinkedIn comment on the post below."
    );
    L.push("");
    // Only include the "about me" block once the user has actually filled it in.
    if (exp) {
        L.push("=== ABOUT ME (the commenter) ===");
        L.push(exp);
        L.push("");
    }

    // Post context — always shown for a top-level comment, and as background for
    // a reply when we managed to capture the parent post.
    if (post) {
        L.push(isReply ? "=== ORIGINAL POST (context) ===" : "=== POST AUTHOR ===");
        L.push(`Author: ${a.name || "Unknown"}`);
        if (a.jobTitle) L.push(`Current job title / headline: ${a.jobTitle}`);
        if (a.degree) L.push(`Connection degree: ${a.degree}`);
        if (!isReply && a.profileUrl) L.push(`Profile: ${a.profileUrl}`);
        if (post.isRepost) L.push("This is a repost/reshare.");
        if (post.socialContext) L.push(`Social context: ${post.socialContext}`);
        if (post.postedTime) L.push(`Posted: ${post.postedTime} ago`);
        if (post.mediaType && post.mediaType !== "none") {
            L.push(`Media: ${post.mediaType}${post.imageCount ? ` (${post.imageCount})` : ""}`);
        }
        const engagement = [
            c.reactions != null ? `${c.reactions} reactions` : null,
            c.comments != null ? `${c.comments} comments` : null,
            c.reposts != null ? `${c.reposts} reposts` : null,
        ]
            .filter(Boolean)
            .join(", ");
        if (engagement) L.push(`Engagement: ${engagement}`);
        if (!isReply && post.reactionTypes && post.reactionTypes.length) {
            L.push(`Reaction types: ${post.reactionTypes.join(", ")}`);
        }
        if (post.hashtags && post.hashtags.length) L.push(`Hashtags: ${post.hashtags.join(" ")}`);
        L.push("");
        L.push("Post text:");
        L.push('"""');
        L.push(post.text || "(no text content)");
        L.push('"""');
    }

    // The comment we're replying to.
    if (isReply) {
        L.push("");
        L.push("=== COMMENT I'M REPLYING TO ===");
        L.push(`Commenter: ${commenter}`);
        L.push("Comment text:");
        L.push('"""');
        L.push(currentComment.text || "(no text content)");
        L.push('"""');
    }

    // The user's own rough thoughts / draft, if provided.
    if (myTake) {
        L.push("");
        L.push(`=== MY TAKE / DRAFT ${unit.toUpperCase()} ===`);
        L.push(myTake);
    }

    L.push("");
    L.push("=== YOUR TASK ===");
    if (n === 0) {
        L.push("No comment styles are enabled. Turn on at least one in Settings (⚙️).");
        return L.join("\n");
    }

    const replyContext = isReply
        ? ` These are replies in a thread, so keep them conversational, addressed to ${commenter} (not the original poster), and they can be shorter than a top-level comment.`
        : "";

    if (myTake) {
        L.push(
            `Take my rough take / draft above and rewrite it into ${n} ${unit} option${plural}, ` +
                "one per style below. Preserve my core point and personal voice, fix any grammar " +
                "or awkward phrasing, and follow the per-style rules exactly." +
                replyContext +
                " Don't add hashtags unless they clearly add value."
        );
    } else {
        L.push(
            `Write ${n} ${unit} option${plural} I could post` +
                (isReply ? ` in response to ${commenter}'s comment` : " in reply") +
                ", one per style below. Follow the per-style rules exactly." +
                replyContext +
                (exp ? " Weave in my background above only where it is genuinely relevant." : "") +
                " Don't add hashtags unless they clearly add value."
        );
    }
    L.push("");
    L.push(`Use exactly these ${n} style${plural}, each on its own labeled line:`);
    L.push("");
    styles.forEach((s, i) => {
        const instr = (s.instruction || "").trim();
        L.push(`${i + 1}. ${s.name.trim()}:${instr ? " " + instr : ""}`);
    });
    L.push("");
    L.push(n === 1 ? "For it:" : "Across all of them:");
    L.push('- No em dashes, no rule-of-three lists, no "it\'s not just X, it\'s Y."');
    L.push('- No signposting ("here\'s the thing," "let\'s be real").');
    L.push("- Contractions where natural, sentence lengths uneven on purpose.");
    L.push(
        `- If a line could've been written about any ${unit} in this niche, it's too generic. ` +
            `Anchor to something only this ${isReply ? "comment" : "post"} said.`
    );
    L.push("");
    L.push(
        "Format each as a numbered line starting with the style name and a colon " +
            `(e.g. "1. Curious: ..."), the ${unit} ready to paste. Output only those lines.`
    );

    return L.join("\n");
}

function renderPrompt() {
    els.prompt.textContent = buildPrompt(currentPost, settings.experience, els.take.value);
}

// --- Post data intake ------------------------------------------------------

// Reflect the current mode in the header banner, button, and draft labels.
function updateModeUI() {
    const replying = currentMode === "reply" && currentComment;
    if (replying) {
        const who = (currentComment.author && currentComment.author.name) || "this comment";
        els.mode.textContent = `↳ Replying to ${who}`;
        els.mode.hidden = false;
        els.generate.textContent = "Suggest replies";
        els.take.placeholder =
            "Jot down your rough thoughts or a draft reply. The AI will refine it into your enabled styles.";
    } else {
        els.mode.hidden = true;
        els.generate.textContent = "Suggest comments";
        els.take.placeholder =
            "Jot down your rough thoughts or a draft comment. The AI will refine it into your enabled styles.";
    }
}

window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.type === "LN_AI_POST_DATA") {
        currentMode = data.mode === "reply" ? "reply" : "comment";
        currentPost = data.post || null;
        currentComment = data.comment || null;
        const shown =
            currentMode === "reply"
                ? { replyingTo: currentComment, postContext: currentPost }
                : currentPost;
        els.json.textContent = shown ? JSON.stringify(shown, null, 2) : "No data found.";
        // The draft is specific to the target, so reset it when a new one loads.
        els.take.value = "";
        updateModeUI();
        renderPrompt();
        setStatus("");
        els.results.innerHTML = "";
    }
});

els.take.addEventListener("input", renderPrompt);

// --- Settings view wiring --------------------------------------------------

function showSettings(show) {
    els.settingsView.hidden = !show;
    els.mainView.hidden = show;
}

els.settingsToggle.addEventListener("click", () => showSettings(els.settingsView.hidden));
els.settingsBack.addEventListener("click", () => showSettings(false));

els.theme.addEventListener("change", () => {
    settings.theme = els.theme.value;
    applyTheme();
    saveSettings();
});

els.model.addEventListener("change", () => {
    settings.model = els.model.value;
    saveSettings();
});

els.key.addEventListener("input", () => {
    settings.apiKey = els.key.value.trim();
    saveSettings();
});

els.keyToggle.addEventListener("click", () => {
    const showing = els.key.type === "text";
    els.key.type = showing ? "password" : "text";
    els.keyToggle.textContent = showing ? "Show" : "Hide";
});

els.experience.addEventListener("input", () => {
    settings.experience = els.experience.value;
    saveSettings();
    renderPrompt();
});

// --- Comment style management ----------------------------------------------

// Build one editable row (toggle + name + delete + instruction) for a style.
function buildStyleRow(style) {
    const row = document.createElement("div");
    row.className = "ln-ai-style";
    row.classList.toggle("ln-ai-style--off", !style.enabled);

    const head = document.createElement("div");
    head.className = "ln-ai-style-head";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "ln-ai-style-toggle";
    toggle.checked = !!style.enabled;
    toggle.title = "Include this style in the prompt";
    toggle.addEventListener("change", () => {
        style.enabled = toggle.checked;
        row.classList.toggle("ln-ai-style--off", !style.enabled);
        saveSettings();
        renderPrompt();
    });

    const name = document.createElement("input");
    name.type = "text";
    name.className = "ln-ai-style-name";
    name.value = style.name || "";
    name.placeholder = "Style name";
    name.addEventListener("input", () => {
        style.name = name.value;
        saveSettings();
        renderPrompt();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "ln-ai-style-del";
    del.title = "Delete style";
    del.textContent = "×";
    del.addEventListener("click", () => {
        settings.styles = settings.styles.filter((s) => s !== style);
        saveSettings();
        renderStylesList();
        renderPrompt();
    });

    head.appendChild(toggle);
    head.appendChild(name);
    head.appendChild(del);

    const instr = document.createElement("textarea");
    instr.className = "ln-ai-style-instruction";
    instr.value = style.instruction || "";
    instr.placeholder = "How this style should sound: tone, length, rules to follow or avoid…";
    instr.addEventListener("input", () => {
        style.instruction = instr.value;
        saveSettings();
        renderPrompt();
    });

    row.appendChild(head);
    row.appendChild(instr);
    return row;
}

function renderStylesList() {
    els.styles.innerHTML = "";
    settings.styles.forEach((style) => els.styles.appendChild(buildStyleRow(style)));
}

els.addStyle.addEventListener("click", () => {
    settings.styles.push({ id: genStyleId(), name: "", instruction: "", enabled: true });
    saveSettings();
    renderStylesList();
    renderPrompt();
    // Focus the new row's name field so the user can type straight away.
    const names = els.styles.querySelectorAll(".ln-ai-style-name");
    if (names.length) names[names.length - 1].focus();
});

els.resetStyles.addEventListener("click", () => {
    settings.styles = defaultStyles();
    saveSettings();
    renderStylesList();
    renderPrompt();
});

// Populate the settings form from stored values.
function hydrateSettingsForm() {
    els.theme.value = settings.theme;
    els.model.value = settings.model;
    els.key.value = settings.apiKey;
    els.experience.value = settings.experience;
    renderStylesList();
}

// --- Clipboard -------------------------------------------------------------

function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
        ok = document.execCommand("copy");
    } catch {
        ok = false;
    }
    document.body.removeChild(ta);
    return ok;
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to the legacy path
    }
    return fallbackCopy(text);
}

function wireCopyButton(btn, getText, label) {
    btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ok = await copyToClipboard(getText());
        btn.textContent = ok ? "Copied!" : "Copy failed";
        setTimeout(() => (btn.textContent = label), 1500);
    });
}

wireCopyButton(els.copyJson, () => els.json.textContent, "Copy JSON");
wireCopyButton(els.copyPrompt, () => els.prompt.textContent, "Copy Prompt");

els.close.addEventListener("click", () => {
    window.parent.postMessage({ type: "LN_AI_CLOSE_SIDEBAR" }, "*");
});

// --- Status helper ---------------------------------------------------------

function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle("ln-ai-status--error", isError && !!text);
}

// --- Gemini generation -----------------------------------------------------

els.generate.addEventListener("click", fetchComments);

function geminiUrl(model, key) {
    return (
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
        `:generateContent?key=${encodeURIComponent(key)}`
    );
}

// HTTP statuses worth retrying: rate-limit and Google's transient overloads.
const RETRYABLE_STATUS = new Set([429, 500, 503]);
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff with a little jitter: ~0.9s, ~1.8s between tries.
const backoffMs = (attempt) => 800 * 2 ** (attempt - 1) + Math.random() * 200;

// Call Gemini, retrying transient failures (overload / rate-limit / network)
// with backoff. Returns the parsed JSON body, or throws a friendly Error.
async function callGemini(prompt) {
    const body = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Roomy cap so every enabled style finishes even if the model does internal
        // reasoning first; the actual comments are short so this isn't wasteful.
        generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
    });

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let res;
        try {
            res = await fetch(geminiUrl(settings.model, settings.apiKey), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            });
        } catch {
            // Network-level failure (offline, DNS, etc.) — retryable.
            lastError = new Error("Couldn't reach Gemini. Check your connection.");
            if (attempt < MAX_ATTEMPTS) {
                setStatus(`Connection hiccup, retrying (${attempt}/${MAX_ATTEMPTS})…`);
                await sleep(backoffMs(attempt));
                continue;
            }
            throw lastError;
        }

        const data = await res.json().catch(() => ({}));
        if (res.ok) return data;

        if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
            lastError = new Error(friendlyError(res.status, data));
            setStatus(`Gemini is busy, retrying (${attempt}/${MAX_ATTEMPTS})…`);
            await sleep(backoffMs(attempt));
            continue;
        }

        throw new Error(friendlyError(res.status, data));
    }

    throw lastError || new Error("Gemini request failed.");
}

async function fetchComments() {
    const haveTarget = currentMode === "reply" ? !!currentComment : !!currentPost;
    if (!haveTarget) {
        setStatus(currentMode === "reply" ? "Select a comment first." : "Select a post first.", true);
        return;
    }
    if (!settings.apiKey) {
        setStatus("Add your Gemini API key in Settings (⚙️) first.", true);
        showSettings(true);
        return;
    }
    const styleCount = activeStyles().length;
    if (styleCount === 0) {
        setStatus("Enable at least one comment style in Settings (⚙️).", true);
        showSettings(true);
        return;
    }

    const prompt = buildPrompt(currentPost, settings.experience, els.take.value);

    els.generate.disabled = true;
    setStatus("Generating suggestions…");
    els.results.innerHTML = "";

    try {
        const data = await callGemini(prompt);

        // Gemini can return a candidate with no content if the response was
        // blocked; surface that instead of failing silently.
        const cand = data.candidates && data.candidates[0];
        const blockReason =
            (data.promptFeedback && data.promptFeedback.blockReason) ||
            (cand && cand.finishReason === "SAFETY" ? "SAFETY" : null);
        if (blockReason) {
            throw new Error(`Response was blocked (${blockReason}). Try a different post.`);
        }

        const text = (cand && cand.content && cand.content.parts
            ? cand.content.parts.map((p) => p.text || "").join("")
            : ""
        ).trim();

        if (!text) {
            setStatus("No suggestions returned. Try again.", true);
            return;
        }

        const comments = parseStyledComments(text);
        renderComments(comments);

        // If the model still ran out of room, show what we got but flag it.
        if (cand && cand.finishReason === "MAX_TOKENS") {
            setStatus(
                `Output was cut off after ${comments.length} of ${styleCount} styles. ` +
                    "Generate again for the full set.",
                true
            );
        } else {
            setStatus("");
        }
    } catch (err) {
        setStatus(err.message || "Something went wrong.", true);
    } finally {
        els.generate.disabled = false;
    }
}

function friendlyError(status, data) {
    const apiMsg = data && data.error && data.error.message;
    if (status === 400 && /api key/i.test(apiMsg || "")) {
        return "Invalid API key. Check it in Settings (⚙️).";
    }
    if (status === 429) {
        return "Rate limit hit on the free tier. Wait a minute and retry.";
    }
    if (status === 503 || status === 500) {
        return "Gemini is overloaded right now. Try again shortly, or pick a lighter model in Settings (⚙️).";
    }
    if (status === 403) {
        return "Access denied. Make sure the Generative Language API is enabled for this key.";
    }
    return apiMsg || `Gemini returned ${status}.`;
}

// Split Gemini's "1. Style: comment" output into per-style blocks. Falls back
// to a single card if the model didn't follow the numbered format.
function parseStyledComments(raw) {
    const lines = raw.split(/\r?\n/);
    const blocks = [];
    let cur = null;

    for (const line of lines) {
        const m = line.match(/^\s*(\d)[.)]\s*(.*)$/);
        if (m) {
            if (cur) blocks.push(cur);
            cur = { body: m[2] };
        } else if (cur) {
            cur.body += (cur.body ? "\n" : "") + line;
        }
    }
    if (cur) blocks.push(cur);

    if (!blocks.length) return [{ label: "", text: raw.trim() }];

    return blocks
        .map(({ body }) => {
            let label = "";
            let text = body.trim();
            // Peel off a leading "Style name:" if present.
            const cm = text.match(/^([A-Za-z][A-Za-z\s()\/-]{0,30}?):\s*([\s\S]*)$/);
            if (cm) {
                label = cm[1].trim();
                text = cm[2].trim();
            }
            // Strip wrapping quotes and markdown bold.
            text = text.replace(/^\*+|\*+$/g, "").trim();
            text = text.replace(/^["'“‘]|["'”’]$/g, "").trim();
            return { label, text };
        })
        .filter((b) => b.text);
}

function renderComments(comments) {
    els.results.innerHTML = "";
    comments.forEach(({ label, text }) => {
        const card = document.createElement("div");
        card.className = "ln-ai-suggestion";

        if (label) {
            const lbl = document.createElement("div");
            lbl.className = "ln-ai-suggestion-label";
            lbl.textContent = label;
            card.appendChild(lbl);
        }

        const body = document.createElement("div");
        body.className = "ln-ai-suggestion-text";
        body.textContent = text;
        card.appendChild(body);

        const copyBtn = document.createElement("button");
        copyBtn.className = "ln-ai-copy";
        copyBtn.type = "button";
        copyBtn.textContent = "Copy";
        wireCopyButton(copyBtn, () => text, "Copy");
        card.appendChild(copyBtn);

        els.results.appendChild(card);
    });
}

// --- Boot ------------------------------------------------------------------

loadSettings().then(() => {
    hydrateSettingsForm();
    applyTheme();
    renderPrompt();
});
