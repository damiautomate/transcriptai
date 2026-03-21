const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "../public")));

/* ── Health check (Railway uses this) ── */
app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

/* ══════════════════════════════════════════════════════════
   YOUTUBE TRANSCRIPT ENDPOINT
   ══════════════════════════════════════════════════════════ */
app.get("/api/youtube/:videoId", async (req, res) => {
  const { videoId } = req.params;
  console.log(`[YouTube] Fetching transcript for: ${videoId}`);

  try {
    // METHOD 1: Invidious API (most reliable)
    const INSTANCES = [
      "https://inv.nadeko.net",
      "https://invidious.nerdvpn.de",
      "https://iv.datura.network",
      "https://invidious.privacyredirect.com",
      "https://vid.puffyan.us",
    ];

    for (const instance of INSTANCES) {
      try {
        console.log(`[YouTube] Trying Invidious: ${instance}`);
        const infoR = await fetch(
          `${instance}/api/v1/videos/${videoId}?fields=title,captions,lengthSeconds`,
          { timeout: 10000 }
        );
        if (!infoR.ok) continue;
        const info = await infoR.json();

        const caps = info.captions;
        if (!caps || caps.length === 0) continue;

        const track =
          caps.find((c) => c.language_code === "en") ||
          caps.find((c) => c.language_code?.startsWith("en")) ||
          caps[0];
        if (!track) continue;

        const capUrl = track.url?.startsWith("http")
          ? track.url
          : `${instance}${track.url}`;
        const capR = await fetch(capUrl, { timeout: 10000 });
        if (!capR.ok) continue;
        const capXml = await capR.text();

        // Parse XML
        const entries = parseCapXml(capXml);
        if (entries.length === 0) continue;

        console.log(`[YouTube] Success via ${instance} — ${entries.length} entries`);
        return res.json({
          success: true,
          title: info.title || "YouTube Video",
          language: track.language_code || "en",
          totalDuration: info.lengthSeconds || 0,
          entries,
        });
      } catch (_) {
        continue;
      }
    }

    // METHOD 2: Direct YouTube page scraping
    console.log("[YouTube] Invidious failed, trying direct scraping...");
    const ytR = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });
    if (!ytR.ok) throw new Error("Could not reach YouTube.");
    const html = await ytR.text();

    // Extract title
    const tMatch = html.match(/<title>(.*?)<\/title>/);
    const title = tMatch
      ? tMatch[1].replace(/ - YouTube$/, "").trim()
      : "YouTube Video";

    // Extract caption tracks
    const capMatch = html.match(/"captionTracks"\s*:\s*(\[.*?\])/);
    if (!capMatch) throw new Error("No captions found for this video.");

    let tracks;
    try {
      tracks = JSON.parse(capMatch[1]);
    } catch (_) {
      throw new Error("Failed to parse caption data.");
    }

    const track =
      tracks.find((t) => t.languageCode === "en") ||
      tracks.find((t) => t.languageCode?.startsWith("en")) ||
      tracks[0];
    if (!track?.baseUrl) throw new Error("No usable caption track.");

    const capR2 = await fetch(track.baseUrl, { timeout: 10000 });
    if (!capR2.ok) throw new Error("Could not download captions.");
    const capXml2 = await capR2.text();

    const entries = parseCapXml(capXml2);
    if (entries.length === 0) throw new Error("Transcript was empty.");

    console.log(`[YouTube] Success via direct scrape — ${entries.length} entries`);
    return res.json({
      success: true,
      title,
      language: track.languageCode || "en",
      totalDuration: entries[entries.length - 1]?.timestamp || 0,
      entries,
    });
  } catch (err) {
    console.error(`[YouTube] Error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Parse YouTube caption XML into paragraphs ── */
function parseCapXml(xml) {
  const raw = [];
  const regex = /<text\s+start="([^"]+)"(?:\s+dur="([^"]*)")?\s*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = match[3]
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
      .replace(/\n/g, " ").trim();
    if (text) {
      raw.push({
        start: parseFloat(match[1]),
        duration: parseFloat(match[2] || "0"),
        text,
      });
    }
  }

  // Group into ~30s paragraphs
  const paragraphs = [];
  if (raw.length === 0) return [];
  let cur = { start: raw[0].start, texts: [] };
  raw.forEach((e, i) => {
    cur.texts.push(e.text);
    const next = raw[i + 1];
    const elapsed = e.start - cur.start;
    const gap = next ? next.start - e.start - e.duration : 0;
    if (elapsed > 30 || gap > 2.5 || i === raw.length - 1) {
      paragraphs.push({ timestamp: cur.start, text: cur.texts.join(" ") });
      if (next) cur = { start: next.start, texts: [] };
    }
  });
  return paragraphs;
}

/* ══════════════════════════════════════════════════════════
   FILE TRANSCRIPTION ENDPOINT (Whisper via HuggingFace)
   ══════════════════════════════════════════════════════════ */
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded." });

  console.log(`[Transcribe] Processing: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

  const mimeMap = {
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac",
    ogg: "audio/ogg", aac: "audio/aac", wma: "audio/x-ms-wma", opus: "audio/opus",
    mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
    mkv: "video/x-matroska", webm: "video/webm",
  };
  const ext = req.file.originalname.split(".").pop().toLowerCase();
  const mime = mimeMap[ext] || req.file.mimetype || "audio/mpeg";

  try {
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`[Transcribe] Attempt ${attempt + 1}/3 with Whisper...`);
        const r = await fetch(
          "https://api-inference.huggingface.co/models/openai/whisper-small",
          {
            method: "POST",
            headers: { "Content-Type": mime },
            body: req.file.buffer,
            timeout: 120000,
          }
        );

        if (r.ok) {
          result = await r.json();
          break;
        }

        const errBody = await r.json().catch(() => ({}));
        if (errBody.error?.includes("loading") || r.status === 503) {
          console.log("[Transcribe] Model loading, waiting 15s...");
          await new Promise((r) => setTimeout(r, 15000));
          continue;
        }
        if (r.status === 429) {
          console.log("[Transcribe] Rate limited, waiting 10s...");
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        throw new Error(errBody.error || `Whisper API returned HTTP ${r.status}`);
      } catch (fetchErr) {
        if (attempt === 2) throw fetchErr;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (!result) throw new Error("Transcription service unavailable after retries.");

    // Parse result
    let entries = [];
    if (result.chunks && result.chunks.length > 0) {
      entries = result.chunks
        .map((ch) => ({
          timestamp: ch.timestamp?.[0] ?? 0,
          text: (ch.text || "").trim(),
        }))
        .filter((e) => e.text);
    } else if (result.text) {
      const sentences = result.text.match(/[^.!?]+[.!?]+/g) || [result.text];
      const totalChars = sentences.reduce((s, t) => s + t.length, 0);
      let elapsed = 0;
      entries = sentences
        .map((s) => {
          const entry = { timestamp: elapsed, text: s.trim() };
          elapsed += (s.length / totalChars) * (sentences.length * 5);
          return entry;
        })
        .filter((e) => e.text);
    }

    // Group into paragraphs
    const paragraphs = [];
    if (entries.length > 0) {
      let cur = { timestamp: entries[0].timestamp, texts: [] };
      entries.forEach((e, i) => {
        cur.texts.push(e.text);
        const next = entries[i + 1];
        const elapsed = (next?.timestamp || e.timestamp) - cur.timestamp;
        if (elapsed > 25 || i === entries.length - 1) {
          paragraphs.push({ timestamp: cur.timestamp, text: cur.texts.join(" ") });
          if (next) cur = { timestamp: next.timestamp, texts: [] };
        }
      });
    }

    console.log(`[Transcribe] Success — ${paragraphs.length} paragraphs`);
    res.json({ success: true, entries: paragraphs.length > 0 ? paragraphs : entries });
  } catch (err) {
    console.error(`[Transcribe] Error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════
   CLAUDE AI ANALYSIS ENDPOINT
   ══════════════════════════════════════════════════════════ */
app.post("/api/analyze", async (req, res) => {
  const { system, prompt } = req.body;
  console.log("[AI] Running analysis...");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
      timeout: 30000,
    });

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Claude API HTTP ${r.status}: ${err.slice(0, 200)}`);
    }

    const data = await r.json();
    const text = data.content?.map((b) => b.text || "").join("") || "";
    console.log("[AI] Analysis complete");
    res.json({ success: true, text });
  } catch (err) {
    console.error("[AI] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Catch-all: serve frontend ── */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

/* ── Start server ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         TranscriptAI Server              ║
  ║                                          ║
  ║   Running on port: ${PORT}                  ║
  ║                                          ║
  ║   YouTube:  ✅ Ready                      ║
  ║   Upload:   ✅ Ready (Whisper AI)         ║
  ║   AI:       ${process.env.ANTHROPIC_API_KEY ? "✅ Ready" : "⚠️  Set ANTHROPIC_API_KEY"}              ║
  ╚══════════════════════════════════════════╝
  `);
});
