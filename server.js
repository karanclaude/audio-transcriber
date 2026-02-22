require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const OpenAI = require("openai");

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- History DB (JSON file, last 10 transcriptions) ---
const HISTORY_PATH = path.join(__dirname, "data", "history.json");

function loadHistory() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    if (fs.existsSync(HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
    }
  } catch {}
  return [];
}

function saveHistory(entries) {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries, null, 2));
}

function addToHistory(entry) {
  const history = loadHistory();
  history.unshift(entry);
  // Keep only last 10
  if (history.length > 10) history.length = 10;
  saveHistory(history);
  return history;
}

// --- GET /api/history ---
app.get("/api/history", (req, res) => {
  res.json(loadHistory());
});

// --- GET /api/history/:id/download ---
app.get("/api/history/:id/download", (req, res) => {
  const history = loadHistory();
  const entry = history.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found" });

  const filename = entry.filename || "transcription.txt";
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(entry.text);
});

// --- DELETE /api/history/:id ---
app.delete("/api/history/:id", (req, res) => {
  let history = loadHistory();
  history = history.filter((e) => e.id !== req.params.id);
  saveHistory(history);
  res.json({ ok: true });
});

const ALLOWED_MIMES = [
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/wave", "audio/x-wav",
  "audio/m4a", "audio/x-m4a", "audio/mp4", "audio/webm",
  "video/mp4", "video/webm",
];

const upload = multer({
  dest: path.join(__dirname, "tmp"),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Accepted: mp3, wav, m4a, webm, mp4.`));
    }
  },
});

// --- Helpers ---
function cleanup(...paths) {
  for (const p of paths) {
    if (p) fs.unlink(p, () => {});
  }
}

function cleanupDir(dirPath) {
  if (!dirPath) return;
  try {
    const files = fs.readdirSync(dirPath);
    for (const f of files) fs.unlinkSync(path.join(dirPath, f));
    fs.rmdirSync(dirPath);
  } catch {}
}

// --- Send a progress event as NDJSON line ---
function sendProgress(res, data) {
  res.write(JSON.stringify(data) + "\n");
}

// --- Get audio duration via ffprobe ---
async function getAudioDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_format", filePath,
  ]);
  const info = JSON.parse(stdout);
  return parseFloat(info.format.duration) || 0;
}

// --- Compress audio with progress callback ---
function compressAudio(inputPath, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + "_compressed.mp3";
    const args = [
      "-y", "-i", inputPath,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
      "-f", "mp3",
      outputPath,
    ];

    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Parse time= from ffmpeg output
      const match = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
      if (match && totalDuration > 0) {
        const last = match[match.length - 1];
        const m = last.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
          const pct = Math.min(99, Math.round((secs / totalDuration) * 100));
          onProgress(pct);
        }
      }
      // Keep stderr buffer from growing too large
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });

    proc.on("close", (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg compress exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

// --- Split audio into chunks with progress callback ---
function splitAudio(inputPath, totalDuration, onProgress, chunkSeconds = 600) {
  return new Promise((resolve, reject) => {
    const chunkDir = inputPath + "_chunks";
    fs.mkdirSync(chunkDir, { recursive: true });

    const args = [
      "-y", "-i", inputPath,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
      "-f", "segment",
      "-segment_time", String(chunkSeconds),
      "-reset_timestamps", "1",
      path.join(chunkDir, "chunk_%03d.mp3"),
    ];

    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
      if (match && totalDuration > 0) {
        const last = match[match.length - 1];
        const m = last.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
          const pct = Math.min(99, Math.round((secs / totalDuration) * 100));
          onProgress(pct);
        }
      }
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });

    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg split exited with code ${code}`));
      const files = fs.readdirSync(chunkDir)
        .filter((f) => f.startsWith("chunk_") && f.endsWith(".mp3"))
        .sort()
        .map((f) => path.join(chunkDir, f));
      resolve({ chunkDir, files });
    });
    proc.on("error", reject);
  });
}

// --- Transcribe a single file ---
async function transcribeFile(filePath, format, language, prompt) {
  const params = {
    model: "whisper-1",
    file: await OpenAI.toFile(fs.createReadStream(filePath), "audio.mp3"),
    response_format: format,
  };
  if (language) params.language = language;
  if (prompt) params.prompt = prompt;
  return openai.audio.transcriptions.create(params);
}

// --- Prepare audio: compress/split with streamed progress ---
async function prepareAudio(tmpPath, res) {
  const stat = fs.statSync(tmpPath);
  const sizeBytes = stat.size;
  const MAX = 24 * 1024 * 1024;

  if (sizeBytes <= MAX) {
    return { mode: "direct", files: [tmpPath], cleanup: [] };
  }

  // Get duration for progress calculation
  sendProgress(res, { phase: "analyzing", message: "Analyzing audio file..." });
  const duration = await getAudioDuration(tmpPath);
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(0);

  // Try compressing first
  sendProgress(res, { phase: "compressing", percent: 0, message: `Compressing ${sizeMB} MB file...` });

  let lastPct = -1;
  const compressed = await compressAudio(tmpPath, duration, (pct) => {
    if (pct !== lastPct) {
      lastPct = pct;
      sendProgress(res, { phase: "compressing", percent: pct, message: `Compressing audio... ${pct}%` });
    }
  });
  sendProgress(res, { phase: "compressing", percent: 100, message: "Compression complete" });

  const compressedSize = fs.statSync(compressed).size;
  if (compressedSize <= MAX) {
    return { mode: "compress", files: [compressed], cleanup: [compressed] };
  }

  // Still too big — split into chunks
  sendProgress(res, { phase: "splitting", percent: 0, message: "File still large, splitting into chunks..." });
  cleanup(compressed);

  lastPct = -1;
  const { chunkDir, files } = await splitAudio(tmpPath, duration, (pct) => {
    if (pct !== lastPct) {
      lastPct = pct;
      sendProgress(res, { phase: "splitting", percent: pct, message: `Splitting audio... ${pct}%` });
    }
  });
  sendProgress(res, { phase: "splitting", percent: 100, message: `Split into ${files.length} chunks` });

  return { mode: "chunk", files, chunkDir, cleanup: [] };
}

// --- POST /api/transcribe (streams NDJSON progress) ---
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided." });
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const tmpPath = req.file.path;
  const originalName = req.file.originalname || "recording";
  let prepared = null;

  try {
    prepared = await prepareAudio(tmpPath, res);
    const language = req.body.language || undefined;
    const prompt = req.body.prompt || undefined;
    const totalChunks = prepared.files.length;
    let finalText = "";

    if (totalChunks === 1) {
      sendProgress(res, { phase: "transcribing", percent: 0, message: "Sending to Whisper API...", chunk: 1, totalChunks: 1 });
      finalText = await transcribeFile(prepared.files[0], "text", language, prompt);
      sendProgress(res, { phase: "transcribing", percent: 100, message: "Done", chunk: 1, totalChunks: 1 });
    } else {
      const texts = [];
      let rollingPrompt = prompt || "";
      for (let i = 0; i < totalChunks; i++) {
        const pct = Math.round((i / totalChunks) * 100);
        sendProgress(res, { phase: "transcribing", percent: pct, message: `Transcribing chunk ${i + 1} of ${totalChunks}...`, chunk: i + 1, totalChunks });
        const text = await transcribeFile(prepared.files[i], "text", language, rollingPrompt || undefined);
        texts.push(text);
        const trimmed = String(text).trim();
        rollingPrompt = trimmed.slice(-200);
      }
      sendProgress(res, { phase: "transcribing", percent: 100, message: "All chunks transcribed" });
      finalText = texts.join(" ");
    }

    // Save to history
    const baseName = path.basename(originalName, path.extname(originalName));
    const historyEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      filename: baseName + ".txt",
      sourceFile: originalName,
      text: String(finalText),
      language: language || "auto",
      chunks: totalChunks,
      createdAt: new Date().toISOString(),
    };
    addToHistory(historyEntry);

    sendProgress(res, { phase: "done", result: { text: finalText, chunks: totalChunks, historyId: historyEntry.id } });
  } catch (err) {
    console.error("Transcription error:", err.message);
    sendProgress(res, { phase: "error", error: err.message || "Transcription failed." });
  } finally {
    res.end();
    cleanup(tmpPath, ...(prepared?.cleanup || []));
    if (prepared?.chunkDir) cleanupDir(prepared.chunkDir);
  }
});

// --- POST /api/transcribe-verbose (streams NDJSON progress) ---
app.post("/api/transcribe-verbose", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided." });
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const tmpPath = req.file.path;
  let prepared = null;

  try {
    prepared = await prepareAudio(tmpPath, res);
    const language = req.body.language || undefined;
    const prompt = req.body.prompt || undefined;
    const totalChunks = prepared.files.length;

    if (totalChunks === 1) {
      sendProgress(res, { phase: "transcribing", percent: 0, message: "Sending to Whisper API (verbose)...", chunk: 1, totalChunks: 1 });
      const result = await transcribeFile(prepared.files[0], "verbose_json", language, prompt);
      sendProgress(res, { phase: "transcribing", percent: 100 });
      sendProgress(res, {
        phase: "done",
        result: { text: result.text, language: result.language, duration: result.duration, segments: result.segments },
      });
    } else {
      const allSegments = [];
      const texts = [];
      let timeOffset = 0;
      let detectedLang = null;
      let totalDuration = 0;
      let rollingPrompt = prompt || "";

      for (let i = 0; i < totalChunks; i++) {
        const pct = Math.round((i / totalChunks) * 100);
        sendProgress(res, { phase: "transcribing", percent: pct, message: `Transcribing chunk ${i + 1} of ${totalChunks} (verbose)...`, chunk: i + 1, totalChunks });
        const result = await transcribeFile(prepared.files[i], "verbose_json", language, rollingPrompt || undefined);

        if (!detectedLang && result.language) detectedLang = result.language;
        const chunkDuration = result.duration || 0;

        if (result.segments) {
          for (const seg of result.segments) {
            allSegments.push({ ...seg, start: seg.start + timeOffset, end: seg.end + timeOffset });
          }
        }

        texts.push(result.text);
        timeOffset += chunkDuration;
        totalDuration += chunkDuration;
        const trimmed = String(result.text).trim();
        rollingPrompt = trimmed.slice(-200);
      }

      sendProgress(res, { phase: "transcribing", percent: 100 });
      sendProgress(res, {
        phase: "done",
        result: { text: texts.join(" "), language: detectedLang, duration: totalDuration, segments: allSegments, chunks: totalChunks },
      });
    }
  } catch (err) {
    console.error("Verbose transcription error:", err.message);
    sendProgress(res, { phase: "error", error: err.message || "Transcription failed." });
  } finally {
    res.end();
    cleanup(tmpPath, ...(prepared?.cleanup || []));
    if (prepared?.chunkDir) cleanupDir(prepared.chunkDir);
  }
});

// --- Multer error handler ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Maximum upload size is 1GB." });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Transcriber running at http://localhost:${PORT}`);
});
