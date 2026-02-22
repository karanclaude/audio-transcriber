# Audio Transcriber

A web app for transcribing audio using OpenAI's Whisper API. Upload files or record from your microphone.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Add your API key:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set your `OPENAI_API_KEY`.

3. **Start the server:**
   ```bash
   npm run dev    # development (auto-reload)
   npm start      # production
   ```

4. Open `http://localhost:3000`

## Features

- Drag-and-drop or browse for audio files (MP3, WAV, M4A, WebM, MP4)
- Live microphone recording with waveform visualization
- Auto language detection or manual selection
- Optional context prompt for improved accuracy
- Copy transcription to clipboard
- Download as `.txt` or `.srt` (with timestamps)

## API

| Endpoint | Description |
|----------|-------------|
| `POST /api/transcribe` | Returns plain text transcription |
| `POST /api/transcribe-verbose` | Returns JSON with text, language, duration, and timestamped segments |

Both accept `multipart/form-data` with fields: `audio` (file), `language` (optional), `prompt` (optional).
