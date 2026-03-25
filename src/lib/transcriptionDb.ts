// src/lib/transcriptionDb.ts
import { appDataDir, join } from '@tauri-apps/api/path';
import Database from '@tauri-apps/plugin-sql';

// ──────────────────────────────────────────────────────────────
// Interfaces (exported)
// ──────────────────────────────────────────────────────────────

export interface Transcription {
  id: string;
  createdAt: Date;
  updatedAt?: Date;

  filename: string;
  title?: string;
  extension?: string;           // e.g. ".mp3", ".webm" (optional, can be inferred from audioPath or sourceUrl)
  sourceType: "file" | "youtube" | "recording";
  sourceUrl?: string;
  duration?: number;
  audioPath?: string;

  fullText: string;                // concatenated clean text
  detectedLanguage?: string;

  whisperModel?: string;
  whisperTimestamp?: string;
  diarizationModel?: string;
  diarizationTimestamp?: string;
}

export interface AsrSegment {
  id?: number;                     // auto-increment PK
  transcriptionId: string;
  start: number;                   // seconds
  end: number;
  text: string;
  // Optional: if you later get word-level from whisperX etc.
  words?: Array<{ word: string; start?: number; end?: number; prob?: number }>;
}

export interface SpeakerTurn {
  id?: number;
  transcriptionId: string;
  start: number;
  end: number;
  clusterId: string;               // raw: "SPEAKER_00", "SPEAKER_01", …
  displayName?: string;            // user-renamed: "Alice", "Moderator", …
  confidence?: number;
  // model used (useful when comparing / re-running)
  diarizationModel?: string;
}

export interface TranslationEntry {
  id?: number;
  transcriptionId: string;
  targetLanguage: string;          // "ur", "es", "fr", …
  translatedText: string;
  translatorModel?: string;        // e.g. "nllb-200", " Helsinki-NLP", …
  createdAt: Date;
}

// ──────────────────────────────────────────────────────────────
// Singleton + schema setup
// ──────────────────────────────────────────────────────────────

let dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (dbPromise) return dbPromise;

  try {
    const appDataPath = await appDataDir();
    const dbPath = await join(appDataPath, 'speakShift-transcriptions.db');

    console.log("[DB] Loading database:", dbPath);

    dbPromise = Database.load(`sqlite:${dbPath}`);
    const db = await dbPromise;

    console.log("[DB] Connection successful");

    // ──────────────────────────────────────────────────────────────
    // Schema
    // ──────────────────────────────────────────────────────────────

    await db.execute(`
      CREATE TABLE IF NOT EXISTS transcriptions (
        id                    TEXT PRIMARY KEY,
        created_at            TEXT NOT NULL,
        updated_at            TEXT,

        filename              TEXT NOT NULL,
        title                 TEXT,
        source_type           TEXT NOT NULL,
        source_url            TEXT,
        duration              REAL,
        audio_path            TEXT,

        full_text             TEXT NOT NULL,
        detected_language     TEXT,

        whisper_model         TEXT,
        whisper_timestamp     TEXT,
        diarization_model     TEXT,
        diarization_timestamp TEXT
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS asr_segments (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        transcription_id  TEXT NOT NULL,
        start_sec         REAL NOT NULL,
        end_sec           REAL NOT NULL,
        text              TEXT NOT NULL,
        words             TEXT,                    -- JSON if word-level
        FOREIGN KEY (transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS speaker_turns (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        transcription_id    TEXT NOT NULL,
        start_sec           REAL NOT NULL,
        end_sec             REAL NOT NULL,
        cluster_id          TEXT NOT NULL,
        display_name        TEXT,
        confidence          REAL,
        diarization_model   TEXT,
        FOREIGN KEY (transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS translations (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        transcription_id    TEXT NOT NULL,
        target_language     TEXT NOT NULL,
        translated_text     TEXT NOT NULL,
        translator_model    TEXT,
        created_at          TEXT NOT NULL,
        UNIQUE(transcription_id, target_language),
        FOREIGN KEY (transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE
      );
    `);

    // Indexes
    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_trans_created ON transcriptions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_asr_trans ON asr_segments(transcription_id, start_sec);
      CREATE INDEX IF NOT EXISTS idx_speaker_trans ON speaker_turns(transcription_id, start_sec);
      CREATE INDEX IF NOT EXISTS idx_translations_trans ON translations(transcription_id);
    `);

    console.log("[DB] Schema ready");
    return db;
  } catch (err) {
    console.error("[DB] Initialization failed:", err);
    dbPromise = null;
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────
// CRUD Operations
// ──────────────────────────────────────────────────────────────

export async function saveTranscription(
  data: Omit<Transcription, "id" | "createdAt"> & { segments: AsrSegment[] }
): Promise<Transcription> {
  const db = await getDb();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.execute(
    `INSERT INTO transcriptions (
      id, created_at, filename, title, source_type, source_url, duration, audio_path,
      full_text, detected_language, whisper_model, whisper_timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      now,
      data.filename,
      data.title ?? null,
      data.sourceType,
      data.sourceUrl ?? null,
      data.duration ?? null,
      data.audioPath ?? null,
      data.fullText,
      data.detectedLanguage ?? null,
      data.whisperModel ?? null,
      data.whisperTimestamp ?? now,
    ]
  );

  // Save ASR segments
  if (data.segments?.length) {
    for (const seg of data.segments) {
      await db.execute(
        `INSERT INTO asr_segments (transcription_id, start_sec, end_sec, text, words)
         VALUES (?, ?, ?, ?, ?)`,
        [
          id,
          seg.start,
          seg.end,
          seg.text,
          seg.words ? JSON.stringify(seg.words) : null,
        ]
      );
    }
  }

  return {
    ...data,
    id,
    createdAt: new Date(now),
  };
}

export async function getTranscription(id: string): Promise<Transcription | undefined> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    'SELECT * FROM transcriptions WHERE id = ?',
    [id]
  );

  if (!rows.length) return undefined;
  const row = rows[0];

  return {
    id: row.id,
    createdAt: new Date(row.created_at),
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
    filename: row.filename,
    title: row.title ?? undefined,
    sourceType: row.source_type,
    sourceUrl: row.source_url ?? undefined,
    duration: row.duration ?? undefined,
    audioPath: row.audio_path ?? undefined,
    fullText: row.full_text,
    detectedLanguage: row.detected_language ?? undefined,
    whisperModel: row.whisper_model ?? undefined,
    whisperTimestamp: row.whisper_timestamp ?? undefined,
    diarizationModel: row.diarization_model ?? undefined,
    diarizationTimestamp: row.diarization_timestamp ?? undefined,
  };
}

export async function getAsrSegments(transcriptionId: string): Promise<AsrSegment[]> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    'SELECT * FROM asr_segments WHERE transcription_id = ? ORDER BY start_sec',
    [transcriptionId]
  );

  return rows.map(r => ({
    id: r.id,
    transcriptionId: r.transcription_id,
    start: r.start_sec,
    end: r.end_sec,
    text: r.text,
    words: r.words ? JSON.parse(r.words) : undefined,
  }));
}

export async function replaceAsrSegments(
  transcriptionId: string,
  segments: Omit<AsrSegment, "id" | "transcriptionId">[]
): Promise<void> {
  const db = await getDb();

  await db.execute(
    "DELETE FROM asr_segments WHERE transcription_id = ?",
    [transcriptionId]
  );

  if (segments.length === 0) {
    return;
  }

  for (const seg of segments) {
    await db.execute(
      `INSERT INTO asr_segments (transcription_id, start_sec, end_sec, text, words)
       VALUES (?, ?, ?, ?, ?)`,
      [
        transcriptionId,
        seg.start,
        seg.end,
        seg.text,
        seg.words ? JSON.stringify(seg.words) : null,
      ]
    );
  }
}

export async function saveSpeakerTurns(
  transcriptionId: string,
  turns: Omit<SpeakerTurn, "id" | "transcriptionId">[],
  diarizationModel?: string
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  // Step 1: Clear old speaker turns for this transcription
  await db.execute(
    "DELETE FROM speaker_turns WHERE transcription_id = ?",
    [transcriptionId]
  );

  // Step 2: Insert all new ones
  if (turns.length > 0) {
    for (const t of turns) {
      await db.execute(
        `INSERT INTO speaker_turns (
          transcription_id, start_sec, end_sec, cluster_id, display_name, confidence, diarization_model
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          transcriptionId,
          t.start,
          t.end,
          t.clusterId,
          t.displayName ?? null,           // ← this is what saves renamed names
          t.confidence ?? null,
          diarizationModel ?? t.diarizationModel ?? null,
        ]
      );
    }
  }

  // Step 3: Update header
  await db.execute(
    `UPDATE transcriptions SET 
       diarization_model = ?, 
       diarization_timestamp = ?, 
       updated_at = ? 
     WHERE id = ?`,
    [diarizationModel ?? null, now, now, transcriptionId]
  );
}

export async function getSpeakerTurns(transcriptionId: string): Promise<SpeakerTurn[]> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    'SELECT * FROM speaker_turns WHERE transcription_id = ? ORDER BY start_sec',
    [transcriptionId]
  );

  return rows.map(r => ({
    id: r.id,
    transcriptionId: r.transcription_id,
    start: r.start_sec,
    end: r.end_sec,
    clusterId: r.cluster_id,
    displayName: r.display_name ?? undefined,
    confidence: r.confidence ?? undefined,
    diarizationModel: r.diarization_model ?? undefined,
  }));
}

export async function saveTranslation(
  transcriptionId: string,
  targetLanguage: string,
  translatedText: string,
  translatorModel?: string
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.execute(
    `INSERT OR REPLACE INTO translations (
      transcription_id, target_language, translated_text, translator_model, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
    [transcriptionId, targetLanguage, translatedText, translatorModel ?? null, now]
  );
}

export async function getTranslation(
  transcriptionId: string,
  targetLanguage: string
): Promise<TranslationEntry | undefined> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    'SELECT * FROM translations WHERE transcription_id = ? AND target_language = ?',
    [transcriptionId, targetLanguage]
  );

  if (!rows.length) return undefined;
  const r = rows[0];

  return {
    id: r.id,
    transcriptionId: r.transcription_id,
    targetLanguage: r.target_language,
    translatedText: r.translated_text,
    translatorModel: r.translator_model ?? undefined,
    createdAt: new Date(r.created_at),
  };
}

export async function listTranscriptions(): Promise<Transcription[]> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    'SELECT * FROM transcriptions ORDER BY created_at DESC'
  );

  return rows.map(r => ({
    id: r.id,
    createdAt: new Date(r.created_at),
    updatedAt: r.updated_at ? new Date(r.updated_at) : undefined,
    filename: r.filename,
    title: r.title ?? undefined,
    sourceType: r.source_type,
    sourceUrl: r.source_url ?? undefined,
    duration: r.duration ?? undefined,
    audioPath: r.audio_path ?? undefined,
    fullText: r.full_text,
    detectedLanguage: r.detected_language ?? undefined,
    whisperModel: r.whisper_model ?? undefined,
    whisperTimestamp: r.whisper_timestamp ?? undefined,
    diarizationModel: r.diarization_model ?? undefined,
    diarizationTimestamp: r.diarization_timestamp ?? undefined,
  }));
}

export async function deleteTranscription(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute('DELETE FROM transcriptions WHERE id = ?', [id]);
  return result.rowsAffected > 0;
  // cascades to asr_segments, speaker_turns, translations
}

/**
 * Update selected fields of an existing transcription
 * @param id - transcription ID
 * @param updates - fields to update (only the ones you allow)
 */
export async function updateTranscription(
  id: string,
  updates: Partial<Pick<Transcription,
    | "title"
    | "fullText"               // ← renamed from text
    | "detectedLanguage"
    | "whisperModel"
    | "whisperTimestamp"
    | "diarizationModel"
    | "diarizationTimestamp"
  >>
): Promise<Transcription | undefined> {
  const db = await getDb();

  const current = await getTranscription(id);
  if (!current) {
    console.warn(`Cannot update: transcription ${id} not found`);
    return undefined;
  }

  const fields: string[] = [];
  const values: any[] = [];

  if ("title" in updates) {
    fields.push("title = ?");
    values.push(updates.title ?? null);
  }
  if ("fullText" in updates) {
    fields.push("full_text = ?");
    values.push(updates.fullText ?? null);
  }
  if ("detectedLanguage" in updates) {
    fields.push("detected_language = ?");
    values.push(updates.detectedLanguage ?? null);
  }
  if ("whisperModel" in updates) {
    fields.push("whisper_model = ?");
    values.push(updates.whisperModel ?? null);
  }
  if ("whisperTimestamp" in updates) {
    fields.push("whisper_timestamp = ?");
    values.push(updates.whisperTimestamp ?? null);
  }
  if ("diarizationModel" in updates) {
    fields.push("diarization_model = ?");
    values.push(updates.diarizationModel ?? null);
  }
  if ("diarizationTimestamp" in updates) {
    fields.push("diarization_timestamp = ?");
    values.push(updates.diarizationTimestamp ?? null);
  }

  if (fields.length === 0) {
    console.log(`No fields to update for transcription ${id}`);
    return current;
  }

  const setClause = fields.join(", ");

  await db.execute(
    `UPDATE transcriptions SET ${setClause}, updated_at = ? WHERE id = ?`,
    [...values, new Date().toISOString(), id]
  );

  // Return refreshed object
  return await getTranscription(id);
}
// ──────────────────────────────────────────────────────────────
// Date formatting & grouping (unchanged)
// ──────────────────────────────────────────────────────────────

export function formatTranscriptionDate(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const transcriptionDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (transcriptionDate.getTime() === today.getTime()) return "Today";
  if (transcriptionDate.getTime() === yesterday.getTime()) return "Yesterday";
  if (now.getTime() - date.getTime() < 7 * 86400000) return "Previous 7 days";
  if (now.getTime() - date.getTime() < 30 * 86400000) return "Previous 30 days";
  return "Older";
}

export function groupTranscriptionsByDate(transcriptions: Transcription[]): Record<string, Transcription[]> {
  const groups: Record<string, Transcription[]> = {};

  transcriptions.forEach((t) => {
    const group = formatTranscriptionDate(t.createdAt);
    groups[group] = groups[group] || [];
    groups[group].push(t);
  });

  return groups;
}