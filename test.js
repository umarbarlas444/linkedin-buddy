// Minimal self-check for the srcset parser in content.js. No framework:
//   node test.js
// content.js boots against a live DOM on load, so we pull just the function
// under test out of the source and evaluate it against a stubbed `location`.

const assert = require("assert");
const fs = require("fs");

const src = fs.readFileSync(`${__dirname}/content.js`, "utf8");
const fn = src.match(/function bestImageSrc\(img\) \{[\s\S]*?\n\}/);
assert.ok(fn, "bestImageSrc not found in content.js");

const location = { href: "https://www.linkedin.com/feed/" };
const bestImageSrc = new Function("location", `${fn[0]}; return bestImageSrc;`)(location);

const img = (src, srcset) => ({
    src,
    getAttribute: (n) => (n === "srcset" ? srcset || null : null),
});

// No srcset: fall through to src.
assert.strictEqual(
    bestImageSrc(img("https://media.licdn.com/a.jpg")),
    "https://media.licdn.com/a.jpg"
);

// Picks the widest candidate, not the first or last.
assert.strictEqual(
    bestImageSrc(
        img(
            "https://media.licdn.com/tiny.jpg",
            "https://media.licdn.com/800.jpg 800w, https://media.licdn.com/1600.jpg 1600w, https://media.licdn.com/400.jpg 400w"
        )
    ),
    "https://media.licdn.com/1600.jpg"
);

// Relative candidates resolve against the page URL.
assert.strictEqual(
    bestImageSrc(img("https://media.licdn.com/tiny.jpg", "/dms/big.jpg 1200w")),
    "https://www.linkedin.com/dms/big.jpg"
);

// Descriptor-less or density-only srcset has no width to compare, so keep src
// rather than gambling on an arbitrary candidate.
assert.strictEqual(
    bestImageSrc(img("https://media.licdn.com/a.jpg", "https://media.licdn.com/b.jpg")),
    "https://media.licdn.com/a.jpg"
);
assert.strictEqual(
    bestImageSrc(img("https://media.licdn.com/a.jpg", "https://media.licdn.com/b.jpg 2x")),
    "https://media.licdn.com/a.jpg"
);

console.log("bestImageSrc: 5 assertions passed");
