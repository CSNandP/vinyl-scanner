// server.js
// Vinyl Scanner server: barcode -> Discogs -> return cover + album info + "facts[]"

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Node 18+ has fetch built in.
// If you're on an older Node, you’d need node-fetch. (Render usually runs Node 18+.)

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || "";
const DISCOGS_USER_AGENT =
  process.env.DISCOGS_USER_AGENT || "VinylScanner/1.0 (+https://example.com)";

// --------- Simple in-memory cache (keeps API calls down) ----------
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const cache = new Map(); // key -> { ts, data }

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

// --------- Helpers ----------
function pickReleaseFromSearchResults(results = []) {
  // Prefer actual "release" results first
  const releases = results.filter((r) => r.type === "release");
  if (releases.length) return releases[0];
  return results[0] || null;
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function niceJoin(arr, max = 3, sep = " • ") {
  const a = uniq(arr);
  return a.slice(0, max).join(sep);
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function buildFactsFromDiscogsRelease(release) {
  const facts = [];

  // Year / released
  if (release.year) facts.push(`Released: ${release.year}`);

  // Country
  if (release.country) facts.push(`Country: ${release.country}`);

  // Label + catno (from labels array)
  if (Array.isArray(release.labels) && release.labels.length) {
    const l = release.labels[0];
    const labelName = l?.name ? String(l.name) : null;
    const catno = l?.catno ? String(l.catno) : null;

    if (labelName && catno) facts.push(`Label: ${labelName} — ${catno}`);
    else if (labelName) facts.push(`Label: ${labelName}`);
  }

  // Formats (Vinyl, LP, Album etc.)
  if (Array.isArray(release.formats) && release.formats.length) {
    const f = release.formats[0];
    const formatName = f?.name ? String(f.name) : null; // e.g., "Vinyl"
    const qty = f?.qty ? String(f.qty) : null;          // e.g., "1"
    const desc = Array.isArray(f?.descriptions) ? f.descriptions : []; // e.g., ["LP", "Album", "Reissue"]

    const bits = [];
    if (qty && formatName) bits.push(`${qty}× ${formatName}`);
    else if (formatName) bits.push(formatName);

    const d = niceJoin(desc, 3, " / ");
    if (d) bits.push(d);

    if (bits.length) facts.push(`Format: ${bits.join(" — ")}`);
  }

  // Genre / style
  if (Array.isArray(release.genres) && release.genres.length) {
    facts.push(`Genre: ${niceJoin(release.genres, 3)}`);
  }
  if (Array.isArray(release.styles) && release.styles.length) {
    facts.push(`Style: ${niceJoin(release.styles, 3)}`);
  }

  // Community have/want + rating (when available in release.community)
  // Community have/want is commonly present on the release response. :contentReference[oaicite:2]{index=2}
  const have = release?.community?.have;
  const want = release?.community?.want;

  if (Number.isFinite(have) || Number.isFinite(want)) {
    const haveStr = Number.isFinite(have) ? `${have} ${plural(have, "person has", "people have")}` : null;
    const wantStr = Number.isFinite(want) ? `${want} ${plural(want, "person wants", "people want")}` : null;
    facts.push([haveStr, wantStr].filter(Boolean).join(" • "));
  }

  // Rating (sometimes nested)
  const ratingAvg = release?.community?.rating?.average;
  const ratingCount = release?.community?.rating?.count;

  if (Number.isFinite(ratingAvg) && Number.isFinite(ratingCount)) {
    facts.push(`Rating: ${ratingAvg.toFixed(2)} (${ratingCount} ratings)`);
  } else if (Number.isFinite(ratingAvg)) {
    facts.push(`Rating: ${ratingAvg.toFixed(2)}`);
  }

  // Keep it tidy for the Pi screen
  return facts.slice(0, 6);
}

async function fetchJson(url, { timeoutMs = 9000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": DISCOGS_USER_AGENT,
        ...(DISCOGS_TOKEN ? { "Authorization": `Discogs token=${DISCOGS_TOKEN}` } : {}),
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }

    if (!res.ok) {
      const msg = json?.message || json?.error || text || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    return json;
  } finally {
    clearTimeout(t);
  }
}

// --------- API: /api/lookup?barcode= ---------
app.get("/api/lookup", async (req, res) => {
  try {
    const raw = String(req.query.barcode || "");
    const barcode = raw.replace(/\D/g, "");

    if (barcode.length < 10) {
      return res.status(400).json({ error: "Invalid barcode" });
    }

    // Cache
    const cached = cacheGet(barcode);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    // Discogs database search by barcode
    // NOTE: Discogs search lives at api.discogs.com/database/search
    const searchUrl =
      `https://api.discogs.com/database/search?barcode=${encodeURIComponent(barcode)}&type=release&per_page=5`;

    const search = await fetchJson(searchUrl);
    const hit = pickReleaseFromSearchResults(search?.results || []);

    if (!hit) {
      return res.status(404).json({ error: "No match found" });
    }

    // Fetch release details (resource_url is provided in search results)
    const resourceUrl = hit.resource_url;
    if (!resourceUrl) {
      return res.status(500).json({ error: "Missing release URL from Discogs search result" });
    }

    const release = await fetchJson(resourceUrl);

    // Build core fields for your front-end
    const title = release?.title || hit?.title || "";
    const artists = Array.isArray(release?.artists)
      ? release.artists.map((a) => a?.name).filter(Boolean)
      : (hit?.title ? [String(hit.title).split(" - ")[0]] : []);

    const year = release?.year || hit?.year || null;

    const labels = Array.isArray(release?.labels)
      ? uniq(release.labels.map((l) => l?.name))
      : [];

    const cover =
      release?.images?.find((i) => i?.type === "primary")?.uri ||
      release?.thumb ||
      hit?.cover_image ||
      "";

    // Extra fields that the front-end fallback can use too
    const country = release?.country || null;
    const genres = Array.isArray(release?.genres) ? release.genres : [];
    const styles = Array.isArray(release?.styles) ? release.styles : [];

    // Have/want + rating (when present)
    const community = release?.community
      ? {
          have: release.community.have,
          want: release.community.want,
          rating: release.community.rating
            ? { average: release.community.rating.average, count: release.community.rating.count }
            : undefined
        }
      : undefined;

    const stats = {
      have: Number.isFinite(release?.community?.have) ? release.community.have : undefined,
      want: Number.isFinite(release?.community?.want) ? release.community.want : undefined
    };

    // Build facts
    const facts = buildFactsFromDiscogsRelease(release);

    const payload = {
      barcode,
      title,
      artists: uniq(artists),
      year,
      labels,
      cover,

      // extras
      country,
      genres,
      styles,
      community,
      stats,

      // the new thing your UI will show
      facts
    };

    cacheSet(barcode, payload);
    return res.json(payload);
  } catch (err) {
    const status = err?.status || 500;

    // Friendly handling for rate limiting / Discogs hiccups
    if (status === 429) {
      return res.status(429).json({ error: "Rate limited by Discogs. Try again shortly." });
    }

    return res.status(status).json({ error: err?.message || "Server error" });
  }
});

// --------- Static site ----------
app.use(express.static(path.join(__dirname, "public")));

// Fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`VinylScanner listening on ${PORT}`);
});
