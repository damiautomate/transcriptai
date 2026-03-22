const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: "50mb" }));

app.get("/api/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

/* ══════════════════════════════════════════════════════════
   YOUTUBE TRANSCRIPT ENDPOINT
   ══════════════════════════════════════════════════════════ */
app.get("/api/youtube/:videoId", async (req, res) => {
  const { videoId } = req.params;
  console.log(`[YouTube] Fetching transcript for: ${videoId}`);

  try {
    // ── METHOD 1: Invidious API ──
    const INSTANCES = [
      "https://inv.nadeko.net",
      "https://invidious.nerdvpn.de",
      "https://iv.datura.network",
      "https://yewtu.be",
      "https://inv.tux.pizza",
      "https://invidious.fdn.fr",
      "https://invidious.protokolla.fi",
    ];

    for (const instance of INSTANCES) {
      try {
        console.log(`[YouTube] Trying Invidious: ${instance}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const infoR = await fetch(`${instance}/api/v1/videos/${videoId}?fields=title,captions,lengthSeconds`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!infoR.ok) { console.log(`[YouTube] ${instance} returned ${infoR.status}`); continue; }
        const info = await infoR.json();
        const caps = info.captions;
        if (!caps || caps.length === 0) { console.log(`[YouTube] ${instance} — no captions`); continue; }
        const track = caps.find(c => c.language_code === "en") || caps.find(c => c.language_code?.startsWith("en")) || caps[0];
        if (!track) continue;
        const capUrl = track.url?.startsWith("http") ? track.url : `${instance}${track.url}`;
        console.log(`[YouTube] Fetching captions: ${capUrl.slice(0, 100)}...`);
        const capR = await fetch(capUrl);
        if (!capR.ok) { console.log(`[YouTube] Caption fetch failed: ${capR.status}`); continue; }
        const capText = await capR.text();
        console.log(`[YouTube] Caption length: ${capText.length}, preview: ${capText.slice(0, 100)}`);
        const entries = parseCapXml(capText);
        if (entries.length === 0) { console.log(`[YouTube] Parsed 0 entries from XML`); continue; }
        console.log(`[YouTube] SUCCESS via ${instance} — ${entries.length} entries`);
        return res.json({ success: true, title: info.title || "YouTube Video", language: track.language_code || "en", totalDuration: info.lengthSeconds || 0, entries });
      } catch (e) { console.log(`[YouTube] ${instance} error: ${e.message}`); continue; }
    }

    // ── METHOD 2: Direct YouTube + JSON3 format ──
    console.log("[YouTube] Invidious all failed. Trying direct YouTube...");
    const ytR = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (!ytR.ok) throw new Error(`YouTube returned HTTP ${ytR.status}`);
    const html = await ytR.text();
    console.log(`[YouTube] Page length: ${html.length}`);

    const tMatch = html.match(/<title>(.*?)<\/title>/);
    const title = tMatch ? tMatch[1].replace(/ - YouTube$/, "").trim() : "YouTube Video";

    const capMatch = html.match(/"captionTracks"\s*:\s*(\[.*?\])/);
    if (!capMatch) {
      if (html.includes("Sign in to confirm")) throw new Error("Age-restricted video. Try a different one.");
      console.log(`[YouTube] No captionTracks in page. 'captions' present: ${html.includes("captions")}`);
      throw new Error("No captions found for this video.");
    }

    let tracks;
    try { tracks = JSON.parse(capMatch[1]); } catch (_) { throw new Error("Failed to parse captions."); }
    console.log(`[YouTube] ${tracks.length} tracks: ${tracks.map(t => `${t.languageCode}(${t.kind || "manual"})`).join(", ")}`);

    const track = tracks.find(t => t.languageCode === "en") || tracks.find(t => t.languageCode?.startsWith("en")) || tracks[0];
    if (!track?.baseUrl) throw new Error("No caption URL found.");

    // ── Try JSON3 first ──
    console.log("[YouTube] Trying JSON3 format...");
    try {
      const j3Url = track.baseUrl + "&fmt=json3";
      const j3R = await fetch(j3Url);
      if (j3R.ok) {
        const j3 = await j3R.json();
        if (j3.events) {
          const entries = parseJson3(j3);
          if (entries.length > 0) {
            console.log(`[YouTube] SUCCESS via JSON3 — ${entries.length} entries`);
            return res.json({ success: true, title, language: track.languageCode || "en", totalDuration: entries[entries.length - 1]?.timestamp || 0, entries });
          }
          console.log(`[YouTube] JSON3 had ${j3.events.length} events but parsed 0 entries`);
        }
      }
    } catch (e) { console.log(`[YouTube] JSON3 error: ${e.message}`); }

    // ── Try srv3 ──
    console.log("[YouTube] Trying srv3 format...");
    try {
      const s3Url = track.baseUrl + "&fmt=srv3";
      const s3R = await fetch(s3Url);
      if (s3R.ok) {
        const s3Text = await s3R.text();
        console.log(`[YouTube] srv3 length: ${s3Text.length}, preview: ${s3Text.slice(0, 120)}`);
        const entries = parseSrv3(s3Text);
        if (entries.length > 0) {
          console.log(`[YouTube] SUCCESS via srv3 — ${entries.length} entries`);
          return res.json({ success: true, title, language: track.languageCode || "en", totalDuration: entries[entries.length - 1]?.timestamp || 0, entries });
        }
      }
    } catch (e) { console.log(`[YouTube] srv3 error: ${e.message}`); }

    // ── Try plain XML ──
    console.log("[YouTube] Trying plain XML...");
    const capR = await fetch(track.baseUrl);
    if (!capR.ok) throw new Error(`Caption download HTTP ${capR.status}`);
    const capXml = await capR.text();
    console.log(`[YouTube] XML length: ${capXml.length}, preview: ${capXml.slice(0, 150)}`);
    const entries = parseCapXml(capXml);
    if (entries.length > 0) {
      console.log(`[YouTube] SUCCESS via XML — ${entries.length} entries`);
      return res.json({ success: true, title, language: track.languageCode || "en", totalDuration: entries[entries.length - 1]?.timestamp || 0, entries });
    }

    throw new Error("Could not parse captions in any format (JSON3, srv3, XML). Try a different video.");

  } catch (err) {
    console.error(`[YouTube] FAILED:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Parse XML captions ── */
function parseCapXml(xml) {
  const raw = [];
  // Pattern 1: standard <text start="" dur="">
  let regex = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = decodeEntities(match[3]).trim();
    if (text) raw.push({ start: parseFloat(match[1]), duration: parseFloat(match[2] || "0"), text });
  }
  if (raw.length > 0) return groupIntoParagraphs(raw);

  // Pattern 2: <text t="" d=""> (milliseconds)
  regex = /<text\s+t="([^"]*)"(?:\s+d="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((match = regex.exec(xml)) !== null) {
    const text = decodeEntities(match[3]).trim();
    if (text) raw.push({ start: parseInt(match[1]) / 1000, duration: parseInt(match[2] || "0") / 1000, text });
  }
  return groupIntoParagraphs(raw);
}

/* ── Parse JSON3 format ── */
function parseJson3(json) {
  const raw = [];
  if (!json.events) return [];
  for (const event of json.events) {
    if (!event.segs) continue;
    const text = event.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (text) raw.push({ start: (event.tStartMs || 0) / 1000, duration: (event.dDurationMs || 0) / 1000, text });
  }
  return groupIntoParagraphs(raw);
}

/* ── Parse srv3 format ── */
function parseSrv3(xml) {
  const raw = [];
  const regex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = decodeEntities(match[3].replace(/<[^>]+>/g, "")).trim();
    if (text) raw.push({ start: parseInt(match[1]) / 1000, duration: parseInt(match[2]) / 1000, text });
  }
  return groupIntoParagraphs(raw);
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/\n/g, " ");
}

function groupIntoParagraphs(raw) {
  if (raw.length === 0) return [];
  const paragraphs = [];
  let cur = { start: raw[0].start, texts: [] };
  raw.forEach((e, i) => {
    cur.texts.push(e.text);
    const next = raw[i + 1], elapsed = e.start - cur.start, gap = next ? next.start - e.start - e.duration : 0;
    if (elapsed > 30 || gap > 2.5 || i === raw.length - 1) {
      paragraphs.push({ timestamp: cur.start, text: cur.texts.join(" ") });
      if (next) cur = { start: next.start, texts: [] };
    }
  });
  return paragraphs;
}

/* ══════════════════════════════════════════════════════════
   FILE TRANSCRIPTION ENDPOINT
   ══════════════════════════════════════════════════════════ */
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded." });
  console.log(`[Transcribe] Processing: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
  const mimeMap = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg", aac: "audio/aac", wma: "audio/x-ms-wma", opus: "audio/opus", mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska", webm: "video/webm" };
  const ext = req.file.originalname.split(".").pop().toLowerCase();
  const mime = mimeMap[ext] || req.file.mimetype || "audio/mpeg";
  try {
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`[Transcribe] Attempt ${attempt + 1}/3 (${mime})...`);
        const r = await fetch("https://api-inference.huggingface.co/models/openai/whisper-small", { method: "POST", headers: { "Content-Type": mime }, body: req.file.buffer });
        if (r.ok) { result = await r.json(); break; }
        const errBody = await r.json().catch(() => ({}));
        if (errBody.error?.includes("loading") || r.status === 503) { console.log("[Transcribe] Model loading..."); await new Promise(r => setTimeout(r, 15000)); continue; }
        if (r.status === 429) { console.log("[Transcribe] Rate limited..."); await new Promise(r => setTimeout(r, 10000)); continue; }
        throw new Error(errBody.error || `Whisper HTTP ${r.status}`);
      } catch (e) { if (attempt === 2) throw e; console.log(`[Transcribe] Retry: ${e.message}`); await new Promise(r => setTimeout(r, 5000)); }
    }
    if (!result) throw new Error("Transcription service unavailable.");
    console.log(`[Transcribe] Result: text=${result.text ? "yes" : "no"}, chunks=${result.chunks?.length || 0}`);

    let entries = [];
    if (result.chunks?.length > 0) entries = result.chunks.map(ch => ({ timestamp: ch.timestamp?.[0] ?? 0, text: (ch.text || "").trim() })).filter(e => e.text);
    else if (result.text) {
      const ss = result.text.match(/[^.!?]+[.!?]+/g) || [result.text];
      const tc = ss.reduce((s, t) => s + t.length, 0);
      let el = 0;
      entries = ss.map(s => { const en = { timestamp: el, text: s.trim() }; el += (s.length / tc) * (ss.length * 5); return en; }).filter(e => e.text);
    }
    const para = groupIntoParagraphs(entries.map(e => ({ start: e.timestamp, duration: 2, text: e.text })));
    console.log(`[Transcribe] SUCCESS — ${para.length} paragraphs`);
    res.json({ success: true, entries: para.length > 0 ? para : entries });
  } catch (err) { console.error(`[Transcribe] FAILED:`, err.message); res.status(500).json({ success: false, error: err.message }); }
});

/* ══════════════════════════════════════════════════════════
   CLAUDE AI ANALYSIS ENDPOINT
   ══════════════════════════════════════════════════════════ */
app.post("/api/analyze", async (req, res) => {
  const { system, prompt } = req.body;
  console.log("[AI] Running...");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) { const err = await r.text(); throw new Error(`Claude HTTP ${r.status}: ${err.slice(0, 200)}`); }
    const data = await r.json();
    res.json({ success: true, text: data.content?.map(b => b.text || "").join("") || "" });
  } catch (err) { console.error("[AI] FAILED:", err.message); res.status(500).json({ success: false, error: err.message }); }
});

/* ── Serve frontend ── */
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  TranscriptAI running on port ${PORT}\n  YouTube: Ready | Upload: Ready | AI: ${process.env.ANTHROPIC_API_KEY ? "Ready" : "Set ANTHROPIC_API_KEY"}\n`);
});
