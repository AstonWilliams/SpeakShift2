// src/hooks/useTranscriptionListener.ts
'use client';

import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { saveTranscription } from '@/lib/transcriptionDb';
import { showToast } from '@/lib/toast';
import { emitTranscriptionAdded } from '@/lib/events';
import { extractYouTubeId } from '@/lib/utils'; // ← import if you have it, otherwise inline

export function useTranscriptionCompletedListener() {
  const hasListener = useRef(false);

  useEffect(() => {
    if (hasListener.current) return;
    hasListener.current = true;

    console.log("[GLOBAL] Setting up SINGLE transcription-completed listener");

    const setup = async () => {
      const unlisten = await listen("transcription-completed", async (event) => {
        const payload = event.payload as any;

        if (payload.error) {
          console.error("Transcription error:", payload.error);
          showToast(`Transcription failed: ${payload.error}`, "error");
          return;
        }

        try {
          // Build data matching the NEW saveTranscription signature
          const transcriptionData = {
            filename: payload.filename || payload.sourceUrl
              ? extractYouTubeId(payload.sourceUrl) || "youtube-audio"
              : `Untitled ${new Date().toLocaleString()}`,
            extension: payload.extension || ".webm",
            sourceType: payload.sourceType || "file",
            sourceUrl: payload.sourceUrl,
            duration: payload.duration,
            audioPath: payload.audio_path || payload.audioPath,
            fullText: (payload.full_text || payload.fullText || "").trim(),
            detectedLanguage: payload.detected_language || payload.language || undefined,
            whisperModel: payload.model || "unknown",
            whisperTimestamp: new Date().toISOString(),

            // Map to AsrSegment[] (no speaker field here – speakers come later via diarization)
            segments: (payload.segments || []).map((s: any) => ({
              start: (s.start_ms || s.start || 0) / 1000,
              end: (s.end_ms || s.end || 0) / 1000,
              text: (s.text || "").trim(),
              // words: s.words ? ... (optional – add later if you have word-level)
            })),
          };

          console.log("[GLOBAL] Saving transcription from event:", transcriptionData.filename);

          const saved = await saveTranscription(transcriptionData);
          emitTranscriptionAdded();

          showToast("Transcription completed and saved!", "success");
        } catch (err) {
          console.error("Failed to save transcription from event:", err);
          showToast("Failed to save transcription", "error");
        }
      });

      return unlisten;
    };

    let cleanup: (() => void) | null = null;

    setup().then((unlisten) => {
      cleanup = unlisten;
    }).catch((err) => {
      console.error("Failed to set up listener:", err);
    });

    return () => {
      console.log("[GLOBAL] Cleaning up transcription listener");
      if (cleanup) cleanup();
      hasListener.current = false;
    };
  }, []);
}