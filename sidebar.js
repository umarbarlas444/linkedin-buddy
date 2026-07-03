// Sidebar logic: receives post text from the content script and calls an API
// to fetch recommended comments.

// TODO: point this at your own endpoint. It should accept { text } and return
// either { comments: ["...", "..."] } or { comment: "..." }.
const API_ENDPOINT = "https://your-api.example.com/recommend-comments";

const EXPERIENCE_KEY = "ln_ai_experience";
const EXPERIENCE_PLACEHOLDER = "[PASTE YOUR EXPERIENCE / INTRODUCTION HERE]";

let currentPost = null;
let currentPostText = "";

const els = {
    json: document.getElementById("ln-ai-json"),
    copyJson: document.getElementById("ln-ai-copy-json"),
    experience: document.getElementById("ln-ai-experience"),
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
function buildPrompt(post, experience) {
    if (!post) return "Select a post to generate a prompt.";

    const a = post.author || {};
    const c = post.counts || {};
    const exp = (experience || "").trim() || EXPERIENCE_PLACEHOLDER;
    const L = [];

    L.push("You are helping me write a thoughtful LinkedIn comment on the post below.");
    L.push("");
    L.push("=== ABOUT ME (the commenter) ===");
    L.push(exp);
    L.push("");
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
    L.push("");
    L.push("=== YOUR TASK ===");
    L.push(
        "Write 5 comment options I could post in reply, each in a DISTINCT style. " +
            "Keep each 1–3 sentences, natural and human (never robotic), avoid generic filler " +
            'like "Great post!", and weave in my background above only where it is genuinely ' +
            "relevant. Don't add hashtags unless they clearly add value."
    );
    L.push("");
    L.push("Use exactly these 5 styles, each on its own labeled line:");
    L.push("1. Insightful — add a sharp, value-adding perspective or takeaway.");
    L.push("2. Supportive — warm, encouraging and affirming.");
    L.push("3. Curious — ask a genuine, thoughtful question that invites a reply.");
    L.push("4. Story-driven — briefly relate the post to my own experience.");
    L.push("5. Witty — light and clever while staying professional.");
    L.push("");
    L.push("Output only the labeled comment for each style, ready to paste.");

    return L.join("\n");
}

function renderPrompt() {
    els.prompt.textContent = buildPrompt(currentPost, els.experience.value);
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

// Copy the raw JSON to the clipboard
els.copyJson.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(els.json.textContent);
        els.copyJson.textContent = "Copied!";
        setTimeout(() => (els.copyJson.textContent = "Copy JSON"), 1500);
    } catch {
        els.copyJson.textContent = "Copy failed";
    }
});

// Copy the generated LLM prompt to the clipboard
els.copyPrompt.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(els.prompt.textContent);
        els.copyPrompt.textContent = "Copied!";
        setTimeout(() => (els.copyPrompt.textContent = "Copy Prompt"), 1500);
    } catch {
        els.copyPrompt.textContent = "Copy failed";
    }
});

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
