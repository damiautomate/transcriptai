const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");
const { parseStringPromise } = require("xml2js");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: "50mb" }));
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

/* ══════════════════════════════════════════════════════════
   YOUTUBE TRANSCRIPT
   Uses Android Innertube Player API to get caption URLs
   that work from any server IP (not IP-locked).
   ══════════════════════════════════════════════════════════ */
app.get("/api/youtube/:videoId", async (req, res) => {
  const { videoId } = req.params;
  console.log(`[YT] === Fetching transcript for: ${videoId} ===`);

  try {
    // ── Step 1: Get video title via oEmbed (lightweight) ──
    let title = "YouTube Video";
    try {
      const oR = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      if (oR.ok) { const j = await oR.json(); title = j.title || title; }
      console.log(`[YT] Title: "${title}"`);
    } catch (_) { console.log("[YT] oEmbed failed, will get title from page"); }

    // ── Step 2: Get INNERTUBE_API_KEY from YouTube page ──
    console.log("[YT] Fetching YouTube page for API key...");
    const pageR = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": "CONSENT=PENDING+999;"
      }
    });
    const html = await pageR.text();
    console.log(`[YT] Page: ${html.length} chars`);

    // Get title from page if oEmbed failed
    if (title === "YouTube Video") {
      const tMatch = html.match(/<title>(.*?)<\/title>/);
      if (tMatch) title = tMatch[1].replace(/ - YouTube$/, "").trim();
    }

    // Check if video is playable
    if (html.includes('"playabilityStatus"')) {
      if (html.includes('"LOGIN_REQUIRED"') && html.includes('"reason"')) {
        throw new Error("This video requires sign-in (may be age-restricted). Try a different video.");
      }
      if (html.includes('"UNPLAYABLE"')) {
        throw new Error("This video is unavailable or private.");
      }
    }

    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    const apiKey = apiKeyMatch ? apiKeyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
    console.log(`[YT] API key found: ${apiKey.slice(0, 15)}...`);

    // ── Step 3: Call Innertube Player API as ANDROID client ──
    // The Android client returns caption URLs that are NOT IP-locked
    console.log("[YT] Calling Innertube Player API (Android client)...");
    const playerR = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip",
        "X-YouTube-Client-Name": "3",
        "X-YouTube-Client-Version": "19.09.37",
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "19.09.37",
            androidSdkVersion: 34,
            hl: "en",
            gl: "US",
          }
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });

    if (!playerR.ok) {
      const errText = await playerR.text().catch(() => "");
      console.log(`[YT] Player API HTTP ${playerR.status}: ${errText.slice(0, 200)}`);
      throw new Error(`YouTube Player API returned HTTP ${playerR.status}. Try again.`);
    }

    const playerData = await playerR.json();
    console.log(`[YT] Player response status: ${playerData?.playabilityStatus?.status || "unknown"}`);

    // ── Step 4: Extract caption tracks ──
    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) {
      // Check if captions exist but might be in page data instead
      console.log("[YT] No caption tracks from Android API. Checking page data...");

      const capMatch = html.match(/"captionTracks"\s*:\s*(\[.*?\])/);
      if (capMatch) {
        // Try fetching captions from page-extracted URLs with different approach
        console.log("[YT] Found captionTracks in page HTML, trying WEB client...");
        const webResult = await tryWebClient(videoId, apiKey);
        if (webResult) {
          console.log(`[YT] ✅ Success via WEB client — ${webResult.length} entries`);
          return res.json({ success: true, title, language: "en", totalDuration: webResult[webResult.length - 1]?.timestamp || 0, entries: webResult });
        }
      }

      throw new Error("No captions available for this video. It may not have subtitles enabled.");
    }

    console.log(`[YT] Found ${tracks.length} tracks: ${tracks.map(t => `${t.languageCode}(${t.kind || "manual"})`).join(", ")}`);

    // Pick best track
    const track = tracks.find(t => t.languageCode === "en" && t.kind !== "asr")
      || tracks.find(t => t.languageCode === "en")
      || tracks.find(t => t.languageCode?.startsWith("en"))
      || tracks[0];

    const captionUrl = track.baseUrl;
    console.log(`[YT] Using track: ${track.languageCode} (${track.kind || "manual"})`);
    console.log(`[YT] Caption URL: ${captionUrl.slice(0, 120)}...`);

    // ── Step 5: Fetch caption XML ──
    console.log("[YT] Fetching caption XML...");
    const capR = await fetch(captionUrl, {
      headers: { "User-Agent": "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip" }
    });

    if (!capR.ok) {
      console.log(`[YT] Caption fetch HTTP ${capR.status}`);
      throw new Error(`Could not download captions (HTTP ${capR.status}).`);
    }

    const capXml = await capR.text();
    console.log(`[YT] Caption XML: ${capXml.length} chars`);

    if (capXml.length < 50) {
      console.log(`[YT] XML too short: "${capXml}"`);
      throw new Error("Received empty caption data.");
    }

    // ── Step 6: Parse XML with xml2js ──
    console.log("[YT] Parsing XML...");
    const parsed = await parseStringPromise(capXml, { explicitArray: false });

    let rawEntries = [];
    if (parsed?.transcript?.text) {
      const texts = Array.isArray(parsed.transcript.text) ? parsed.transcript.text : [parsed.transcript.text];
      rawEntries = texts.map(entry => ({
        start: parseFloat(entry?.$?.start || "0"),
        duration: parseFloat(entry?.$?.dur || "0"),
        text: (typeof entry === "string" ? entry : entry._ || "").replace(/\n/g, " ").trim(),
      })).filter(e => e.text);
    }

    console.log(`[YT] Parsed ${rawEntries.length} raw entries`);
    if (rawEntries.length === 0) throw new Error("Could not parse any text from captions.");

    const entries = groupIntoParagraphs(rawEntries);
    console.log(`[YT] ✅ SUCCESS — ${entries.length} paragraphs, ${rawEntries.length} raw entries`);

    return res.json({
      success: true,
      title,
      language: track.languageCode || "en",
      totalDuration: rawEntries[rawEntries.length - 1]?.start || 0,
      entries,
    });

  } catch (err) {
    console.error(`[YT] ❌ FAILED: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Fallback: WEB client innertube for get_transcript ── */
async function tryWebClient(videoId, apiKey) {
  try {
    // Use get_transcript endpoint with WEB client
    const videoIdBytes = Buffer.from(videoId, "utf8");
    const inner = Buffer.concat([Buffer.from([0x0a, videoIdBytes.length]), videoIdBytes]);
    const outer = Buffer.concat([Buffer.from([0x0a, inner.length]), inner]);
    const params = outer.toString("base64");

    const r = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20250320.01.00", hl: "en", gl: "US" } },
        params,
      }),
    });

    if (!r.ok) { console.log(`[YT] WEB get_transcript HTTP ${r.status}`); return null; }
    const data = await r.json();

    // Deep search for transcript segments
    const segments = [];
    const search = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (obj.transcriptSegmentRenderer) {
        const seg = obj.transcriptSegmentRenderer;
        const text = extractText(seg.snippet);
        const startMs = parseInt(seg.startMs || "0");
        const endMs = parseInt(seg.endMs || "0");
        if (text) segments.push({ start: startMs / 1000, duration: (endMs - startMs) / 1000, text });
        return;
      }
      if (Array.isArray(obj)) obj.forEach(search);
      else Object.values(obj).forEach(search);
    };
    search(data);

    if (segments.length === 0) { console.log("[YT] WEB client: no segments found in response"); return null; }
    console.log(`[YT] WEB client found ${segments.length} segments`);
    return groupIntoParagraphs(segments);
  } catch (e) {
    console.log(`[YT] WEB client error: ${e.message}`);
    return null;
  }
}

function extractText(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  if (obj.simpleText) return obj.simpleText;
  if (obj.runs) return obj.runs.map(r => r.text || "").join("");
  return "";
}

/* ── Group into ~30s paragraphs ── */
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
    for (let a = 0; a < 3; a++) {
      try {
        console.log(`[TR] Attempt ${a + 1}/3 (${mime})...`);
        const r = await fetch("https://api-inference.huggingface.co/models/openai/whisper-small", {
          method: "POST",
          headers: { "Content-Type": mime },
          body: req.file.buffer,
        });
        if (r.ok) { result = await r.json(); break; }
        const e = await r.json().catch(() => ({}));
        if (e.error?.includes("loading") || r.status === 503) {
          console.log("[TR] Model loading, waiting 15s...");
          await new Promise(r => setTimeout(r, 15000)); continue;
        }
        if (r.status === 429) {
          console.log("[TR] Rate limited, waiting 10s...");
          await new Promise(r => setTimeout(r, 10000)); continue;
        }
        throw new Error(e.error || `Whisper HTTP ${r.status}`);
      } catch (e) {
        if (a === 2) throw e;
        console.log(`[TR] Retrying: ${e.message}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    if (!result) throw new Error("Transcription service unavailable.");
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
   AI ANALYSIS (Claude)
   ══════════════════════════════════════════════════════════ */
app.post("/api/analyze", async (req, res) => {
  const { system, prompt } = req.body;
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
    if (!r.ok) throw new Error(`Claude HTTP ${r.status}`);
    const data = await r.json();
    res.json({ success: true, text: data.content?.map(b => b.text || "").join("") || "" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Serve frontend ── */
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         TranscriptAI v1.0                ║
  ║   Port: ${PORT}                              ║
  ║   YouTube:  ✅ (Android Innertube API)    ║
  ║   Upload:   ✅ (Whisper AI)               ║
  ║   AI:       ${process.env.ANTHROPIC_API_KEY ? "✅" : "⚠️  Set ANTHROPIC_API_KEY"}                     ║
  ╚══════════════════════════════════════════╝
  `);
});
