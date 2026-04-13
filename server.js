// WIDEN YouTube Shorts Automation
// Auto-generates and uploads migration-topic YouTube Shorts 3x per week
var express = require('express');
var Database = require('better-sqlite3');
var Anthropic = require('@anthropic-ai/sdk').default;
var { google } = require('googleapis');
var { createCanvas, registerFont } = require('canvas');
var ffmpeg = require('fluent-ffmpeg');
var ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
var ffprobePath = require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var { execSync } = require('child_process');

console.log('[FFmpeg] ' + ffmpegPath);
console.log('[FFprobe] ' + ffprobePath);

// Register bundled DejaVu Sans fonts for canvas text rendering
var FONT_REGULAR = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
var FONT_BOLD = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
try {
  registerFont(FONT_REGULAR, { family: 'DejaVu Sans', weight: 'normal' });
  registerFont(FONT_BOLD, { family: 'DejaVu Sans', weight: 'bold' });
  console.log('[Font] Registered bundled DejaVu Sans + Bold');
} catch(e) { console.log('[Font] Warning:', e.message); }

var app = express();
var PORT = process.env.PORT || 3000;
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'WidenShorts2026!';

// ===== DATABASE =====
var dbPath = fs.existsSync('/data') ? '/data/shorts.db' : './shorts.db';
var db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Clear stale YouTube token from DB so YOUTUBE_REFRESH_TOKEN env var is picked up
if (process.env.YOUTUBE_REFRESH_TOKEN) {
  var existingToken = db.prepare("SELECT value FROM settings WHERE key='google_token'").get();
  if (existingToken) {
    try {
      var parsed = JSON.parse(existingToken.value);
      if (parsed.refresh_token !== process.env.YOUTUBE_REFRESH_TOKEN) {
        db.prepare("DELETE FROM settings WHERE key='google_token'").run();
        console.log('[YouTube] Cleared stale DB token — will use YOUTUBE_REFRESH_TOKEN env var');
      }
    } catch(e) {
      db.prepare("DELETE FROM settings WHERE key='google_token'").run();
      console.log('[YouTube] Cleared corrupt DB token');
    }
  }
}

var tmpDir = fs.existsSync('/data') ? '/data/tmp' : './tmp';
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

db.exec(`CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  topic TEXT,
  category TEXT,
  video_type TEXT DEFAULT 'short',
  script_json TEXT,
  voiceover TEXT,
  duration_seconds REAL,
  youtube_id TEXT,
  youtube_url TEXT,
  status TEXT DEFAULT 'pending',
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME
)`);
try { db.exec("ALTER TABLE videos ADD COLUMN video_type TEXT DEFAULT 'short'"); } catch(e) {}

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
)`);

// Pause/resume flag
var schedulerPaused = false;
try {
  var pauseRow = db.prepare("SELECT value FROM settings WHERE key='paused'").get();
  if (pauseRow && pauseRow.value === '1') schedulerPaused = true;
} catch(e) {}

// ===== TOPIC ROTATION =====
var CATEGORIES = [
  { name: '482 visa tips', topics: ['482 TSS visa application tips', '482 visa processing times', '482 visa salary requirements (TSMIT)', '482 visa occupation list', '482 visa to 186 PR pathway', 'Employer sponsorship obligations for 482', '482 visa genuine position requirement'] },
  { name: 'RPL explainers', topics: ['What is RPL (Recognition of Prior Learning)', 'RPL for aged care workers', 'RPL for hospitality and chefs', 'RPL for early childhood educators', 'RPL vs traditional study', 'RPL evidence you need to prepare', 'USI number for RPL'] },
  { name: 'Parent visa guides', topics: ['Parent visa 103 vs 143 explained', 'Contributory parent visa costs', 'Aged parent visa subclass 804', 'Balance of family test', 'Assurance of Support for parent visas', 'Parent visa processing times 2026', 'Subclass 884 temporary pathway'] },
  { name: 'Skills assessment tips', topics: ['Skills assessment for Australian visas', 'TRA skills assessment for trades', 'ACS skills assessment for IT', 'Engineers Australia CDR tips', 'ANMAC assessment for nurses', 'Skills assessment processing times', 'Positive skills assessment benefits'] },
  { name: 'Migration agent Q&A', topics: ['Do you need a migration agent', 'How to choose a migration agent', 'What is a MARN number', 'Migration agent vs immigration lawyer', 'Red flags with migration agents', 'Free consultation what to expect', 'MARA complaints process'] }
];

// ===== LONG-FORM TOPICS (5-10 min deep-dive videos) =====
var LONG_FORM_TOPICS = [
  { category: 'Visa deep-dive', topic: '482 TSS Visa Complete Guide 2026 — Eligibility, Costs, Processing Times, Employer Obligations and Pathway to PR' },
  { category: 'Visa deep-dive', topic: '186 Employer Nomination Scheme — Direct Entry vs Transition Stream, Requirements, Costs and Timeline' },
  { category: 'Visa deep-dive', topic: '494 Skilled Employer Sponsored Regional Visa — Who Qualifies, Regional Areas, Pathway to 191 PR' },
  { category: 'Visa deep-dive', topic: '407 Training Visa Explained — Sponsorship, Training Plans, Sequential Lodgement Rules and Common Mistakes' },
  { category: 'Visa deep-dive', topic: 'Partner Visa Australia — Subclass 820/801 Onshore vs 309/100 Offshore, Evidence, Costs and Processing' },
  { category: 'Visa deep-dive', topic: 'Parent Visa Australia — 103 vs 143 vs 804 vs 864, Costs, Wait Times and Assurance of Support' },
  { category: 'Visa deep-dive', topic: 'Student Visa to PR Pathway — Subclass 500 to Skilled Visa, Study Options and Transition Strategy' },
  { category: 'Skills & RPL', topic: 'Skills Assessment Complete Guide — TRA, ACS, Engineers Australia, ANMAC and All Assessing Authorities' },
  { category: 'Skills & RPL', topic: 'RPL Recognition of Prior Learning — How It Works, Evidence Needed, Costs, Qualifications and Visa Benefits' },
  { category: 'Skills & RPL', topic: 'CDR Writing for Engineers Australia — Career Episodes, Summary Statement and CPD Best Practices' },
  { category: 'Employer guide', topic: 'How to Become an Approved Sponsor in Australia — Application, Costs, Obligations and Compliance' },
  { category: 'Employer guide', topic: 'Labour Market Testing Requirements — What Employers Must Do Before Sponsoring a 482 or 494 Visa' },
  { category: 'Employer guide', topic: 'Employer Sponsorship Obligations — Record Keeping, Notification Duties, Penalties and How to Stay Compliant' },
  { category: 'Migration guide', topic: 'Points Test Explained — Subclass 189, 190, 491, How to Maximise Points and Common Mistakes' },
  { category: 'Migration guide', topic: 'How to Find Employer Sponsorship in Australia — Where to Look, How to Approach Employers and Red Flags' },
  { category: 'Migration guide', topic: 'English Test for Australian Visas — IELTS vs PTE vs OET, Score Requirements and Preparation Tips' },
  { category: 'Migration guide', topic: 'Regional Migration Benefits — 494 Visa, Regional Areas, Lower Thresholds and 191 PR Pathway' },
  { category: 'Migration guide', topic: 'Bridging Visas Explained — Types A B C D E, Work Rights, Travel and What Happens When Your Visa Expires' }
];

function pickNextLongFormTopic() {
  var recent = db.prepare("SELECT topic FROM videos WHERE video_type = 'long' AND created_at > datetime('now', '-60 days')").all().map(function(r) { return (r.topic || '').toLowerCase(); });
  for (var i = 0; i < LONG_FORM_TOPICS.length; i++) {
    if (recent.indexOf(LONG_FORM_TOPICS[i].topic.toLowerCase()) === -1) {
      return LONG_FORM_TOPICS[i];
    }
  }
  return LONG_FORM_TOPICS[Math.floor(Math.random() * LONG_FORM_TOPICS.length)];
}

function pickNextTopic() {
  // Get topics used in last 4 weeks
  var recent = db.prepare("SELECT topic FROM videos WHERE created_at > datetime('now', '-28 days')").all().map(function(r) { return (r.topic || '').toLowerCase(); });
  // Rotate categories evenly
  var catCounts = {};
  CATEGORIES.forEach(function(c) { catCounts[c.name] = 0; });
  var recentCats = db.prepare("SELECT category FROM videos WHERE created_at > datetime('now', '-14 days')").all();
  recentCats.forEach(function(r) { if (r.category && catCounts[r.category] !== undefined) catCounts[r.category]++; });
  // Pick least-used category
  var sorted = Object.entries(catCounts).sort(function(a, b) { return a[1] - b[1]; });
  for (var i = 0; i < sorted.length; i++) {
    var catName = sorted[i][0];
    var cat = CATEGORIES.find(function(c) { return c.name === catName; });
    if (!cat) continue;
    for (var j = 0; j < cat.topics.length; j++) {
      if (recent.indexOf(cat.topics[j].toLowerCase()) === -1) {
        return { category: catName, topic: cat.topics[j] };
      }
    }
  }
  // Fallback: random from any category
  var all = [];
  CATEGORIES.forEach(function(c) { c.topics.forEach(function(t) { all.push({ category: c.name, topic: t }); }); });
  return all[Math.floor(Math.random() * all.length)];
}

// ===== YOUTUBE OAUTH2 =====
// Token resolution order: DB settings → GOOGLE_TOKEN_JSON env → YOUTUBE_REFRESH_TOKEN env (minimal rebuild)
function loadTokens() {
  // 1. Try full token from DB
  var row = db.prepare("SELECT value FROM settings WHERE key='google_token'").get();
  if (row && row.value) { try { return JSON.parse(row.value); } catch(e) {} }
  // 2. Try full token from env
  if (process.env.GOOGLE_TOKEN_JSON) { try { return JSON.parse(process.env.GOOGLE_TOKEN_JSON); } catch(e) {} }
  // 3. Rebuild from refresh token env var (survives redeploys without a volume)
  if (process.env.YOUTUBE_REFRESH_TOKEN) {
    return { refresh_token: process.env.YOUTUBE_REFRESH_TOKEN };
  }
  return null;
}

function saveTokens(tokens) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('google_token', ?)").run(JSON.stringify(tokens));
  // Log refresh token so the user can copy it into Railway env vars as a backup
  if (tokens.refresh_token) {
    console.log('[YouTube] Refresh token available. Set YOUTUBE_REFRESH_TOKEN in Railway env vars to survive redeploys without a volume:');
    console.log('[YouTube] YOUTUBE_REFRESH_TOKEN=' + tokens.refresh_token);
  }
}

function getOAuth2Client() {
  var creds;
  try { creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); } catch(e) { return null; }
  var conf = creds.web || creds.installed || {};
  var baseUrl = process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + PORT);
  var client = new google.auth.OAuth2(conf.client_id, conf.client_secret, baseUrl + '/oauth2callback');

  var tokens = loadTokens();
  if (tokens) client.setCredentials(tokens);

  client.on('tokens', function(t) {
    var merged = Object.assign({}, tokens || {}, t);
    saveTokens(merged);
    tokens = merged;
  });
  return client;
}

function isYouTubeAuthorized() {
  return !!loadTokens();
}

app.get('/auth/youtube', function(req, res) {
  var client = getOAuth2Client();
  if (!client) return res.status(500).send('GOOGLE_CREDENTIALS_JSON not configured');
  var url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/cloud-platform']
  });
  res.redirect(url);
});

app.get('/oauth2callback', async function(req, res) {
  try {
    var client = getOAuth2Client();
    var { tokens } = await client.getToken(req.query.code);
    saveTokens(tokens);
    console.log('[YouTube] Authorized successfully.');
    var refreshNote = tokens.refresh_token
      ? '<p style="margin-top:16px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:8px;padding:12px;font-size:0.85em;text-align:left;"><strong>Important:</strong> Copy this refresh token into Railway env var <code>YOUTUBE_REFRESH_TOKEN</code> so it survives redeploys:<br><code style="word-break:break-all;color:#10b981;">' + tokens.refresh_token + '</code></p>'
      : '';
    res.send('<html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;"><div style="text-align:center;max-width:600px;"><h1 style="color:#10b981;">YouTube Authorized!</h1><p>You can close this window and return to the admin dashboard.</p>' + refreshNote + '<p style="margin-top:16px;"><a href="/admin" style="color:#818cf8;">Go to Admin</a></p></div></body></html>');
  } catch(e) {
    console.log('[YouTube OAuth] Error:', e.message);
    res.status(500).send('OAuth error: ' + e.message);
  }
});

// ===== SCRIPT GENERATION (Claude Haiku) =====
async function generateScript(topicInfo) {
  var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  var recent = db.prepare("SELECT title FROM videos ORDER BY id DESC LIMIT 20").all().map(function(r) { return r.title; });

  var msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: 'You are a content creator for WIDEN Migration Experts, an Australian migration agency in Sydney (MARN 1576536).\n\n' +
        'Generate a YouTube Shorts script (25-35 seconds when spoken aloud — MUST be under 40 seconds) about: ' + topicInfo.topic + '\n' +
        'Category: ' + topicInfo.category + '\n\n' +
        'STYLE RULES:\n' +
        '- Conversational, simple English suitable for migrants and non-native speakers\n' +
        '- No jargon without explanation\n' +
        '- Engaging hook in the first sentence\n' +
        '- End the voiceover with: "This is general information only, not migration advice. Always check with a registered migration agent. Call us on 02 8188 1887 or visit widen.com.au for a free consultation."\n' +
        '- Do NOT repeat any of these recent titles: ' + recent.join('; ') + '\n\n' +
        'Return ONLY valid JSON (no markdown):\n' +
        '{\n' +
        '  "title": "YouTube title — attention-grabbing, use numbers/questions/caps for key words (max 60 chars, e.g. THIS Is Why Your 482 Visa Is Taking So Long)",\n' +
        '  "slides": [\n' +
        '    { "heading": "Bold text (max 5 words)", "body": "1 short sentence (max 15 words)", "icon": "emoji" },\n' +
        '    ... 4-5 slides total (keep it SHORT)\n' +
        '  ],\n' +
        '  "voiceover": "Full narration script as one continuous paragraph (25-35 seconds when spoken — MUST be under 40 seconds total)",\n' +
        '  "bgKeyword": "2-3 word Pexels stock video search term (e.g. Australia city, office work, Sydney skyline, airport travel)"\n' +
        '}'
    }]
  });

  var text = msg.content[0].text.trim();
  // Strip markdown code blocks if present
  text = text.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

// ===== SUBTITLE GENERATION =====
function generateSRT(voiceover, totalDuration) {
  // Split voiceover into chunks of ~8-12 words for subtitle lines
  var words = (voiceover || '').split(/\s+/);
  var chunks = [];
  var chunk = [];
  for (var i = 0; i < words.length; i++) {
    chunk.push(words[i]);
    if (chunk.length >= 8 || i === words.length - 1) {
      chunks.push(chunk.join(' '));
      chunk = [];
    }
  }
  if (chunks.length === 0) return '';

  var chunkDuration = totalDuration / chunks.length;
  var srt = '';
  for (var j = 0; j < chunks.length; j++) {
    var startSec = j * chunkDuration;
    var endSec = (j + 1) * chunkDuration;
    srt += (j + 1) + '\n';
    srt += formatSRTTime(startSec) + ' --> ' + formatSRTTime(endSec) + '\n';
    srt += chunks[j] + '\n\n';
  }
  return srt;
}

function formatSRTTime(sec) {
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = Math.floor(sec % 60);
  var ms = Math.round((sec % 1) * 1000);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
}

// ===== THUMBNAIL GENERATION =====
function generateThumbnail(title, bgKeyword, isLong) {
  var W = isLong ? 1280 : 1080;
  var H = isLong ? 720 : 1920;
  var canvas = createCanvas(W, H);
  var ctx = canvas.getContext('2d');

  // Bold gradient background
  var grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0a1628');
  grad.addColorStop(0.4, '#1a2e4a');
  grad.addColorStop(1, '#0d3b66');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Accent bar at top
  var accentGrad = ctx.createLinearGradient(0, 0, W, 0);
  accentGrad.addColorStop(0, '#10b981');
  accentGrad.addColorStop(1, '#06b6d4');
  ctx.fillStyle = accentGrad;
  ctx.fillRect(0, 0, W, 8);

  // Large decorative circle (subtle)
  ctx.fillStyle = 'rgba(16,185,129,0.08)';
  ctx.beginPath();
  ctx.arc(W * 0.75, H * 0.4, isLong ? 250 : 400, 0, Math.PI * 2);
  ctx.fill();

  // Title text — large, bold, white with word wrap
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  var fontSize = isLong ? 62 : 72;
  ctx.font = 'bold ' + fontSize + 'px "DejaVu Sans", sans-serif';
  var titleY = isLong ? H * 0.32 : H * 0.35;
  wrapText(ctx, title || 'WIDEN Migration', W / 2, titleY, W - 120, fontSize + 14);

  // "WIDEN Migration Experts" badge
  var badgeY = isLong ? H - 140 : H - 300;
  ctx.fillStyle = 'rgba(16,185,129,0.2)';
  var badgeW = 460, badgeH = 56;
  ctx.beginPath();
  ctx.roundRect(W / 2 - badgeW / 2, badgeY, badgeW, badgeH, 28);
  ctx.fill();
  ctx.fillStyle = '#10b981';
  ctx.font = 'bold 28px "DejaVu Sans", sans-serif';
  ctx.fillText('WIDEN Migration Experts', W / 2, badgeY + 38);

  // MARN line
  ctx.fillStyle = '#94a3b8';
  ctx.font = '22px "DejaVu Sans", sans-serif';
  ctx.fillText('MARN 1576536 | widen.com.au', W / 2, badgeY + badgeH + 32);

  return canvas.toBuffer('image/png');
}

async function uploadThumbnail(youtubeVideoId, thumbnailBuffer) {
  var auth = getOAuth2Client();
  if (!auth) return;
  var youtube = google.youtube({ version: 'v3', auth: auth });
  var thumbPath = path.join(tmpDir, 'thumb_' + Date.now() + '.png');
  fs.writeFileSync(thumbPath, thumbnailBuffer);
  try {
    await youtube.thumbnails.set({
      videoId: youtubeVideoId,
      media: { mimeType: 'image/png', body: fs.createReadStream(thumbPath) }
    });
    console.log('[Thumbnail] Uploaded for ' + youtubeVideoId);
  } catch(e) {
    console.log('[Thumbnail] Upload failed (may need verified channel):', e.message.slice(0, 150));
  }
  try { fs.unlinkSync(thumbPath); } catch(e) {}
}

// ===== VOICE SYNTHESIS (Google Cloud Text-to-Speech) =====
async function generateAudio(text, outputPath) {
  var auth = getOAuth2Client();
  if (!auth) throw new Error('Google credentials not configured');

  // Google TTS REST API — uses the same OAuth2 credentials as YouTube
  var accessToken = (await auth.getAccessToken()).token;
  var voiceName = process.env.TTS_VOICE || 'en-AU-Neural2-B'; // Professional Australian male

  var r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: { text: text },
      voice: {
        languageCode: 'en-AU',
        name: voiceName,
        ssmlGender: 'MALE'
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 1.05,
        pitch: -1.0,
        effectsProfileId: ['large-home-entertainment-class-device']
      }
    })
  });

  if (!r.ok) {
    var errBody = await r.text();
    throw new Error('Google TTS ' + r.status + ': ' + errBody.slice(0, 300));
  }

  var data = await r.json();
  if (!data.audioContent) throw new Error('Google TTS returned no audio content');

  var buf = Buffer.from(data.audioContent, 'base64');
  fs.writeFileSync(outputPath, buf);
  console.log('[TTS] Generated ' + (buf.length / 1024).toFixed(0) + ' KB audio via Google Cloud TTS (' + voiceName + ')');
  return outputPath;
}

// ===== PEXELS STOCK VIDEO BACKGROUND =====
var https = require('https');
var http = require('http');

function downloadFile(url, destPath) {
  return new Promise(function(resolve, reject) {
    var proto = url.startsWith('https') ? https : http;
    function doGet(u) {
      proto.get(u, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          var loc = res.headers.location;
          if (loc.startsWith('https')) proto = https;
          else proto = http;
          doGet(loc);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error('Download HTTP ' + res.statusCode)); return; }
        var ws = fs.createWriteStream(destPath);
        res.pipe(ws);
        ws.on('finish', function() { ws.close(); resolve(destPath); });
        ws.on('error', reject);
      }).on('error', reject);
    }
    doGet(url);
  });
}

async function fetchPexelsVideo(keyword) {
  if (!process.env.PEXELS_API_KEY) { console.log('[Pexels] No API key'); return null; }
  try {
    var q = encodeURIComponent(keyword || 'Australia city');
    var url = 'https://api.pexels.com/videos/search?query=' + q + '&orientation=portrait&size=medium&per_page=5';
    var r = await fetch(url, { headers: { Authorization: process.env.PEXELS_API_KEY } });
    if (!r.ok) { console.log('[Pexels] HTTP ' + r.status); return null; }
    var data = await r.json();
    if (!data.videos || !data.videos.length) { console.log('[Pexels] No results for "' + keyword + '"'); return null; }
    // Pick a video file — prefer HD quality, portrait
    var video = data.videos[0];
    var files = video.video_files || [];
    // Sort: prefer height >= 1920, then largest
    files.sort(function(a, b) {
      var aFit = (a.height || 0) >= 1920 ? 1 : 0;
      var bFit = (b.height || 0) >= 1920 ? 1 : 0;
      if (aFit !== bFit) return bFit - aFit;
      return (b.height || 0) - (a.height || 0);
    });
    var pick = files[0];
    if (!pick || !pick.link) { console.log('[Pexels] No video file link'); return null; }
    console.log('[Pexels] Found: ' + (pick.width || '?') + 'x' + (pick.height || '?') + ' from "' + keyword + '"');
    return pick.link;
  } catch(e) { console.log('[Pexels] Error:', e.message); return null; }
}

// ===== SLIDE RENDERING (node-canvas fallback) =====
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  var words = (text || '').split(' ');
  var line = '';
  var lines = [];
  for (var i = 0; i < words.length; i++) {
    var test = line + words[i] + ' ';
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line.trim());
      line = words[i] + ' ';
    } else {
      line = test;
    }
  }
  lines.push(line.trim());
  for (var j = 0; j < lines.length; j++) {
    ctx.fillText(lines[j], x, y + j * lineHeight);
  }
  return lines.length;
}

function renderSlide(slide, index, total) {
  var W = 1080, H = 1920;
  var canvas = createCanvas(W, H);
  var ctx = canvas.getContext('2d');

  // Background gradient
  var grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0a1628');
  grad.addColorStop(0.5, '#1a2e4a');
  grad.addColorStop(1, '#0d3b66');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Accent line at top
  ctx.fillStyle = '#10b981';
  ctx.fillRect(0, 0, W, 6);

  // Slide number pill
  ctx.fillStyle = 'rgba(16,185,129,0.2)';
  ctx.beginPath();
  ctx.roundRect(W / 2 - 40, 80, 80, 40, 20);
  ctx.fill();
  ctx.fillStyle = '#10b981';
  ctx.font = 'bold 22px "DejaVu Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText((index + 1) + ' / ' + total, W / 2, 107);

  // Icon/emoji
  if (slide.icon) {
    ctx.font = '120px "DejaVu Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(slide.icon, W / 2, 400);
  }

  // Heading
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 72px "DejaVu Sans", sans-serif';
  ctx.textAlign = 'center';
  wrapText(ctx, slide.heading || '', W / 2, 560, 900, 88);

  // Body
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '44px "DejaVu Sans", sans-serif';
  ctx.textAlign = 'center';
  wrapText(ctx, slide.body || '', W / 2, 820, 900, 58);

  // Bottom branding
  ctx.fillStyle = 'rgba(16,185,129,0.15)';
  ctx.fillRect(0, H - 180, W, 180);
  ctx.fillStyle = '#10b981';
  ctx.font = 'bold 38px "DejaVu Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('WIDEN Migration Experts', W / 2, H - 110);
  ctx.fillStyle = '#64748b';
  ctx.font = '28px "DejaVu Sans", sans-serif';
  ctx.fillText('widen.com.au | 02 8188 1887 | MARN 1576536', W / 2, H - 60);

  return canvas.toBuffer('image/png');
}

// ===== VIDEO ASSEMBLY (FFmpeg) =====
function getAudioDuration(audioPath) {
  return new Promise(function(resolve, reject) {
    ffmpeg.ffprobe(audioPath, function(err, meta) {
      if (err) return reject(err);
      resolve(meta.format.duration);
    });
  });
}

// Escape text for FFmpeg drawtext filter
function dtEsc(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/%/g, '%%');
}

async function assembleVideo(slides, audioPath, outputPath, bgVideoUrl) {
  var duration = await getAudioDuration(audioPath);
  var slideDuration = duration / slides.length;
  var ts = Date.now();
  var tempFiles = [];

  // Try Pexels video background
  var bgPath = null;
  if (bgVideoUrl) {
    try {
      bgPath = path.join(tmpDir, 'bg_' + ts + '.mp4');
      console.log('[Video] Downloading Pexels background...');
      await downloadFile(bgVideoUrl, bgPath);
      tempFiles.push(bgPath);
      console.log('[Video] Background downloaded: ' + (fs.statSync(bgPath).size / 1024).toFixed(0) + ' KB');
    } catch(e) {
      console.log('[Video] Pexels download failed:', e.message, '— using solid background');
      bgPath = null;
    }
  }

  function cleanup() {
    tempFiles.forEach(function(f) { try { fs.unlinkSync(f); } catch(e) {} });
  }

  if (bgPath) {
    // ===== PEXELS VIDEO BACKGROUND + DRAWTEXT (raw execSync) =====
    var filters = ['scale=1080:1920:force_original_aspect_ratio=increase', 'crop=1080:1920', 'setpts=PTS-STARTPTS', 'colorchannelmixer=rr=0.4:gg=0.4:bb=0.4'];
    for (var i = 0; i < slides.length; i++) {
      var s = (i * slideDuration).toFixed(2);
      var e = ((i + 1) * slideDuration).toFixed(2);
      var en = "enable='between(t," + s + "," + e + ")'";
      var head = (slides[i].heading || '').replace(/'/g, "\u2019").replace(/:/g, "\\:");
      var body = (slides[i].body || '').replace(/'/g, "\u2019").replace(/:/g, "\\:");
      filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='" + (i+1) + " / " + slides.length + "':fontcolor=#10b981:fontsize=28:x=(w-text_w)/2:y=100:" + en);
      filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='" + head + "':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h/2)-160:" + en);
      filters.push("drawtext=fontfile='" + FONT_REGULAR + "':text='" + body + "':fontcolor=#cbd5e1:fontsize=38:x=(w-text_w)/2:y=(h/2)+20:" + en);
    }
    filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='WIDEN Migration Experts':fontcolor=#10b981:fontsize=36:x=(w-text_w)/2:y=h-140");
    filters.push("drawtext=fontfile='" + FONT_REGULAR + "':text='widen.com.au | MARN 1576536':fontcolor=#94a3b8:fontsize=26:x=(w-text_w)/2:y=h-80");
    filters.push("drawtext=fontfile='" + FONT_REGULAR + "':text='General information only. Not migration advice.':fontcolor=#64748b:fontsize=20:x=(w-text_w)/2:y=h-40");

    var filterScript = path.join(tmpDir, 'pxfilter_' + Date.now() + '.txt');
    fs.writeFileSync(filterScript, filters.join(',\n'));

    var cmd = ffmpegPath +
      ' -stream_loop -1 -i "' + bgPath + '"' +
      ' -i "' + audioPath + '"' +
      ' -filter_script:v "' + filterScript + '"' +
      ' -map 0:v -map 1:a' +
      ' -c:v libx264 -pix_fmt yuv420p -preset fast' +
      ' -c:a aac -b:a 128k' +
      ' -shortest -movflags +faststart' +
      ' -t ' + duration.toFixed(2) +
      ' -y "' + outputPath + '"';

    console.log('[FFmpeg] Running Pexels-bg command...');
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 180000 });
      try { fs.unlinkSync(filterScript); } catch(e) {}
      cleanup();
      return outputPath;
    } catch(err) {
      var stderr = err.stderr ? err.stderr.toString().slice(-300) : err.message;
      console.log('[Video] Pexels FFmpeg failed:', stderr, '— retrying with solid bg');
      try { fs.unlinkSync(filterScript); } catch(e) {}
      cleanup();
      return assembleVideoSolid(slides, audioPath, outputPath, slideDuration);
    }
  } else {
    return assembleVideoSolid(slides, audioPath, outputPath, slideDuration);
  }
}

// Fallback: FFmpeg color source + drawtext (no canvas, no fontconfig needed)
async function assembleVideoSolid(slides, audioPath, outputPath, slideDuration) {
  if (!slideDuration) {
    var dur = await getAudioDuration(audioPath);
    slideDuration = dur / slides.length;
  }
  var totalDuration = slideDuration * slides.length;

  // Build filter_script file — avoids all shell/fluent-ffmpeg escaping issues
  var filters = [];
  for (var i = 0; i < slides.length; i++) {
    var s = (i * slideDuration).toFixed(2);
    var e = ((i + 1) * slideDuration).toFixed(2);
    var en = "enable='between(t," + s + "," + e + ")'";
    var head = (slides[i].heading || '').replace(/'/g, "\u2019").replace(/:/g, "\\:");
    var body = (slides[i].body || '').replace(/'/g, "\u2019").replace(/:/g, "\\:");
    filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='" + (i+1) + " / " + slides.length + "':fontcolor=#10b981:fontsize=28:x=(w-text_w)/2:y=100:" + en);
    filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='" + head + "':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h/2)-160:" + en);
    filters.push("drawtext=fontfile='" + FONT_REGULAR + "':text='" + body + "':fontcolor=#cbd5e1:fontsize=38:x=(w-text_w)/2:y=(h/2)+20:" + en);
  }
  filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='WIDEN Migration Experts':fontcolor=#10b981:fontsize=36:x=(w-text_w)/2:y=h-140");
  filters.push("drawtext=fontfile='" + FONT_REGULAR + "':text='widen.com.au | MARN 1576536':fontcolor=#94a3b8:fontsize=26:x=(w-text_w)/2:y=h-80");

  var filterScript = path.join(tmpDir, 'filter_' + Date.now() + '.txt');
  fs.writeFileSync(filterScript, filters.join(',\n'));

  var cmd = ffmpegPath +
    ' -f lavfi -i "color=c=#0f172a:s=1080x1920:r=30:d=' + totalDuration.toFixed(2) + '"' +
    ' -i "' + audioPath + '"' +
    ' -filter_script:v "' + filterScript + '"' +
    ' -map 0:v -map 1:a' +
    ' -c:v libx264 -pix_fmt yuv420p -preset fast' +
    ' -c:a aac -b:a 128k' +
    ' -shortest -movflags +faststart' +
    ' -t ' + totalDuration.toFixed(2) +
    ' -y "' + outputPath + '"';

  console.log('[FFmpeg] Running solid-bg command...');
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 120000 });
    try { fs.unlinkSync(filterScript); } catch(e) {}
    return outputPath;
  } catch(err) {
    try { fs.unlinkSync(filterScript); } catch(e) {}
    var stderr = err.stderr ? err.stderr.toString().slice(-500) : err.message;
    throw new Error('FFmpeg solid-bg failed: ' + stderr);
  }
}

// ===== YOUTUBE UPLOAD =====
async function uploadToYouTube(videoPath, title, description, tags, isLong) {
  var auth = getOAuth2Client();
  if (!auth) throw new Error('YouTube not authorized. Visit /auth/youtube first.');
  var youtube = google.youtube({ version: 'v3', auth: auth });

  try {
    var res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: title.slice(0, 100),
          description: description + (isLong ? '' : '\n\n#Shorts'),
          tags: tags || [],
          categoryId: '27' // Education
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false
        }
      },
      media: { body: fs.createReadStream(videoPath) }
    });
    var urlBase = isLong ? 'https://youtube.com/watch?v=' : 'https://youtube.com/shorts/';
    return { id: res.data.id, url: urlBase + res.data.id };
  } catch(e) {
    var detail = '';
    if (e.response && e.response.data) {
      detail = JSON.stringify(e.response.data).slice(0, 500);
      console.log('[YouTube Upload] API error:', detail);
    } else if (e.errors) {
      detail = JSON.stringify(e.errors).slice(0, 500);
      console.log('[YouTube Upload] errors:', detail);
    }
    throw new Error('YouTube upload failed: ' + (detail || e.message));
  }
}

// ===== MAIN PIPELINE =====
async function createAndPublishShort(topicOverride) {
  var topicInfo = topicOverride ? { category: 'custom', topic: topicOverride } : pickNextTopic();
  console.log('[Pipeline] Starting: ' + topicInfo.topic + ' (' + topicInfo.category + ')');

  var videoId = db.prepare("INSERT INTO videos (title, topic, category, status) VALUES ('Generating...', ?, ?, 'generating')").run(topicInfo.topic, topicInfo.category).lastInsertRowid;

  try {
    // Step 1: Script
    console.log('[Pipeline] Generating script...');
    var script = await generateScript(topicInfo);
    db.prepare("UPDATE videos SET title=?, script_json=?, voiceover=? WHERE id=?").run(script.title, JSON.stringify(script.slides), script.voiceover, videoId);
    console.log('[Pipeline] Script: "' + script.title + '" (' + script.slides.length + ' slides)');

    // Step 2: Audio
    console.log('[Pipeline] Generating voiceover...');
    var audioPath = path.join(tmpDir, 'audio_' + videoId + '.mp3');
    await generateAudio(script.voiceover, audioPath);
    var audioDuration = await getAudioDuration(audioPath);
    console.log('[Pipeline] Audio: ' + audioDuration.toFixed(1) + 's');

    // Validate duration — target under 40s for Shorts
    if (audioDuration > 40) {
      console.log('[Pipeline] WARNING: Audio is ' + audioDuration.toFixed(1) + 's (over 40s target). Regenerating shorter script...');
      // Retry with explicit short instruction
      topicInfo.topic = topicInfo.topic + ' (VERY SHORT — under 30 seconds)';
      var shortScript = await generateScript(topicInfo);
      script = shortScript;
      db.prepare("UPDATE videos SET title=?, script_json=?, voiceover=? WHERE id=?").run(script.title, JSON.stringify(script.slides), script.voiceover, videoId);
      fs.unlinkSync(audioPath);
      await generateAudio(script.voiceover, audioPath);
      audioDuration = await getAudioDuration(audioPath);
      console.log('[Pipeline] Retry audio: ' + audioDuration.toFixed(1) + 's');
    }

    db.prepare("UPDATE videos SET duration_seconds=? WHERE id=?").run(audioDuration, videoId);

    // Step 2.5: Pexels background
    var bgVideoUrl = null;
    if (script.bgKeyword) {
      bgVideoUrl = await fetchPexelsVideo(script.bgKeyword);
    }

    // Step 3: Video
    console.log('[Pipeline] Assembling video...');
    var videoPath = path.join(tmpDir, 'video_' + videoId + '.mp4');
    await assembleVideo(script.slides, audioPath, videoPath, bgVideoUrl);
    console.log('[Pipeline] Video assembled: ' + videoPath);

    // Step 3.5: Burn subtitles
    var srtContent = generateSRT(script.voiceover, audioDuration);
    if (srtContent) {
      var srtPath = path.join(tmpDir, 'subs_' + videoId + '.srt');
      fs.writeFileSync(srtPath, srtContent);
      var subbedPath = path.join(tmpDir, 'subbed_' + videoId + '.mp4');
      var subStyle = "FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=0,MarginV=120";
      var subCmd = ffmpegPath +
        ' -i "' + videoPath + '"' +
        " -vf \"subtitles='" + srtPath.replace(/'/g, "'\\''") + "':force_style='" + subStyle + "'\"" +
        ' -c:a copy -c:v libx264 -pix_fmt yuv420p -preset fast' +
        ' -y "' + subbedPath + '"';
      try {
        console.log('[Pipeline] Burning subtitles...');
        execSync(subCmd, { stdio: 'pipe', timeout: 120000 });
        fs.unlinkSync(videoPath);
        fs.renameSync(subbedPath, videoPath);
        console.log('[Pipeline] Subtitles burned in');
      } catch(subErr) {
        console.log('[Pipeline] Subtitle burn failed (proceeding without):', (subErr.stderr || subErr.message).toString().slice(-200));
        try { fs.unlinkSync(subbedPath); } catch(e) {}
      }
      try { fs.unlinkSync(srtPath); } catch(e) {}
    }

    // Step 4: Upload
    if (!isYouTubeAuthorized()) {
      db.prepare("UPDATE videos SET status='ready', error='YouTube not authorized — visit /auth/youtube' WHERE id=?").run(videoId);
      console.log('[Pipeline] Skipping upload — YouTube not authorized. Video saved locally.');
      return { id: videoId, status: 'ready', title: script.title };
    }

    console.log('[Pipeline] Uploading to YouTube...');
    db.prepare("UPDATE videos SET status='uploading' WHERE id=?").run(videoId);

    var desc = script.title + '\n\n' +
      script.slides.map(function(s) { return s.heading; }).join(' | ') + '\n\n' +
      'DISCLAIMER: This video is general information only and does not constitute migration advice. Always consult a registered migration agent before making decisions about your visa or migration pathway.\n\n' +
      'WIDEN Migration Experts\n' +
      'widen.com.au | 02 8188 1887\n' +
      'MARN 1576536\n' +
      'Office 6, 2-16 Anglo Road, Campsie NSW 2194\n\n' +
      '#migration #australia #visa #shorts #482visa #rpl #migrationagent #sydneymigration';

    var tags = ['migration australia', 'visa australia', '482 visa', 'rpl australia', 'migration agent sydney', 'australian visa', 'employer sponsorship', 'widen migration'];
    var result = await uploadToYouTube(videoPath, script.title + ' | WIDEN Migration', desc, tags);

    db.prepare("UPDATE videos SET youtube_id=?, youtube_url=?, status='published', published_at=CURRENT_TIMESTAMP WHERE id=?").run(result.id, result.url, videoId);
    console.log('[Pipeline] Published: ' + result.url);

    // Upload thumbnail
    try {
      var thumb = generateThumbnail(script.title, script.bgKeyword, false);
      await uploadThumbnail(result.id, thumb);
    } catch(e) { console.log('[Pipeline] Thumbnail error:', e.message.slice(0, 100)); }

    // Cleanup
    try { fs.unlinkSync(audioPath); } catch(e) {}
    try { fs.unlinkSync(videoPath); } catch(e) {}

    return { id: videoId, youtubeUrl: result.url, title: script.title };
  } catch(e) {
    db.prepare("UPDATE videos SET status='failed', error=? WHERE id=?").run(e.message, videoId);
    console.log('[Pipeline] FAILED: ' + e.message);
    throw e;
  }
}

// ===== LONG-FORM VIDEO PIPELINE =====
async function generateLongFormScript(topicInfo) {
  var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  var recent = db.prepare("SELECT title FROM videos WHERE video_type='long' ORDER BY id DESC LIMIT 10").all().map(function(r) { return r.title; });

  var msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: 'You are a content creator for WIDEN Migration Experts, an Australian migration agency in Sydney (MARN 1576536).\n\n' +
        'Generate a YouTube long-form video script (5-8 minutes when spoken aloud) about:\n' + topicInfo.topic + '\n' +
        'Category: ' + topicInfo.category + '\n\n' +
        'STYLE RULES:\n' +
        '- Conversational, clear English suitable for migrants and non-native speakers\n' +
        '- Structured with clear sections/chapters\n' +
        '- Each section should be a self-contained topic (1-2 minutes)\n' +
        '- Include specific numbers, costs, and timelines where relevant (use 2026 figures)\n' +
        '- Start with a strong hook: "If you are thinking about [topic], this video covers everything you need to know."\n' +
        '- End with: "This is general information only, not migration advice. Always check with a registered migration agent. Call us on 02 8188 1887 or visit widen.com.au for a free consultation."\n' +
        '- Do NOT repeat these recent titles: ' + recent.join('; ') + '\n\n' +
        'Return ONLY valid JSON (no markdown):\n' +
        '{\n' +
        '  "title": "YouTube title — attention-grabbing, use numbers/questions/power words (max 70 chars, e.g. 482 Visa COMPLETE Guide 2026: Everything You Need To Know)",\n' +
        '  "sections": [\n' +
        '    {\n' +
        '      "title": "Section heading (chapter name)",\n' +
        '      "slides": [\n' +
        '        { "heading": "Key point (max 5 words)", "body": "1 sentence (max 20 words)" },\n' +
        '        ... 3-5 slides per section\n' +
        '      ],\n' +
        '      "narration": "Full narration for this section (60-90 seconds when spoken)",\n' +
        '      "bgKeyword": "Pexels search term for this section background"\n' +
        '    },\n' +
        '    ... 4-6 sections total\n' +
        '  ]\n' +
        '}'
    }]
  });

  var text = msg.content[0].text.trim().replace(/^```json?\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

async function assembleLongFormVideo(sections, audioPaths, outputPath) {
  // Build one segment per section, then concatenate
  var segmentFiles = [];
  var ts = Date.now();

  for (var si = 0; si < sections.length; si++) {
    var sec = sections[si];
    var segPath = path.join(tmpDir, 'seg_' + ts + '_' + si + '.mp4');
    var audioPath = audioPaths[si];
    var segDuration = await getAudioDuration(audioPath);
    var slideDuration = segDuration / sec.slides.length;

    // Try Pexels background for this section
    var bgUrl = null;
    if (sec.bgKeyword && process.env.PEXELS_API_KEY) {
      bgUrl = await fetchPexelsVideo(sec.bgKeyword);
    }

    // Build drawtext filters for this segment's slides
    var filters = [];
    if (bgUrl) {
      var bgFile = path.join(tmpDir, 'segbg_' + ts + '_' + si + '.mp4');
      try {
        await downloadFile(bgUrl, bgFile);
        filters.push('scale=1920:1080:force_original_aspect_ratio=increase', 'crop=1920:1080', 'setpts=PTS-STARTPTS', 'colorchannelmixer=rr=0.35:gg=0.35:bb=0.35');
      } catch(e) {
        console.log('[LongForm] Pexels download failed for section ' + si + ', using solid bg');
        bgFile = null;
      }
    } else {
      var bgFile = null;
    }

    for (var i = 0; i < sec.slides.length; i++) {
      var s = (i * slideDuration).toFixed(2);
      var e = ((i + 1) * slideDuration).toFixed(2);
      var en = "enable='between(t," + s + "," + e + ")'";
      var head = (sec.slides[i].heading || '').replace(/'/g, "\u2019").replace(/:/g, "\\:");
      var body = (sec.slides[i].body || '').replace(/'/g, "\u2019").replace(/:/g, "\\:");
      filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='" + (i+1) + "/" + sec.slides.length + "':fontcolor=#10b981:fontsize=24:x=60:y=60:" + en);
      filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='" + head + "':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h/2)-80:" + en);
      filters.push("drawtext=fontfile='" + FONT_REGULAR + "':text='" + body + "':fontcolor=#cbd5e1:fontsize=34:x=(w-text_w)/2:y=(h/2)+40:" + en);
    }
    // Section title card at the start (first 3 seconds)
    var secTitle = (sec.title || '').replace(/'/g, "\u2019").replace(/:/g, "\\:");
    filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='" + secTitle + "':fontcolor=#10b981:fontsize=48:x=(w-text_w)/2:y=(h/2)-20:enable='between(t,0,3)'");
    // Bottom branding always
    filters.push("drawtext=fontfile='" + FONT_BOLD + "':text='WIDEN Migration Experts':fontcolor=#10b981:fontsize=30:x=(w-text_w)/2:y=h-100");
    filters.push("drawtext=fontfile='" + FONT_REGULAR + "':text='widen.com.au | MARN 1576536':fontcolor=#94a3b8:fontsize=22:x=(w-text_w)/2:y=h-60");
    filters.push("drawtext=fontfile='" + FONT_REGULAR + "':text='General information only. Not migration advice.':fontcolor=#64748b:fontsize=18:x=(w-text_w)/2:y=h-30");

    var filterFile = path.join(tmpDir, 'segf_' + ts + '_' + si + '.txt');
    fs.writeFileSync(filterFile, filters.join(',\n'));

    var inputFlag = bgFile
      ? '-stream_loop -1 -i "' + bgFile + '"'
      : '-f lavfi -i "color=c=#0f172a:s=1920x1080:r=30:d=' + segDuration.toFixed(2) + '"';

    var cmd = ffmpegPath +
      ' ' + inputFlag +
      ' -i "' + audioPath + '"' +
      ' -filter_script:v "' + filterFile + '"' +
      ' -map 0:v -map 1:a' +
      ' -c:v libx264 -pix_fmt yuv420p -preset fast' +
      ' -c:a aac -b:a 128k' +
      ' -shortest -movflags +faststart' +
      ' -t ' + segDuration.toFixed(2) +
      ' -y "' + segPath + '"';

    console.log('[LongForm] Assembling section ' + (si + 1) + '/' + sections.length + ' (' + segDuration.toFixed(1) + 's)...');
    execSync(cmd, { stdio: 'pipe', timeout: 300000 });
    segmentFiles.push(segPath);

    // Cleanup temp
    try { fs.unlinkSync(filterFile); } catch(e) {}
    if (bgFile) { try { fs.unlinkSync(bgFile); } catch(e) {} }
  }

  // Concatenate all segments
  var concatFile = path.join(tmpDir, 'longconcat_' + ts + '.txt');
  fs.writeFileSync(concatFile, segmentFiles.map(function(f) { return "file '" + f + "'"; }).join('\n'));

  var concatCmd = ffmpegPath +
    ' -f concat -safe 0 -i "' + concatFile + '"' +
    ' -c copy -movflags +faststart' +
    ' -y "' + outputPath + '"';

  console.log('[LongForm] Concatenating ' + segmentFiles.length + ' sections...');
  execSync(concatCmd, { stdio: 'pipe', timeout: 120000 });

  // Cleanup
  segmentFiles.forEach(function(f) { try { fs.unlinkSync(f); } catch(e) {} });
  try { fs.unlinkSync(concatFile); } catch(e) {}

  return outputPath;
}

async function createAndPublishLongForm(topicOverride) {
  var topicInfo = topicOverride ? { category: 'custom', topic: topicOverride } : pickNextLongFormTopic();
  console.log('[LongForm] Starting: ' + topicInfo.topic);

  var videoId = db.prepare("INSERT INTO videos (title, topic, category, video_type, status) VALUES ('Generating...', ?, ?, 'long', 'generating')").run(topicInfo.topic, topicInfo.category).lastInsertRowid;

  try {
    // Step 1: Script
    console.log('[LongForm] Generating script...');
    var script = await generateLongFormScript(topicInfo);
    db.prepare("UPDATE videos SET title=?, script_json=? WHERE id=?").run(script.title, JSON.stringify(script.sections), videoId);
    console.log('[LongForm] Script: "' + script.title + '" (' + script.sections.length + ' sections)');

    // Step 2: Generate audio per section
    console.log('[LongForm] Generating voiceover (' + script.sections.length + ' sections)...');
    var audioPaths = [];
    var totalDuration = 0;
    for (var si = 0; si < script.sections.length; si++) {
      var ap = path.join(tmpDir, 'longaudio_' + videoId + '_' + si + '.mp3');
      await generateAudio(script.sections[si].narration, ap);
      var dur = await getAudioDuration(ap);
      totalDuration += dur;
      audioPaths.push(ap);
      console.log('[LongForm]   Section ' + (si + 1) + ': ' + dur.toFixed(1) + 's');
    }
    console.log('[LongForm] Total audio: ' + totalDuration.toFixed(1) + 's (' + (totalDuration / 60).toFixed(1) + ' min)');
    db.prepare("UPDATE videos SET duration_seconds=? WHERE id=?").run(totalDuration, videoId);

    // Step 3: Assemble video
    console.log('[LongForm] Assembling video...');
    var videoPath = path.join(tmpDir, 'longvideo_' + videoId + '.mp4');
    await assembleLongFormVideo(script.sections, audioPaths, videoPath);
    console.log('[LongForm] Video assembled: ' + videoPath);

    // Step 3.5: Burn subtitles for long-form
    var fullNarration = script.sections.map(function(sec) { return sec.narration; }).join(' ');
    var longSrt = generateSRT(fullNarration, totalDuration);
    if (longSrt) {
      var longSrtPath = path.join(tmpDir, 'longsubs_' + videoId + '.srt');
      fs.writeFileSync(longSrtPath, longSrt);
      var longSubbedPath = path.join(tmpDir, 'longsubbed_' + videoId + '.mp4');
      var longSubStyle = "FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=0,MarginV=60";
      var longSubCmd = ffmpegPath +
        ' -i "' + videoPath + '"' +
        " -vf \"subtitles='" + longSrtPath.replace(/'/g, "'\\''") + "':force_style='" + longSubStyle + "'\"" +
        ' -c:a copy -c:v libx264 -pix_fmt yuv420p -preset fast' +
        ' -y "' + longSubbedPath + '"';
      try {
        console.log('[LongForm] Burning subtitles...');
        execSync(longSubCmd, { stdio: 'pipe', timeout: 300000 });
        fs.unlinkSync(videoPath);
        fs.renameSync(longSubbedPath, videoPath);
        console.log('[LongForm] Subtitles burned in');
      } catch(subErr) {
        console.log('[LongForm] Subtitle burn failed (proceeding without):', (subErr.stderr || subErr.message).toString().slice(-200));
        try { fs.unlinkSync(longSubbedPath); } catch(e) {}
      }
      try { fs.unlinkSync(longSrtPath); } catch(e) {}
    }

    // Cleanup audio
    audioPaths.forEach(function(f) { try { fs.unlinkSync(f); } catch(e) {} });

    // Step 4: Upload
    if (!isYouTubeAuthorized()) {
      db.prepare("UPDATE videos SET status='ready', error='YouTube not authorized' WHERE id=?").run(videoId);
      return { id: videoId, status: 'ready', title: script.title };
    }

    db.prepare("UPDATE videos SET status='uploading' WHERE id=?").run(videoId);

    // Build chapter timestamps from stored section durations
    var chapters = '0:00 ' + script.sections[0].title + '\n';
    var elapsed = 0;
    for (var ci = 0; ci < script.sections.length; ci++) {
      var estDur = (script.sections[ci].narration || '').length / 14; // ~14 chars/sec for TTS
      if (ci > 0) {
        var mins = Math.floor(elapsed / 60);
        var secs = Math.floor(elapsed % 60);
        chapters += mins + ':' + (secs < 10 ? '0' : '') + secs + ' ' + script.sections[ci].title + '\n';
      }
      elapsed += estDur;
    }

    var desc = script.title + '\n\n' +
      'CHAPTERS:\n' + chapters + '\n' +
      'DISCLAIMER: This video is general information only and does not constitute migration advice. Always consult a registered migration agent before making decisions about your visa or migration pathway.\n\n' +
      'WIDEN Migration Experts\n' +
      'widen.com.au | 02 8188 1887\n' +
      'MARN 1576536\n' +
      'Office 6, 2-16 Anglo Road, Campsie NSW 2194\n\n' +
      '#migration #australia #visa #482visa #rpl #migrationagent #sydneymigration';

    var tags = ['migration australia', 'visa australia', '482 visa', 'rpl australia', 'migration agent sydney', 'australian visa', 'employer sponsorship', 'widen migration', topicInfo.category];
    var result = await uploadToYouTube(videoPath, script.title + ' | WIDEN Migration Experts', desc, tags, true);

    db.prepare("UPDATE videos SET youtube_id=?, youtube_url=?, status='published', published_at=CURRENT_TIMESTAMP WHERE id=?").run(result.id, result.url, videoId);
    console.log('[LongForm] Published: ' + result.url);

    // Upload thumbnail
    try {
      var thumb = generateThumbnail(script.title, null, true);
      await uploadThumbnail(result.id, thumb);
    } catch(e) { console.log('[LongForm] Thumbnail error:', e.message.slice(0, 100)); }

    try { fs.unlinkSync(videoPath); } catch(e) {}
    return { id: videoId, youtubeUrl: result.url, title: script.title };
  } catch(e) {
    db.prepare("UPDATE videos SET status='failed', error=? WHERE id=?").run(e.message, videoId);
    console.log('[LongForm] FAILED: ' + e.message);
    throw e;
  }
}

// ===== ADMIN AUTH =====
// Persist admin tokens in DB so they survive restarts (volume-backed)
db.exec("CREATE TABLE IF NOT EXISTS admin_tokens (token TEXT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
// Clean tokens older than 7 days on startup
try { db.exec("DELETE FROM admin_tokens WHERE created_at < datetime('now', '-7 days')"); } catch(e) {}

function requireAdmin(req, res, next) {
  var auth = req.headers.authorization || '';
  var token = auth.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  var row = db.prepare("SELECT token FROM admin_tokens WHERE token = ?").get(token);
  if (!row) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ===== API ROUTES =====
app.use(express.static('public'));
app.get('/', function(req, res) { res.redirect('/admin'); });
app.get('/api/health', function(req, res) { res.json({ status: 'ok', service: 'widen-youtube-shorts', youtube: isYouTubeAuthorized() }); });
app.use(express.json());

app.get('/admin', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

app.post('/api/admin/login', function(req, res) {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  var token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO admin_tokens (token) VALUES (?)").run(token);
  res.json({ token: token });
});

app.get('/api/videos', requireAdmin, function(req, res) {
  var videos = db.prepare("SELECT * FROM videos ORDER BY id DESC LIMIT 50").all();
  res.json({ videos: videos });
});

app.get('/api/status', requireAdmin, function(req, res) {
  var total = db.prepare("SELECT COUNT(*) as c FROM videos").get().c;
  var published = db.prepare("SELECT COUNT(*) as c FROM videos WHERE status='published'").get().c;
  var failed = db.prepare("SELECT COUNT(*) as c FROM videos WHERE status='failed'").get().c;
  var nextTopic = pickNextTopic();
  res.json({
    total: total,
    published: published,
    failed: failed,
    paused: schedulerPaused,
    youtubeAuthorized: isYouTubeAuthorized(),
    nextTopic: nextTopic
  });
});

app.post('/api/generate', requireAdmin, async function(req, res) {
  try {
    var result = await createAndPublishShort(req.body.topic || null);
    res.json({ success: true, result: result });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/preview', requireAdmin, async function(req, res) {
  try {
    var topicInfo = req.body.topic ? { category: 'custom', topic: req.body.topic } : pickNextTopic();
    var script = await generateScript(topicInfo);
    res.json({ success: true, script: script, topicInfo: topicInfo });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/pause', requireAdmin, function(req, res) {
  schedulerPaused = !schedulerPaused;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('paused', ?)").run(schedulerPaused ? '1' : '0');
  res.json({ paused: schedulerPaused });
});

app.post('/api/generate-long', requireAdmin, async function(req, res) {
  try {
    var result = await createAndPublishLongForm(req.body.topic || null);
    res.json({ success: true, result: result });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.delete('/api/videos/:id', requireAdmin, function(req, res) {
  db.prepare("DELETE FROM videos WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ===== SCHEDULER =====
function msUntilNext(targetDays) {
  var now = new Date();
  var sydneyNow = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  for (var daysAhead = 0; daysAhead < 8; daysAhead++) {
    var candidate = new Date(sydneyNow.getTime() + daysAhead * 86400000);
    candidate.setHours(10, 0, 0, 0);
    if (targetDays.indexOf(candidate.getDay()) !== -1 && candidate.getTime() > sydneyNow.getTime()) {
      var offset = sydneyNow.getTime() - now.getTime();
      return candidate.getTime() - sydneyNow.getTime();
    }
  }
  return 86400000;
}

function startScheduler() {
  // Shorts: Mon, Wed, Fri at 10am Sydney
  function scheduleNextShort() {
    var ms = msUntilNext([1, 3, 5]);
    var nextRun = new Date(Date.now() + ms);
    console.log('[Scheduler] Next short: ' + nextRun.toISOString() + ' (' + Math.round(ms / 3600000) + 'h)');
    setTimeout(async function() {
      if (schedulerPaused) { console.log('[Scheduler] Paused — skipping short.'); scheduleNextShort(); return; }
      console.log('[Scheduler] Running short at ' + new Date().toISOString());
      try {
        var result = await createAndPublishShort();
        console.log('[Scheduler] Short published: ' + (result.youtubeUrl || result.status));
      } catch(e) { console.error('[Scheduler] Short failed:', e.message); }
      scheduleNextShort();
    }, ms);
  }

  // Long-form: Saturday at 10am Sydney
  function scheduleNextLong() {
    var ms = msUntilNext([6]); // Saturday=6
    var nextRun = new Date(Date.now() + ms);
    console.log('[Scheduler] Next long-form: ' + nextRun.toISOString() + ' (' + Math.round(ms / 3600000) + 'h)');
    setTimeout(async function() {
      if (schedulerPaused) { console.log('[Scheduler] Paused — skipping long-form.'); scheduleNextLong(); return; }
      console.log('[Scheduler] Running long-form at ' + new Date().toISOString());
      try {
        var result = await createAndPublishLongForm();
        console.log('[Scheduler] Long-form published: ' + (result.youtubeUrl || result.status));
      } catch(e) { console.error('[Scheduler] Long-form failed:', e.message); }
      scheduleNextLong();
    }, ms);
  }

  scheduleNextShort();
  scheduleNextLong();
}

// ===== START =====
app.listen(PORT, function() {
  console.log('[WIDEN YouTube Shorts] Running on port ' + PORT);
  console.log('[WIDEN YouTube Shorts] YouTube authorized: ' + isYouTubeAuthorized());
  if (!process.env.GOOGLE_CREDENTIALS_JSON) {
    console.log('[WIDEN YouTube Shorts] WARNING: GOOGLE_CREDENTIALS_JSON not set. Visit /auth/youtube after setting it.');
  }
  console.log('[WIDEN YouTube Shorts] TTS: Google Cloud Text-to-Speech (' + (process.env.TTS_VOICE || 'en-AU-Neural2-B') + ')');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[WIDEN YouTube Shorts] WARNING: ANTHROPIC_API_KEY not set. Script generation will fail.');
  }
  startScheduler();
});
