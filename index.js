const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: "50mb" }));
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

/* ══════════════════════════════════════════════════════════
   YOUTUBE TRANSCRIPT ENDPOINT
   ══════════════════════════════════════════════════════════ */
app.get("/api/youtube/:videoId", async (req, res) => {
  const { videoId } = req.params;
  console.log(`[YT] Fetching: ${videoId}`);

  try {
    // ── Fetch YouTube page WITH cookies ──
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    // First request to get consent cookie
    console.log("[YT] Fetching YouTube page...");
    const ytR = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers, redirect: "manual" });
    
    // Capture cookies from response
    const rawCookies = ytR.headers.raw()["set-cookie"] || [];
    const cookieStr = rawCookies.map(c => c.split(";")[0]).join("; ");
    console.log(`[YT] Got ${rawCookies.length} cookies`);

    // Follow redirect if needed, with cookies
    let html;
    if (ytR.status >= 300 && ytR.status < 400) {
      const loc = ytR.headers.get("location");
      console.log(`[YT] Following redirect to: ${loc?.slice(0, 80)}`);
      const ytR2 = await fetch(loc || `https://www.youtube.com/watch?v=${videoId}`, { headers: { ...headers, Cookie: cookieStr } });
      html = await ytR2.text();
    } else {
      html = await ytR.text();
    }

    // Handle consent page
    if (html.includes("CONSENT") && html.includes("consent.youtube.com")) {
      console.log("[YT] Consent page detected, bypassing...");
      const consentHeaders = { ...headers, Cookie: "CONSENT=YES+; " + cookieStr };
      const ytR3 = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: consentHeaders });
      html = await ytR3.text();
    }

    console.log(`[YT] Page: ${html.length} chars`);

    // Extract title
    const tMatch = html.match(/<title>(.*?)<\/title>/);
    const title = tMatch ? tMatch[1].replace(/ - YouTube$/, "").trim() : "YouTube Video";

    // ── METHOD 1: Innertube API for transcript ──
    console.log("[YT] Trying Innertube API...");
    try {
      const innerResult = await fetchViaInnertube(videoId, html);
      if (innerResult && innerResult.length > 0) {
        console.log(`[YT] SUCCESS via Innertube — ${innerResult.length} entries`);
        return res.json({ success: true, title, language: "en", totalDuration: innerResult[innerResult.length - 1]?.timestamp || 0, entries: innerResult });
      }
    } catch (e) { console.log(`[YT] Innertube failed: ${e.message}`); }

    // ── METHOD 2: Caption URL with cookies ──
    const capMatch = html.match(/"captionTracks"\s*:\s*(\[.*?\])/);
    if (!capMatch) {
      // Only flag age-restricted if playability specifically says so
      if (html.includes('"playabilityStatus"') && html.includes('"LOGIN_REQUIRED"')) throw new Error("Age-restricted video. Try a different one.");
      if (html.includes('"playabilityStatus"') && html.includes('"UNPLAYABLE"')) throw new Error("Video is unavailable or private.");
      console.log(`[YT] No captionTracks found. Has 'captions': ${html.includes('"captions"')}, has 'captionTracks': ${html.includes('captionTracks')}`);
      throw new Error("No captions found for this video. It may not have subtitles enabled.");
    }

    let tracks;
    try { tracks = JSON.parse(capMatch[1]); } catch (_) { throw new Error("Failed to parse captions."); }
    console.log(`[YT] ${tracks.length} tracks: ${tracks.map(t => `${t.languageCode}(${t.kind || "std"})`).join(", ")}`);

    const track = tracks.find(t => t.languageCode === "en") || tracks.find(t => t.languageCode?.startsWith("en")) || tracks[0];
    if (!track?.baseUrl) throw new Error("No caption URL.");

    // Fetch with cookies and all formats
    const fetchHeaders = { ...headers, Cookie: "CONSENT=YES+; " + cookieStr };
    const formats = [
      { name: "json3", url: track.baseUrl + "&fmt=json3", parser: parseJson3Response },
      { name: "srv3", url: track.baseUrl + "&fmt=srv3", parser: parseSrv3 },
      { name: "xml", url: track.baseUrl, parser: parseCapXml },
    ];

    for (const fmt of formats) {
      try {
        console.log(`[YT] Trying ${fmt.name}...`);
        const r = await fetch(fmt.url, { headers: fetchHeaders });
        if (!r.ok) { console.log(`[YT] ${fmt.name} HTTP ${r.status}`); continue; }
        const text = await r.text();
        console.log(`[YT] ${fmt.name}: ${text.length} chars`);
        if (text.length < 10) { console.log(`[YT] ${fmt.name} empty`); continue; }
        
        let entries;
        if (fmt.name === "json3") {
          const json = JSON.parse(text);
          entries = fmt.parser(json);
        } else {
          entries = fmt.parser(text);
        }
        
        if (entries.length > 0) {
          console.log(`[YT] SUCCESS via ${fmt.name} — ${entries.length} entries`);
          return res.json({ success: true, title, language: track.languageCode || "en", totalDuration: entries[entries.length - 1]?.timestamp || 0, entries });
        }
        console.log(`[YT] ${fmt.name} parsed 0 entries`);
      } catch (e) { console.log(`[YT] ${fmt.name} error: ${e.message}`); }
    }

    throw new Error("Found captions but could not download them. YouTube may be blocking this server's IP. Try again later.");

  } catch (err) {
    console.error(`[YT] FAILED: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Innertube transcript fetch ── */
async function fetchViaInnertube(videoId, html) {
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const apiKey = apiKeyMatch ? apiKeyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  
  // Proper protobuf encoding for get_transcript params
  // Field 1 (LEN) > Field 1 (LEN) > videoId
  const videoIdBytes = Buffer.from(videoId, "utf8");
  const inner = Buffer.concat([Buffer.from([0x0a, videoIdBytes.length]), videoIdBytes]);
  const outer = Buffer.concat([Buffer.from([0x0a, inner.length]), inner]);
  const params = outer.toString("base64");
  console.log(`[YT] Innertube params: ${params}`);

  const body = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20250320.01.00",
        hl: "en",
        gl: "US",
      }
    },
    params,
  };

  const r = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`Innertube HTTP ${r.status}: ${errText.slice(0, 150)}`);
  }
  const data = await r.json();
  console.log(`[YT] Innertube response keys: ${Object.keys(data).join(", ")}`);
  if (data.actions) console.log(`[YT] Innertube actions: ${data.actions.length}`);
  else console.log(`[YT] Innertube: no actions, top keys: ${JSON.stringify(data).slice(0, 200)}`);

  // Parse innertube transcript response
  const actions = data?.actions;
  if (!actions) throw new Error("No actions in response");

  const transcriptRenderer = actions[0]?.updateEngagementPanelAction?.content?.transcriptRenderer;
  const body2 = transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body || transcriptRenderer?.body;
  const sectionRenderer = body2?.transcriptSectionListRenderer || body2?.transcriptSegmentListRenderer;
  
  if (!sectionRenderer) {
    // Try alternate path
    const segments = findTranscriptSegments(data);
    if (segments.length > 0) return groupIntoParagraphs(segments);
    throw new Error("No transcript segments found");
  }

  const sections = sectionRenderer.contents || [];
  const raw = [];
  
  for (const section of sections) {
    const renderer = section.transcriptSectionRenderer || section.transcriptSegmentRenderer;
    if (!renderer) continue;
    
    // Direct segments
    if (renderer.startMs != null) {
      const text = extractText(renderer.snippet || renderer);
      if (text) raw.push({ start: parseInt(renderer.startMs) / 1000, duration: parseInt(renderer.endMs || "0") / 1000 - parseInt(renderer.startMs) / 1000, text });
      continue;
    }
    
    // Nested segments
    const contents = renderer.contents || [];
    for (const item of contents) {
      const seg = item.transcriptSegmentRenderer;
      if (!seg) continue;
      const text = extractText(seg.snippet || seg);
      const startMs = parseInt(seg.startMs || "0");
      const endMs = parseInt(seg.endMs || "0");
      if (text) raw.push({ start: startMs / 1000, duration: (endMs - startMs) / 1000, text });
    }
  }

  return groupIntoParagraphs(raw);
}

function findTranscriptSegments(obj) {
  const segments = [];
  const search = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.transcriptSegmentRenderer) {
      const seg = o.transcriptSegmentRenderer;
      const text = extractText(seg.snippet || seg);
      if (text) segments.push({ start: parseInt(seg.startMs || "0") / 1000, duration: (parseInt(seg.endMs || "0") - parseInt(seg.startMs || "0")) / 1000, text });
      return;
    }
    if (Array.isArray(o)) o.forEach(search);
    else Object.values(o).forEach(search);
  };
  search(obj);
  return segments;
}

function extractText(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  if (obj.simpleText) return obj.simpleText;
  if (obj.runs) return obj.runs.map(r => r.text || "").join("");
  if (obj.text) return extractText(obj.text);
  if (obj.snippet) return extractText(obj.snippet);
  return "";
}

/* ── Parsers ── */
function parseCapXml(xml) {
  const raw = [];
  let regex = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = decodeEntities(match[3]).trim();
    if (text) raw.push({ start: parseFloat(match[1]), duration: parseFloat(match[2] || "0"), text });
  }
  if (raw.length > 0) return groupIntoParagraphs(raw);
  regex = /<text\s+t="([^"]*)"(?:\s+d="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((match = regex.exec(xml)) !== null) {
    const text = decodeEntities(match[3]).trim();
    if (text) raw.push({ start: parseInt(match[1]) / 1000, duration: parseInt(match[2] || "0") / 1000, text });
  }
  return groupIntoParagraphs(raw);
}

function parseJson3Response(json) {
  const raw = [];
  if (!json.events) return [];
  for (const event of json.events) {
    if (!event.segs) continue;
    const text = event.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (text) raw.push({ start: (event.tStartMs || 0) / 1000, duration: (event.dDurationMs || 0) / 1000, text });
  }
  return groupIntoParagraphs(raw);
}

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

function decodeEntities(s) { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/\n/g, " "); }

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
   FILE TRANSCRIPTION
   ══════════════════════════════════════════════════════════ */
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded." });
  console.log(`[TR] Processing: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
  const mimeMap = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg", aac: "audio/aac", wma: "audio/x-ms-wma", opus: "audio/opus", mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska", webm: "video/webm" };
  const ext = req.file.originalname.split(".").pop().toLowerCase();
  const mime = mimeMap[ext] || req.file.mimetype || "audio/mpeg";
  try {
    let result = null;
    for (let a = 0; a < 3; a++) {
      try {
        console.log(`[TR] Attempt ${a + 1}/3 (${mime})...`);
        const r = await fetch("https://api-inference.huggingface.co/models/openai/whisper-small", { method: "POST", headers: { "Content-Type": mime }, body: req.file.buffer });
        if (r.ok) { result = await r.json(); break; }
        const e = await r.json().catch(() => ({}));
        if (e.error?.includes("loading") || r.status === 503) { console.log("[TR] Model loading..."); await new Promise(r => setTimeout(r, 15000)); continue; }
        if (r.status === 429) { console.log("[TR] Rate limited..."); await new Promise(r => setTimeout(r, 10000)); continue; }
        throw new Error(e.error || `HTTP ${r.status}`);
      } catch (e) { if (a === 2) throw e; await new Promise(r => setTimeout(r, 5000)); }
    }
    if (!result) throw new Error("Transcription unavailable.");
    console.log(`[TR] Result: text=${!!result.text}, chunks=${result.chunks?.length || 0}`);
    let entries = [];
    if (result.chunks?.length > 0) entries = result.chunks.map(ch => ({ timestamp: ch.timestamp?.[0] ?? 0, text: (ch.text || "").trim() })).filter(e => e.text);
    else if (result.text) { const ss = result.text.match(/[^.!?]+[.!?]+/g) || [result.text]; const tc = ss.reduce((s, t) => s + t.length, 0); let el = 0; entries = ss.map(s => { const en = { timestamp: el, text: s.trim() }; el += (s.length / tc) * ss.length * 5; return en; }).filter(e => e.text); }
    const para = groupIntoParagraphs(entries.map(e => ({ start: e.timestamp, duration: 2, text: e.text })));
    console.log(`[TR] SUCCESS — ${para.length} paragraphs`);
    res.json({ success: true, entries: para.length > 0 ? para : entries });
  } catch (err) { console.error(`[TR] FAILED: ${err.message}`); res.status(500).json({ success: false, error: err.message }); }
});

/* ══════════════════════════════════════════════════════════
   AI ANALYSIS
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

app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  TranscriptAI running on port ${PORT}\n  YouTube: Ready | Upload: Ready | AI: ${process.env.ANTHROPIC_API_KEY ? "Ready" : "Set ANTHROPIC_API_KEY"}\n`);
});
