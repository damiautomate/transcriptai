import express from "express";
import multer from "multer";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Import youtube-transcript ESM build
let fetchTranscriptPkg;
try {
  const ytModule = await import("./node_modules/youtube-transcript/dist/youtube-transcript.esm.js");
  fetchTranscriptPkg = ytModule.fetchTranscript;
  console.log("[INIT] youtube-transcript package loaded ✅");
} catch (e) {
  console.log("[INIT] youtube-transcript package not available:", e.message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: "50mb" }));
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CLIENT_VERSION = "2.20250320.01.00";

/* ══════════════════════════════════════════════════════════
   YOUTUBE TRANSCRIPT — 3 methods in sequence
   ══════════════════════════════════════════════════════════ */
app.get("/api/youtube/:videoId", async (req, res) => {
  const { videoId } = req.params;
  console.log(`\n[YT] ========== Fetching: ${videoId} ==========`);

  // Get title via oEmbed (always works, lightweight)
  let title = "YouTube Video";
  try {
    const oR = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (oR.ok) { const j = await oR.json(); title = j.title || title; }
    console.log(`[YT] Title: "${title}"`);
  } catch (_) {}

  const errors = [];

  // ══ METHOD 1: youtube-transcript npm package ══
  if (fetchTranscriptPkg) {
    try {
      console.log("[YT] Method 1: youtube-transcript package...");
      let raw;
      try { raw = await fetchTranscriptPkg(videoId, { lang: "en" }); }
      catch (_) { raw = await fetchTranscriptPkg(videoId); }

      if (raw && raw.length > 0) {
        const entries = groupIntoParagraphs(raw.map(r => ({
          start: (r.offset || 0) / 1000,
          duration: (r.duration || 0) / 1000,
          text: (r.text || "").trim(),
        })).filter(e => e.text));

        if (entries.length > 0) {
          console.log(`[YT] ✅ Method 1 SUCCESS — ${entries.length} paragraphs`);
          return res.json({ success: true, title, language: raw[0]?.lang || "en", totalDuration: entries[entries.length - 1]?.timestamp || 0, entries });
        }
      }
    } catch (e) {
      console.log(`[YT] Method 1 failed: ${e.message}`);
      errors.push(`Package: ${e.message}`);
    }
  }

  // ══ METHOD 2: /next + /get_transcript endpoint chain ══
  // This is how production tools extract transcripts.
  // Step A: Call /next to get engagement panel params
  // Step B: Use those params with /get_transcript
  try {
    console.log("[YT] Method 2: next + get_transcript endpoints...");

    // Step A: Call /next
    console.log("[YT]   Step A: Calling /youtubei/v1/next...");
    const nextR = await fetch("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: CLIENT_VERSION, hl: "en", gl: "US" } },
        videoId,
      }),
    });

    if (!nextR.ok) throw new Error(`/next returned HTTP ${nextR.status}`);
    const nextData = await nextR.json();
    console.log(`[YT]   /next response received (keys: ${Object.keys(nextData).join(", ")})`);

    // Find getTranscriptEndpoint params in the response
    let transcriptParams = null;
    const findParams = (obj, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 15 || transcriptParams) return;
      if (obj.getTranscriptEndpoint?.params) { transcriptParams = obj.getTranscriptEndpoint.params; return; }
      if (Array.isArray(obj)) { for (const item of obj) findParams(item, depth + 1); }
      else { for (const v of Object.values(obj)) findParams(v, depth + 1); }
    };
    findParams(nextData);

    if (!transcriptParams) {
      console.log("[YT]   No getTranscriptEndpoint found in /next response");
      throw new Error("Video does not expose transcript endpoint (no getTranscriptEndpoint in engagement panels)");
    }
    console.log(`[YT]   Found transcript params: ${transcriptParams.slice(0, 40)}...`);

    // Step B: Call /get_transcript with params
    console.log("[YT]   Step B: Calling /youtubei/v1/get_transcript...");
    const trR = await fetch("https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: CLIENT_VERSION, hl: "en", gl: "US" } },
        params: transcriptParams,
      }),
    });

    if (!trR.ok) throw new Error(`/get_transcript returned HTTP ${trR.status}`);
    const trData = await trR.json();

    // Extract transcript segments from response
    const segments = [];
    const findSegments = (obj, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 20) return;
      if (obj.transcriptSegmentRenderer) {
        const seg = obj.transcriptSegmentRenderer;
        let text = "";
        if (seg.snippet?.runs) text = seg.snippet.runs.map(r => r.text || "").join("");
        else if (seg.snippet?.simpleText) text = seg.snippet.simpleText;
        else if (typeof seg.snippet === "string") text = seg.snippet;
        text = text.replace(/\n/g, " ").trim();
        if (text) segments.push({
          start: parseInt(seg.startMs || "0") / 1000,
          duration: (parseInt(seg.endMs || "0") - parseInt(seg.startMs || "0")) / 1000,
          text,
        });
        return;
      }
      if (Array.isArray(obj)) { for (const item of obj) findSegments(item, depth + 1); }
      else { for (const v of Object.values(obj)) findSegments(v, depth + 1); }
    };
    findSegments(trData);

    if (segments.length === 0) {
      console.log("[YT]   get_transcript returned data but no segments found");
      throw new Error("Transcript response contained no segments");
    }

    const entries = groupIntoParagraphs(segments);
    console.log(`[YT] ✅ Method 2 SUCCESS — ${entries.length} paragraphs from ${segments.length} segments`);
    return res.json({ success: true, title, language: "en", totalDuration: segments[segments.length - 1]?.start || 0, entries });

  } catch (e) {
    console.log(`[YT] Method 2 failed: ${e.message}`);
    errors.push(`Innertube: ${e.message}`);
  }

  // ══ METHOD 3: Direct page scraping + caption URL fetch ══
  try {
    console.log("[YT] Method 3: Direct page scraping...");
    const pageR = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cookie": "CONSENT=PENDING+999;" },
    });
    if (!pageR.ok) throw new Error(`YouTube page HTTP ${pageR.status}`);
    const html = await pageR.text();
    console.log(`[YT]   Page: ${html.length} chars`);

    // Try to extract ytInitialPlayerResponse
    const match = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
    if (!match) {
      // Try alternate pattern
      const match2 = html.match(/"captionTracks"\s*:\s*(\[.*?\])/);
      if (!match2) throw new Error("No player response or caption tracks found in page");

      const tracks = JSON.parse(match2[1]);
      console.log(`[YT]   Found ${tracks.length} caption tracks from page HTML`);
      const track = tracks.find(t => t.languageCode === "en") || tracks[0];
      if (!track?.baseUrl) throw new Error("No caption base URL");

      // Try fetching with cookies from the page response
      const cookies = (pageR.headers.get("set-cookie") || "").split(",").map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
      const capR = await fetch(track.baseUrl, { headers: { "User-Agent": UA, "Cookie": cookies } });
      if (!capR.ok) throw new Error(`Caption fetch HTTP ${capR.status}`);
      const capText = await capR.text();
      if (capText.length < 50) throw new Error("Caption response empty");

      const entries = parseXmlTranscript(capText);
      if (entries.length > 0) {
        console.log(`[YT] ✅ Method 3 SUCCESS (captionTracks) — ${entries.length} paragraphs`);
        return res.json({ success: true, title, language: track.languageCode || "en", totalDuration: entries[entries.length - 1]?.timestamp || 0, entries });
      }
      throw new Error("Could not parse caption XML");
    }

    // Parse ytInitialPlayerResponse
    let playerResponse;
    try { playerResponse = JSON.parse(match[1]); } catch (_) { throw new Error("Failed to parse player response JSON"); }

    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) throw new Error("No caption tracks in player response");
    console.log(`[YT]   Found ${tracks.length} tracks in player response`);

    const track = tracks.find(t => t.languageCode === "en") || tracks[0];
    const cookies = (pageR.headers.get("set-cookie") || "").split(",").map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
    const capR = await fetch(track.baseUrl, { headers: { "User-Agent": UA, "Cookie": cookies } });
    if (!capR.ok) throw new Error(`Caption fetch HTTP ${capR.status}`);
    const capText = await capR.text();
    if (capText.length < 50) throw new Error(`Caption response too short (${capText.length} chars)`);

    const entries = parseXmlTranscript(capText);
    if (entries.length > 0) {
      console.log(`[YT] ✅ Method 3 SUCCESS (playerResponse) — ${entries.length} paragraphs`);
      return res.json({ success: true, title, language: track.languageCode || "en", totalDuration: entries[entries.length - 1]?.timestamp || 0, entries });
    }
    throw new Error("Parsed 0 entries from caption XML");

  } catch (e) {
    console.log(`[YT] Method 3 failed: ${e.message}`);
    errors.push(`Page scrape: ${e.message}`);
  }

  // All methods failed
  console.error(`[YT] ❌ ALL METHODS FAILED`);
  errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));

  let userMessage = "Could not extract transcript. ";
  if (errors.some(e => e.includes("disabled"))) userMessage += "Transcripts may be disabled for this video.";
  else if (errors.some(e => e.includes("too many"))) userMessage += "YouTube is rate-limiting. Try again in a few minutes.";
  else userMessage += "YouTube may be blocking our server. Please try a different video or try again later.";

  res.status(500).json({ success: false, error: userMessage });
});

/* ── Parse XML transcript formats ── */
function parseXmlTranscript(xml) {
  const raw = [];

  // Format 1: <p t="ms" d="ms">...</p> (srv3 style)
  let regex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    let text = match[3].replace(/<[^>]+>/g, "");
    text = decodeEntities(text).trim();
    if (text) raw.push({ start: parseInt(match[1]) / 1000, duration: parseInt(match[2]) / 1000, text });
  }
  if (raw.length > 0) return groupIntoParagraphs(raw);

  // Format 2: <text start="s" dur="s">...</text>
  regex = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((match = regex.exec(xml)) !== null) {
    const text = decodeEntities(match[3]).trim();
    if (text) raw.push({ start: parseFloat(match[1]), duration: parseFloat(match[2] || "0"), text });
  }
  return groupIntoParagraphs(raw);
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/\n/g, " ");
}

function groupIntoParagraphs(raw) {
  if (raw.length === 0) return [];
  const paragraphs = [];
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
   FILE TRANSCRIPTION (Whisper via HuggingFace)
   ══════════════════════════════════════════════════════════ */
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded." });
  console.log(`[TR] Processing: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

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
        console.log(`[TR] Attempt ${attempt + 1}/3 (${mime})...`);
        const hfToken = process.env.HF_TOKEN || "";
        const hfHeaders = { "Content-Type": mime };
        if (hfToken) hfHeaders["Authorization"] = `Bearer ${hfToken}`;
        
        const r = await fetch("https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3-turbo", {
          method: "POST", headers: hfHeaders, body: req.file.buffer,
        });
        if (r.ok) { result = await r.json(); break; }
        const e = await r.json().catch(() => ({}));
        if (e.error?.includes("loading") || r.status === 503) { console.log("[TR] Loading..."); await new Promise(r => setTimeout(r, 15000)); continue; }
        if (r.status === 429) { console.log("[TR] Rate limited..."); await new Promise(r => setTimeout(r, 10000)); continue; }
        throw new Error(e.error || (r.status === 410 || r.status === 403 ? "HuggingFace requires a free API token. Set HF_TOKEN in Railway variables (get one free at huggingface.co/settings/tokens)." : `HTTP ${r.status}`));
      } catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 5000)); }
    }
    if (!result) throw new Error("Transcription unavailable after retries.");
    console.log(`[TR] text=${!!result.text}, chunks=${result.chunks?.length || 0}`);

    let entries = [];
    if (result.chunks?.length > 0) {
      entries = result.chunks.map(ch => ({ timestamp: ch.timestamp?.[0] ?? 0, text: (ch.text || "").trim() })).filter(e => e.text);
    } else if (result.text) {
      const ss = result.text.match(/[^.!?]+[.!?]+/g) || [result.text];
      const total = ss.reduce((s, t) => s + t.length, 0);
      let el = 0;
      entries = ss.map(s => { const en = { timestamp: el, text: s.trim() }; el += (s.length / total) * ss.length * 5; return en; }).filter(e => e.text);
    }
    const para = groupIntoParagraphs(entries.map(e => ({ start: e.timestamp, duration: 2, text: e.text })));
    console.log(`[TR] ✅ ${para.length} paragraphs`);
    res.json({ success: true, entries: para.length > 0 ? para : entries });
  } catch (err) {
    console.error(`[TR] ❌ ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════
   AI ANALYSIS (Claude API)
   ══════════════════════════════════════════════════════════ */
app.post("/api/analyze", async (req, res) => {
  const { system, prompt } = req.body;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Claude HTTP ${r.status}`);
    const data = await r.json();
    res.json({ success: true, text: data.content?.map(b => b.text || "").join("") || "" });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ══════════════════════════════════════════════════════════
   TRANSCRIPT HISTORY & CACHING
   ══════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, existsSync } from "fs";

const HISTORY_FILE = join(__dirname, "history.json");
let history = [];

// Load history from disk on startup
try {
  if (existsSync(HISTORY_FILE)) {
    history = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
    console.log(`[HIST] Loaded ${history.length} saved transcripts`);
  }
} catch (_) { history = []; }

function saveHistory() {
  try { writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); } catch (_) {}
}

// Save a transcript
app.post("/api/history", (req, res) => {
  const { title, source, videoId, language, totalDuration, entries, fileType, fileSize } = req.body;
  if (!entries || entries.length === 0) return res.status(400).json({ success: false, error: "No entries to save" });

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: title || "Untitled",
    source: source || "unknown",
    videoId: videoId || null,
    language: language || "en",
    totalDuration: totalDuration || 0,
    fileType: fileType || null,
    fileSize: fileSize || null,
    entryCount: entries.length,
    wordCount: entries.reduce((c, e) => c + (e.text || "").split(/\s+/).filter(Boolean).length, 0),
    entries,
    savedAt: new Date().toISOString(),
  };

  history.unshift(item); // newest first
  if (history.length > 50) history = history.slice(0, 50); // cap at 50
  saveHistory();
  console.log(`[HIST] Saved: "${item.title}" (${item.id})`);
  res.json({ success: true, id: item.id });
});

// Get history list (without full entries for speed)
app.get("/api/history", (req, res) => {
  const list = history.map(({ id, title, source, videoId, language, totalDuration, entryCount, wordCount, savedAt, fileType }) => ({
    id, title, source, videoId, language, totalDuration, entryCount, wordCount, savedAt, fileType,
  }));
  res.json({ success: true, history: list });
});

// Get a single saved transcript (with full entries)
app.get("/api/history/:id", (req, res) => {
  const item = history.find(h => h.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, error: "Transcript not found" });
  res.json({ success: true, transcript: item });
});

// Delete a saved transcript
app.delete("/api/history/:id", (req, res) => {
  const idx = history.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: "Not found" });
  history.splice(idx, 1);
  saveHistory();
  res.json({ success: true });
});

/* ── Serve frontend ── */
app.get("*", (req, res) => res.sendFile(join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         TranscriptAI v1.0                ║
  ║   Port: ${PORT}                              ║
  ║   YouTube:  ✅ (3-method fallback)        ║
  ║   Upload:   ${process.env.HF_TOKEN ? "✅ Ready" : "⚠️  Set HF_TOKEN for uploads"}               ║
  ║   AI:       ${process.env.ANTHROPIC_API_KEY ? "✅ Ready" : "⚠️  Set ANTHROPIC_API_KEY"}                     ║
  ║   History:  ✅ (${history.length} saved)                ║
  ╚══════════════════════════════════════════╝
  `);
});
