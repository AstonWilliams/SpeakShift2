"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Search, Sparkles, History, ArrowRight, Plus, Link } from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { listVoices, type VoiceRecord } from "@/lib/audioVoiceDb";
import { listTtsTasks, type TtsTaskRecord } from "@/lib/audioVoiceDb";
import VoiceCard from "@/components/VoiceCard";
import CreateVoiceModal from "@/components/CreateVoiceModal";
import { showToast } from "@/lib/toast";

const STYLE_TAGS = [
  "conversational",
  "narration",
  "social media",
  "entertainment",
  "advertisement",
  "educational",
] as const;

const LANGUAGES = ["all", "Chinese", "English", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"];

export default function VoicesPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [langFilter, setLangFilter] = useState("all");
  const [styleFilter, setStyleFilter] = useState<string>("all");
  const [modalOpen, setModalOpen] = useState(false);

  const [voices, setVoices] = useState<VoiceRecord[]>([]);
  const [tasks, setTasks] = useState<TtsTaskRecord[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});

  const loadData = useCallback(async () => {
    try {
      const [voiceList, taskList] = await Promise.all([
        listVoices(),
        listTtsTasks("voice_profile"),
      ]);

      const voiceListWithPlayablePreview = await Promise.all(
        voiceList.map(async voice => {
          if (!voice.previewPath) return voice;
          try {
            const served = await invoke<string>("serve_audio_file", { path: voice.previewPath });
            return { ...voice, previewPath: served };
          } catch {
            return { ...voice, previewPath: convertFileSrc(voice.previewPath) };
          }
        })
      );

      setVoices(voiceListWithPlayablePreview);
      setTasks(taskList);
    } catch (err) {
      console.error(err);
      showToast("Failed to load voices", "error");
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return voices.filter(v => {
      const matchQ = !q || 
        v.name.toLowerCase().includes(q) ||
        (v.description || "").toLowerCase().includes(q) ||
        v.tags.some(t => t.toLowerCase().includes(q));
      const matchLang = langFilter === "all" || v.language.toLowerCase() === langFilter;
      const matchStyle = styleFilter === "all" || v.tags.includes(styleFilter as any);
      return matchQ && matchLang && matchStyle;
    });
  }, [voices, query, langFilter, styleFilter]);

  const togglePreview = (voiceId: string, previewPath: string) => {
    if (playingId === voiceId) {
      audioRefs.current[voiceId]?.pause();
      setPlayingId(null);
      return;
    }

    // Pause others
    Object.values(audioRefs.current).forEach(a => a?.pause());

    const ref = audioRefs.current[voiceId];
    if (ref) {
      ref.play().catch(() => showToast("Cannot play preview", "error"));
      setPlayingId(voiceId);
    } else {
      const audio = new Audio(previewPath);
      audio.onended = () => setPlayingId(null);
      audio.play().catch(() => showToast("Cannot play preview", "error"));
      audioRefs.current[voiceId] = audio;
      setPlayingId(voiceId);
    }
  };

  return (
    <div className="min-h-screen bg-background px-6 py-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">My Voices</h1>
            <p className="mt-1.5 text-muted-foreground">
              Manage and preview your Qwen3-TTS voice clones
            </p>
          </div>
          <Button
            onClick={() => setModalOpen(true)}
            className="gap-2 bg-gradient-to-r from-emerald-600 via-purple-600 to-pink-600 text-white shadow-lg hover:opacity-90"
          >
            <Plus className="size-4" />
            Create Voice
          </Button>
        </div>

        {/* Filters */}
        <div className="mb-8 flex flex-wrap items-center gap-3">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, tag, description..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="pl-10 bg-card border-border/50"
            />
          </div>

          <Select value={langFilter} onValueChange={setLangFilter}>
            <SelectTrigger className="w-44 bg-card">
              <SelectValue placeholder="Language" />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map(l => (
                <SelectItem key={l} value={l.toLowerCase()}>
                  {l === "all" ? "All Languages" : l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex flex-wrap gap-2">
            <button
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
                styleFilter === "all"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted hover:bg-muted/80 text-muted-foreground"
              }`}
              onClick={() => setStyleFilter("all")}
            >
              All
            </button>
            {STYLE_TAGS.map(tag => (
              <button
                key={tag}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
                  styleFilter === tag
                    ? "bg-gradient-to-r from-emerald-500/20 to-purple-500/20 text-primary border border-primary/30 shadow-sm"
                    : "bg-muted hover:bg-muted/80 text-muted-foreground"
                }`}
                onClick={() => setStyleFilter(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-3xl border border-border/40 bg-card/30 p-16 text-center">
            <div className="mx-auto mb-6 flex size-20 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500/10 to-purple-500/10">
              <Sparkles className="size-10 text-muted-foreground/60" />
            </div>
            <h2 className="text-2xl font-semibold mb-3">No voices yet</h2>
            <p className="text-muted-foreground mb-6">
              Create your first voice profile using a reference clip
            </p>
            <Button
              onClick={() => setModalOpen(true)}
              className="bg-gradient-to-r from-emerald-600 via-purple-600 to-pink-600 text-white"
            >
              Create Voice Profile
            </Button>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map(voice => (
              <VoiceCard
                key={voice.id}
                voice={voice}
                isPlaying={playingId === voice.id}
                onTogglePlay={() => togglePreview(voice.id, voice.previewPath)}
                onUse={() => router.push(`/dubbings?voice=${voice.id}`)}
              />
            ))}
          </div>
        )}

        {/* Recent Tasks */}
        <div className="mt-12 rounded-2xl border border-border/40 bg-card/40 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-lg font-semibold">
              <History className="size-5 text-muted-foreground" />
              Recent Voice Tasks
            </h3>
            <span className="text-sm text-muted-foreground">{tasks.length}</span>
          </div>
          <div className="space-y-2">
            {tasks.slice(0, 6).map(task => (
              <Link
                key={task.id}
                href={`/voices/detail?id=${task.id}`}
                className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/30 px-4 py-3 hover:border-primary/30 hover:bg-muted/50 transition-colors"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{task.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {task.status} • {Math.round(task.progress)}%
                  </p>
                </div>
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
            ))}
            {tasks.length === 0 && (
              <div className="rounded-xl border border-border/50 bg-muted/20 p-4 text-center text-sm text-muted-foreground">
                No voice creation tasks yet
              </div>
            )}
          </div>
        </div>
      </div>

      <CreateVoiceModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onCreated={loadData}
      />
    </div>
  );
}
