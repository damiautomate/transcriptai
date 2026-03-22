import express from "express";
import multer from "multer";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Import youtube-transcript ESM build directly (package exports are broken for Node ESM resolver)
const ytModule = await import("./node_modules/youtube-transcript/dist/youtube-transcript.esm.js");
const { fetchTranscript } = ytModule;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: "50mb" }));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

/* ══════════════════════════════════════════════════════════
   YOUTUBE TRANSCRIPT
   Uses youtube-transcript package (58k weekly downloads)
   which handles Android Innertube API + web scraping fallback
   ══════════════════════════════════════════════════════════ */
app.get("/api/youtube/:videoId", async (req, res) => {
  const { videoId } = req.params;
  console.log(`[YT] === Fetching: ${videoId} ===`);

  try {
    // Get video title via oEmbed (lightweight, no auth needed)
    let title = "YouTube Video";
    try {
      const oR = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      if (oR.ok) { const j = await oR.json(); title = j.title || title; }
      console.log(`[YT] Title: "${title}"`);
    } catch (_) { console.log("[YT] oEmbed failed, continuing"); }

    // Fetch transcript — the package handles all the complexity:
    // 1. Tries Android Innertube API first
    // 2. Falls back to web page scraping
    // 3. Handles caption URL extraction and XML parsing
    console.log("[YT] Fetching transcript...");
    
    let raw;
    try {
      // Try with English preference first
      raw = await fetchTranscript(videoId, { lang: "en" });
    } catch (langErr) {
      console.log(`[YT] English failed: ${langErr.message}, trying any language...`);
      raw = await fetchTranscript(videoId);
    }

    if (!raw || raw.length === 0) {
      throw new Error("No transcript segments returned. The video may not have captions.");
    }

    console.log(`[YT] Got ${raw.length} raw segments`);
    console.log(`[YT] Sample: ${JSON.stringify(raw[0])}`);

    // Map to our format (package returns offset in ms, duration in ms)
    const mapped = raw.map(r => ({
      start: typeof r.offset === "number" ? r.offset / 1000 : parseFloat(r.offset || 0) / 1000,
      duration: typeof r.duration === "number" ? r.duration / 1000 : parseFloat(r.duration || 0) / 1000,
      text: (r.text || "").trim(),
    })).filter(e => e.text);

    // Group into ~30 second paragraphs for readability
    const entries = groupIntoParagraphs(mapped);

    console.log(`[YT] ✅ SUCCESS — ${entries.length} paragraphs from ${mapped.length} segments`);
    return res.json({
      success: true,
      title,
      language: raw[0]?.lang || "en",
      totalDuration: mapped[mapped.length - 1]?.start || 0,
      entries,
    });

  } catch (err) {
    console.error(`[YT] ❌ FAILED: ${err.message}`);
    
    // Provide user-friendly error messages
    let userMsg = err.message;
    if (err.message.includes("disabled")) userMsg = "Transcripts are disabled on this video by the creator.";
    else if (err.message.includes("No transcripts are available")) userMsg = "No captions/subtitles available for this video.";
    else if (err.message.includes("no longer available")) userMsg = "This video is unavailable or private.";
    else if (err.message.includes("too many requests") || err.message.includes("captcha")) userMsg = "YouTube is rate-limiting requests. Please try again in a few minutes.";
    
    res.status(500).json({ success: false, error: userMsg });
  }
});

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
        const r = await fetch("https://api-inference.huggingface.co/models/openai/whisper-small", {
          method: "POST",
          headers: { "Content-Type": mime },
          body: req.file.buffer,
        });
        if (r.ok) { result = await r.json(); break; }

        const errBody = await r.json().catch(() => ({}));
        if (errBody.error?.includes("loading") || r.status === 503) {
          console.log("[TR] Model loading, waiting 15s...");
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }
        if (r.status === 429) {
          console.log("[TR] Rate limited, waiting 10s...");
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
        throw new Error(errBody.error || `Whisper API HTTP ${r.status}`);
      } catch (e) {
        if (attempt === 2) throw e;
        console.log(`[TR] Retry: ${e.message}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    if (!result) throw new Error("Transcription service unavailable after 3 attempts. Try again later.");
    console.log(`[TR] Result: text=${!!result.text}, chunks=${result.chunks?.length || 0}`);

    let entries = [];
    if (result.chunks?.length > 0) {
      entries = result.chunks.map(ch => ({
        timestamp: ch.timestamp?.[0] ?? 0,
        text: (ch.text || "").trim(),
      })).filter(e => e.text);
    } else if (result.text) {
      const sentences = result.text.match(/[^.!?]+[.!?]+/g) || [result.text];
      const total = sentences.reduce((s, t) => s + t.length, 0);
      let elapsed = 0;
      entries = sentences.map(s => {
        const entry = { timestamp: elapsed, text: s.trim() };
        elapsed += (s.length / total) * sentences.length * 5;
        return entry;
      }).filter(e => e.text);
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
    });
    if (!r.ok) throw new Error(`Claude API HTTP ${r.status}`);
    const data = await r.json();
    const text = data.content?.map(b => b.text || "").join("") || "";
    console.log("[AI] ✅ Done");
    res.json({ success: true, text });
  } catch (err) {
    console.error("[AI] ❌", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Serve frontend ── */
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

/* ── Start ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         TranscriptAI v1.0                ║
  ║   Port: ${PORT}                              ║
  ║   YouTube:  ✅ Ready                      ║
  ║   Upload:   ✅ Ready                      ║
  ║   AI:       ${process.env.ANTHROPIC_API_KEY ? "✅ Ready" : "⚠️  Set ANTHROPIC_API_KEY"}                     ║
  ╚══════════════════════════════════════════╝
  `);
});
