"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.static("public"));

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
const PORT = process.env.PORT || 3000;

if (!DISCOGS_TOKEN) {
  console.error("Missing DISCOGS_TOKEN environment variable (set it in Render → Environment)");
  process.exit(1);
}

// ---- Simple file cache (so you don't hammer Discogs) ----
const CACHE_FILE = path.join(__dirname, "cache.json");
let cache = {};

try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
} catch (e) {
  cache = {};
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("Failed to write cache.json:", e && e.message ? e.message : e);
  }
}

// ---- Helpers ----
function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function flattenTracklist(tracklist) {
  const out = [];
  const list = Array.isArray(tracklist) ? tracklist : [];

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t) continue;

    if (t.sub_tracks && Array.isArray(t.sub_tracks) && t.sub_tracks.length) {
      for (let j = 0; j < t.sub_tracks.length; j++) {
        const st = t.sub_tracks[j];
        if (!st) continue;

        out.push({
          position: (st.position || t.position || "").trim(),
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

  return out.filter(function (x) {
    return x && x.title && x.title.length > 0;
  });
}

function isAllowedImageHost(urlObj) {
  const host = (urlObj.hostname || "").toLowerCase();
  // Tight-ish whitelist: Discogs image hosts commonly include i.discogs.com
  // Keep it simple but safe.
  if (host === "i.discogs.com") return true;
  if (host.endsWith(".discogs.com")) return true;
  return false;
}

// Node 18+ has global fetch; Render normally provides modern Node.
async function discogsFetchJson(discogsPath) {
  const url = "https://api.discogs.com" + discogsPath;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "VinylScanner/1.0",
      "Authorization": "Discogs token=" + DISCOGS_TOKEN,
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Discogs " + res.status + ": " + text.slice(0, 200));
  }

  return res.json();
}

// ---- NEW: image proxy so the Pi can load covers + we can sample colours safely ----
app.get("/img", async function (req, res) {
  try {
    const raw = String(req.query.url || "");
    if (!raw) return res.status(400).send("Missing url");

    let u;
    try {
      u = new URL(raw);
    } catch {
      return res.status(400).send("Bad url");
    }

    if (u.protocol !== "https:") return res.status(400).send("Only https allowed");
    if (!isAllowedImageHost(u)) return res.status(403).send("Host not allowed");

    const upstream = await fetch(u.toString(), {
      headers: { "User-Agent": "VinylScanner/1.0" }
    });

    if (!upstream.ok) {
      return res.status(502).send("Upstream image fetch failed");
    }

    const ct = upstream.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await upstream.arrayBuffer());

    // Allow browser to read pixels (for canvas sampling)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", ct);
    // Cache a bit to reduce repeated downloads
    res.setHeader("Cache-Control", "public, max-age=86400");

    return res.send(buf);
  } catch (e) {
    console.error("IMG proxy error:", e);
    return res.status(500).send("Image proxy error");
  }
});

// ---- API ----
app.get("/api/lookup", async function (req, res) {
  try {
    const barcode = digitsOnly(req.query.barcode);

    if (!barcode || barcode.length < 10) {
      return res.status(400).json({ error: "Invalid barcode (needs 10+ digits)" });
    }

    if (cache[barcode]) {
      const cachedPayload = Object.assign({}, cache[barcode], { cached: true });
      return res.json(cachedPayload);
    }

    const search = await discogsFetchJson(
      "/database/search?barcode=" +
        encodeURIComponent(barcode) +
        "&type=release&per_page=10&page=1"
    );

    const results = Array.isArray(search.results) ? search.results : [];
    let best = null;

    for (let i = 0; i < results.length; i++) {
      if (results[i] && results[i].type === "release" && results[i].id) {
        best = results[i];
        break;
      }
    }
    if (!best && results.length && results[0] && results[0].id) best = results[0];

    if (!best || !best.id) {
      return res.status(404).json({ error: "No match found on Discogs" });
    }

    const release = await discogsFetchJson("/releases/" + best.id);

    // Pick a cover URL (prefer primary)
    let coverUrl = null;
    if (release && release.images && Array.isArray(release.images) && release.images.length) {
      for (let i = 0; i < release.images.length; i++) {
        const img = release.images[i];
        if (img && img.type === "primary" && img.uri) {
          coverUrl = img.uri;
          break;
        }
      }
      if (!coverUrl && release.images[0] && release.images[0].uri) coverUrl = release.images[0].uri;
    }
    if (!coverUrl && release && release.thumb) coverUrl = release.thumb;

    // IMPORTANT: return proxied cover URL so browser can display + sample colours
    const cover = coverUrl ? ("/img?url=" + encodeURIComponent(coverUrl)) : null;

    const artists = [];
    if (release && Array.isArray(release.artists)) {
      for (let i = 0; i < release.artists.length; i++) {
        const a = release.artists[i];
        if (a && a.name) artists.push(a.name);
      }
    }

    const labels = [];
    if (release && Array.isArray(release.labels)) {
      for (let i = 0; i < release.labels.length; i++) {
        const l = release.labels[i];
        if (l && l.name) labels.push(l.name);
      }
    }

    const payload = {
      barcode: barcode,
      releaseId: best.id,
      title: (release && release.title) ? release.title : "",
      artists: artists,
      year: (release && release.year) ? release.year : null,
      labels: labels,
      cover: cover,
      tracklist: flattenTracklist(release ? release.tracklist : [])
    };

    cache[barcode] = payload;
    saveCache();

    return res.json(Object.assign({}, payload, { cached: false }));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err && err.message ? err.message : "Unknown error" });
  }
});

app.listen(PORT, () => {
  console.log("Running on http://localhost:" + PORT);
});
