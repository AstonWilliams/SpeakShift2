// src/lib/events.ts
type TranscriptionEvent = 'transcription-added';

type Listener = () => void;

const listeners = new Map<TranscriptionEvent, Set<Listener>>();

export function onTranscriptionAdded(callback: () => void) {
  const event: TranscriptionEvent = 'transcription-added';
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  listeners.get(event)!.add(callback);

  return () => {
    listeners.get(event)?.delete(callback);
  };
}

export function emitTranscriptionAdded() {
  const event: TranscriptionEvent = 'transcription-added';
  listeners.get(event)?.forEach(cb => cb());
}