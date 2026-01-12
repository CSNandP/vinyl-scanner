// server.js — Discogs for match + cover, Wikipedia/Discogs for human facts (with sources)
// CommonJS (works with your current package.json)

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || "";
const DISCOGS_USER_AGENT =
  process.env.DISCOGS_USER_AGENT || "VinylScanner/1.0 (+https://example.com)";

// ---------------- Cache ----------------
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

// ---------------- Utilities ----------------
function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function cleanSentence(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\[[^\]]+\]/g, "") // remove [1] citations
    .replace(/\u00a0/g, " ")
    .trim();
}

// Prefer “story” sentences; avoid bland definitional lines
function looksInteresting(s) {
  const t = cleanSentence(s);
  if (t.length < 55 || t.length > 200) return false;
  if (/may refer to|can refer to|may also refer to/i.test(t)) return false;
  if (/is an album by/i.test(t)) return false;
  if (/studio album by/i.test(t)) return false;
  return true;
}

async function fetchJson(url, headers = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------------- Wikipedia facts ----------------
// Try a couple of likely page titles
async function fetchWikipediaFacts(artist, album) {
  const candidates = [
    `${album} (${artist} album)`,
    `${album} (album)`,
    `${album}`, // last resort
  ];

  for (const title of candidates) {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    try {
      const data = await fetchJson(url, {
        "User-Agent": DISCOGS_USER_AGENT,
        "Accept": "application/json"
      });

      const extract = cleanSentence(data.extract || "");
      if (!extract) continue;

      // Split into sentences
      const sentences = extract.split(/(?<=\.)\s+/)
        .map(cleanSentence)
        .filter(looksInteresting);

      // If the summary is too “definition-y”, still keep a couple but prefer the more narrative ones
      const picked = sentences.slice(0, 4);

      if (picked.length) {
        return picked.map((text) => ({ text, source: "Wikipedia" }));
      }
    } catch {
      // try next candidate
    }
  }

  return [];
}

// ---------------- Discogs helpers ----------------
function pickRelease(results = []) {
  return results.find(r => r.type === "release") || results[0] || null;
}

async function discogsFetch(url) {
  return fetchJson(url, {
    "User-Agent": DISCOGS_USER_AGENT,
    ...(DISCOGS_TOKEN ? { "Authorization": `Discogs token=${DISCOGS_TOKEN}` } : {}),
    "Accept": "application/json"
  });
}

// ---------------- API ----------------
app.get("/api/lookup", async (req, res) => {
  try {
    const barcode = String(req.query.barcode || "").replace(/\D/g, "");
    if (barcode.length < 10) {
      return res.status(400).json({ error: "Invalid barcode" });
    }

    const cached = cacheGet(barcode);
    if (cached) return res.json({ ...cached, cached: true });

    // Discogs search by barcode
    const search = await discogsFetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&type=release&per_page=5`
    );

    const hit = pickRelease(search.results || []);
    if (!hit) return res.status(404).json({ error: "No match found" });

    const release = await discogsFetch(hit.resource_url);

    const title = release.title || (hit.title || "");
    const artist =
      Array.isArray(release.artists) && release.artists[0]
        ? release.artists[0].name
        : (hit.title ? String(hit.title).split(" - ")[0] : "");

    const cover =
      release.images?.find(i => i.type === "primary")?.uri ||
      release.thumb ||
      hit.cover_image ||
      "";

    const year = release.year || hit.year || null;
    const labels = uniq((release.labels || []).map(l => l.name));

    // -------- Facts (quote-style) --------
    let facts = [];

    // Wikipedia summary facts first (human story)
    const wikiFacts = await fetchWikipediaFacts(artist, title);
    facts.push(...wikiFacts);

    // Discogs notes can be lovely (collector anecdotes)
    if (release.notes) {
      const noteSentences = String(release.notes)
        .split(/(?<=\.)\s+/)
        .map(cleanSentence)
        .filter(looksInteresting)
        .slice(0, 2)
        .map((text) => ({ text, source: "Discogs" }));

      facts.push(...noteSentences);
    }

    // Gentle fallback (still human-ish), but clearly not “gossip”
    if (!facts.length) {
      const fallbackBits = [];
      if (year) fallbackBits.push(`Released in ${year}.`);
      if (labels[0]) fallbackBits.push(`Issued on ${labels[0]}.`);
      if (fallbackBits.length) {
        facts.push({ text: fallbackBits.join(" "), source: "Discogs" });
      } else {
        facts.push({ text: "No extra facts available yet.", source: "Discogs" });
      }
    }

    // Deduplicate by text
    const seen = new Set();
    facts = facts.filter(f => {
      const k = (f.text || "").toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 6);

    const payload = {
      barcode,
      title,
      artists: [artist].filter(Boolean),
      year,
      labels,
      cover,
      facts
    };

    cacheSet(barcode, payload);
    res.json(payload);

  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ---------------- Static ----------------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(PORT, () =>
  console.log(`VinylScanner running on ${PORT}`)
);
