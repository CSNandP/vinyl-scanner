// server.js — Wiki-style album facts (human, anecdotal)

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
  return s
    .replace(/\s+/g, " ")
    .replace(/\[[^\]]+\]/g, "") // remove [1] citations
    .trim();
}

function looksInteresting(s) {
  return (
    s.length > 50 &&
    s.length < 180 &&
    !s.match(/may refer to|can refer to|is an album by/i)
  );
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------- Wikipedia facts ----------------
async function fetchWikipediaFacts(artist, album) {
  const title = `${album} (${artist} album)`;
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

  try {
    const data = await fetchJson(url, {
      "User-Agent": DISCOGS_USER_AGENT,
      "Accept": "application/json"
    });

    const text = data.extract || "";
    const sentences = text.split(/(?<=\.)\s+/);

    return sentences
      .map(cleanSentence)
      .filter(looksInteresting)
      .slice(0, 4);
  } catch {
    return [];
  }
}

// ---------------- Discogs helpers ----------------
function pickRelease(results = []) {
  return results.find(r => r.type === "release") || results[0] || null;
}

async function discogsFetch(url) {
  return fetchJson(url, {
    "User-Agent": DISCOGS_USER_AGENT,
    ...(DISCOGS_TOKEN ? { "Authorization": `Discogs token=${DISCOGS_TOKEN}` } : {})
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

    // Discogs search
    const search = await discogsFetch(
      `https://api.discogs.com/database/search?barcode=${barcode}&type=release&per_page=5`
    );

    const hit = pickRelease(search.results);
    if (!hit) return res.status(404).json({ error: "No match found" });

    const release = await discogsFetch(hit.resource_url);

    const title = release.title;
    const artist =
      Array.isArray(release.artists) && release.artists[0]
        ? release.artists[0].name
        : "";

    const cover =
      release.images?.find(i => i.type === "primary")?.uri ||
      release.thumb ||
      hit.cover_image ||
      "";

    const year = release.year || null;
    const labels = uniq(release.labels?.map(l => l.name));

    // -------- Collect facts --------
    let facts = [];

    // Wikipedia first (story-driven)
    const wikiFacts = await fetchWikipediaFacts(artist, title);
    facts.push(...wikiFacts);

    // Discogs notes (often anecdotal)
    if (release.notes) {
      const noteSentences = release.notes
        .split(/(?<=\.)\s+/)
        .map(cleanSentence)
        .filter(looksInteresting)
        .slice(0, 2);

      facts.push(...noteSentences);
    }

    // Gentle fallback if still sparse
    if (!facts.length && year) {
      facts.push(`Released in ${year}, this album marked an important moment in the artist’s career.`);
    }

    facts = uniq(facts).slice(0, 5);

    const payload = {
      barcode,
      title,
      artists: [artist],
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
