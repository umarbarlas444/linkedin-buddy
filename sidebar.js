// Sidebar logic: receives post text from the content script and calls an API
// to fetch recommended comments.

// TODO: point this at your own endpoint. It should accept { text } and return
// either { comments: ["...", "..."] } or { comment: "..." }.
const API_ENDPOINT = "https://your-api.example.com/recommend-comments";

const EXPERIENCE_KEY = "ln_ai_experience";

let currentPost = null;
let currentPostText = "";

const els = {
    json: document.getElementById("ln-ai-json"),
    copyJson: document.getElementById("ln-ai-copy-json"),
    experience: document.getElementById("ln-ai-experience"),
    take: document.getElementById("ln-ai-take"),
    prompt: document.getElementById("ln-ai-prompt"),
    copyPrompt: document.getElementById("ln-ai-copy-prompt"),
    generate: document.getElementById("ln-ai-generate"),
    status: document.getElementById("ln-ai-status"),
    results: document.getElementById("ln-ai-results"),
    close: document.getElementById("ln-ai-close"),
};

// Restore any previously saved experience blurb.
els.experience.value = localStorage.getItem(EXPERIENCE_KEY) || "";

// Assemble the message to paste into an LLM.
function buildPrompt(post, experience, take) {
    if (!post) return "Select a post to generate a prompt.";

    const a = post.author || {};
    const c = post.counts || {};
    const exp = (experience || "").trim();
    const myTake = (take || "").trim();
    const L = [];

    L.push("You are helping me write a thoughtful LinkedIn comment on the post below.");
    L.push("");
    // Only include the "about me" block once the user has actually filled it in.
    if (exp) {
        L.push("=== ABOUT ME (the commenter) ===");
        L.push(exp);
        L.push("");
    }
    L.push("=== POST AUTHOR ===");
    L.push(`Name: ${a.name || "Unknown"}`);
    if (a.jobTitle) L.push(`Current job title / headline: ${a.jobTitle}`);
    if (a.degree) L.push(`Connection degree: ${a.degree}`);
    if (a.profileUrl) L.push(`Profile: ${a.profileUrl}`);
    L.push("");
    L.push("=== POST DETAILS ===");
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
    if (post.reactionTypes && post.reactionTypes.length) {
        L.push(`Reaction types: ${post.reactionTypes.join(", ")}`);
    }
    if (post.hashtags && post.hashtags.length) L.push(`Hashtags: ${post.hashtags.join(" ")}`);
    L.push("");
    L.push("Post text:");
    L.push('"""');
    L.push(post.text || "(no text content)");
    L.push('"""');

    // The user's own rough thoughts / draft, if provided.
    if (myTake) {
        L.push("");
        L.push("=== MY TAKE / DRAFT COMMENT ===");
        L.push(myTake);
    }

    L.push("");
    L.push("=== YOUR TASK ===");
    if (myTake) {
        L.push(
            "Take my rough take / draft above and rewrite it into 5 comment options, one per " +
                "style below. Preserve my core point and personal voice, fix any grammar or " +
                "awkward phrasing, and follow the per-style rules exactly. Don't add hashtags " +
                "unless they clearly add value."
        );
    } else {
        L.push(
            "Write 5 comment options I could post in reply, one per style below. Follow the " +
                "per-style rules exactly." +
                (exp ? " Weave in my background above only where it is genuinely relevant." : "") +
                " Don't add hashtags unless they clearly add value."
        );
    }
    L.push("");
    L.push("Use exactly these 5 styles, each on its own labeled line:");
    L.push("");
    L.push(
        "1. Curious (leads): Ask one specific, hard-to-template question that only makes sense " +
            "after actually reading this post. Reference an exact detail, number, or claim from " +
            'it. Skip throat-clearing like "curious to know" or "quick question." Just ask it. ' +
            "One sentence, occasionally two if the second sets up the first."
    );
    L.push(
        "2. Insightful: Give one real opinion or reframe, not a summary of what the post already " +
            "said. It should sound like something you'd say out loud to a colleague, not a " +
            'takeaway slide. Ban list: no "underscores," "highlights the importance of," "at its ' +
            'core," no -ing tacked-on clauses ("...ensuring better outcomes"). 2 sentences max, ' +
            "plain declarative structure (is/are/has)."
    );
    L.push(
        "3. Story-driven: One line, one concrete detail from your actual work, a tool, a client " +
            "type, a specific bug or number, not a narrative arc. If it doesn't fit in one " +
            "sentence, cut it down rather than adding a second."
    );
    L.push(
        "4. Supportive: Affirm something specific about the post (not the person in general), " +
            "then fold in one light question or detail so it's not just praise sitting there. No " +
            '"great post," no "thanks for sharing," no generic enthusiasm. 1-2 sentences.'
    );
    L.push(
        "5. Witty: One line, one joke, done. No setup-punchline structure that telegraphs itself, " +
            "no forced wordplay. If it needs explaining, cut it."
    );
    L.push("");
    L.push("Across all five:");
    L.push('- No em dashes, no rule-of-three lists, no "it\'s not just X, it\'s Y."');
    L.push('- No signposting ("here\'s the thing," "let\'s be real").');
    L.push("- Contractions where natural, sentence lengths uneven on purpose.");
    L.push(
        "- If a line could've been written about any post in this niche, it's too generic. Anchor " +
            "to something only this post said."
    );
    L.push("");
    L.push("Output only the labeled comment for each style, ready to paste.");

    return L.join("\n");
}

function renderPrompt() {
    els.prompt.textContent = buildPrompt(currentPost, els.experience.value, els.take.value);
}

// Receive the structured post data from the content script
window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.type === "LN_AI_POST_DATA") {
        currentPost = data.post || null;
        currentPostText = (currentPost && currentPost.text) || "";
        els.json.textContent = currentPost
            ? JSON.stringify(currentPost, null, 2)
            : "No post data found.";
        // The draft is specific to a post, so reset it when a new one loads.
        els.take.value = "";
        renderPrompt();
        els.status.textContent = "";
        els.results.innerHTML = "";
    }
});

// Persist the experience blurb and keep the prompt in sync as it's edited.
els.experience.addEventListener("input", () => {
    localStorage.setItem(EXPERIENCE_KEY, els.experience.value);
    renderPrompt();
});

// The per-post draft just refreshes the prompt (not persisted across posts).
els.take.addEventListener("input", renderPrompt);

// Clipboard: try the async API, fall back to execCommand if it's unavailable.
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
        // Stop the click from toggling the surrounding <details> accordion.
        e.preventDefault();
        e.stopPropagation();
        const ok = await copyToClipboard(getText());
        btn.textContent = ok ? "Copied!" : "Copy failed";
        setTimeout(() => (btn.textContent = label), 1500);
    });
}

wireCopyButton(els.copyJson, () => els.json.textContent, "Copy JSON");
wireCopyButton(els.copyPrompt, () => els.prompt.textContent, "Copy Prompt");

// Ask the parent window (content script) to close the sidebar
els.close.addEventListener("click", () => {
    window.parent.postMessage({ type: "LN_AI_CLOSE_SIDEBAR" }, "*");
});

els.generate.addEventListener("click", fetchComments);

async function fetchComments() {
    if (!currentPostText) {
        els.status.textContent = "No post selected yet.";
        return;
    }

    els.generate.disabled = true;
    els.status.textContent = "Generating suggestions…";
    els.results.innerHTML = "";

    try {
        const res = await fetch(API_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: currentPostText }),
        });

        if (!res.ok) {
            throw new Error(`API returned ${res.status}`);
        }

        const data = await res.json();
        const comments = normalizeComments(data);

        if (!comments.length) {
            els.status.textContent = "No suggestions returned.";
            return;
        }

        els.status.textContent = "";
        renderComments(comments);
    } catch (err) {
        els.status.textContent = `Something went wrong: ${err.message}`;
    } finally {
        els.generate.disabled = false;
    }
}

// Accept a few common response shapes
function normalizeComments(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data.map(String);
    if (Array.isArray(data.comments)) return data.comments.map(String);
    if (typeof data.comment === "string") return [data.comment];
    return [];
}

function renderComments(comments) {
    els.results.innerHTML = "";
    comments.forEach((text) => {
        const card = document.createElement("div");
        card.className = "ln-ai-suggestion";
        card.textContent = text;

        const copyBtn = document.createElement("button");
        copyBtn.className = "ln-ai-copy";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(text);
                copyBtn.textContent = "Copied!";
                setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
            } catch {
                copyBtn.textContent = "Copy failed";
            }
        });

        card.appendChild(document.createElement("br"));
        card.appendChild(copyBtn);
        els.results.appendChild(card);
    });
}
