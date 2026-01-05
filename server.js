const express = require("express");
const fs = require("fs");

const app = express();
app.use(express.static("public"));

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
const PORT = process.env.PORT || 3000;

if (!DISCOGS_TOKEN) {
  console.error("Missing DISCOGS_TOKEN environment variable (set it in Render)");
  process.exit(1);
}

const CACHE_FILE = "./cache.json";
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
} catch {
  cache = {};
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("Failed to write cache:", e);
  }
}

function digitsOnly(s) {
  return (s || "").replace(/\D/g, "");
}

// Flatten Discogs tracklist, including any nested sub_tracks
function flattenTracklist(tracklist = []) {
  const out = [];

  for (const t of tracklist) {
    if (!t) continue;

    if (Array.isArray(t.sub_tracks) && t.sub_tracks.length) {
      for (const st of t.sub_tracks) {
        out.push({
          position: st.position || t.position || "",
          title: (st.title || "").trim(),
          duration: (st.duration || "").trim()
        });
      }
    } else {
      out.push({
        position: (t.position || "").trim(),
        title: (t.title || "").trim(),
        duration: (t.duration || "").trim()
      });
    }
  }

  return out.filter(x => x.title);
}

// Node 18+ has global fetch
async function discogsFetch(path) {
  const url = `https://api.discogs.com${path}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "VinylScanner/1.0",
      "Authorization": `Discogs token=${DISCOGS_TOKEN}`,
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discogs ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

app.get("/api/lookup", async (req, res) => {
  try {
    const barcode = digitsOnly(req.query.barcode);

    if (!barcode || barcode.length < 10) {
      return res.status(400).json({ error: "Invalid barcode (needs 10+ digits)" });
    }

    // Return cached result if we have it
    if (cache[barcode]) {
      return res.json({ ...cache[barcode], cached: true });
    }

    // 1) Search Discogs by barcode
    const search = await discogsFetch(
      `/database/search?barcode=${encodeURIComponent(barcode)}&type=release&per_page=10&page=1`
    );

    const results = search.results || [];
    const best = results.find(r => r.type === "release") || results[0];

    if (!best || !best.id) {
      return res.status(404).json({ error: "No match found on Discogs" });
    }

    // 2) Fetch full release details
    const release = await discogsFetch(`/releases/${best.id}`);

    const artists = (release.artists || []).map(a => a.name).filter(Boolean);
    const labels = (release.labels || []).map(l => l.name).filter(Boolean);

    const cover =
      (release.images && release.images.find(i => i.type === "primary")?.uri) ||
      (release.images && release.images[0]?.uri) ||
      release.thumb ||
      null;

    const payload = {
      barcode,
      releaseId: best.id,
      title: release.title || best.title || "",
      artists,
      year: release.year || null,
      labels,
      genres: release.genres || [],
      styles: release.styles || [],
      cover,
      discogsUrl: release.uri ? `https://www.discogs.com${release.uri}` : null,

      // NEW: Track listing
      tracklist: flattenTracklist(release.tracklist || [])
    };

    cache[barcode] = payload;
    saveCache();

    res.json({ ...payload, cached: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
});
