# CLAUDE.md — Audio Transcriber App

## Project Overview

A Node.js web application for audio transcription using OpenAI's Whisper API. Single-page frontend with drag-and-drop upload, live microphone recording, and transcription export.

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JS (single file, no framework)
- **File uploads:** Multer (25MB limit, stored in `/tmp`, cleaned up after processing)
- **API:** OpenAI SDK (`@openai/openai`) — model `whisper-1`
- **Environment:** dotenv (`.env` file with `OPENAI_API_KEY`)

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Dev server with nodemon (auto-reload)
npm start            # Production server
```

Server runs on `http://localhost:3000` (or `PORT` env var).

## Project Structure

```
transcriber/
├── server.js            # Express server with API routes
├── public/
│   └── index.html       # Complete frontend (HTML + CSS + JS inline)
├── tmp/                 # Temporary upload storage (auto-cleaned)
├── package.json
├── .env                 # OPENAI_API_KEY (not committed)
├── .env.example         # Template for .env
├── .gitignore
└── README.md
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serve frontend |
| POST | `/api/transcribe` | Basic transcription (returns plain text) |
| POST | `/api/transcribe-verbose` | Verbose transcription with timestamps (returns JSON with segments) |

Both POST endpoints accept `multipart/form-data` with:
- `audio` (file, required) — mp3, wav, m4a, webm, mp4
- `language` (string, optional) — ISO 639-1 code (e.g., `en`, `es`)
- `prompt` (string, optional) — context hint for better accuracy

## Key Design Decisions

- **No database** — stateless, no user accounts
- **Temp file cleanup** — uploaded files are deleted immediately after OpenAI processes them
- **CORS enabled** — allows cross-origin requests
- **Dark theme UI** — single-page responsive design
- **MediaRecorder API** — browser-native recording, outputs webm/opus
- **Export formats** — `.txt` (plain text) and `.srt` (subtitles with timestamps, requires verbose endpoint)

## Conventions

- All frontend code lives in `public/index.html` (inline CSS and JS)
- Error responses use `{ error: "message" }` JSON format
- File validation happens both client-side and server-side
- Max file size: 25MB (OpenAI's hard limit for Whisper)
