"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { invoke } from "@tauri-apps/api/tauri";
import {
  Clapperboard,
  Download,
  Pause,
  Play,
  Plus,
  MoreHorizontal,
  FileText,
  Trash2,
} from "lucide-react";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import CreateDubbingModal from "@/components/CreateDubbingModal";
import { listDubbings, deleteDubbing, type DubbingRecord } from "@/lib/dubbingDb";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export default function DubbingsPage() {
  const searchParams = useSearchParams();
  const [dubbings, setDubbings] = useState<(DubbingRecord & { previewUrl: string })[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});

  const initialVoiceId = searchParams.get("voice") || undefined;

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const dubList = await listDubbings();
      const enriched = await Promise.all(
        dubList.map(async (dub) => {
          let url = dub.outputPath;
          try {
            // Use serve_audio_file for better performance and seeking
            url = await invoke<string>("serve_audio_file", { path: dub.outputPath });
          } catch {
            // Fallback for files that might not be servable
            url = await invoke<string>("convert_file_src", { path: dub.outputPath });
          }
          return { ...dub, previewUrl: url };
        })
      );
      setDubbings(enriched.sort((a, b) => b.createdAtMs - a.createdAtMs));
    } catch (err) {
      console.error(err);
      showToast("Failed to load dubbings", "error", String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    // If a voice is pre-selected, open the modal automatically
    if (initialVoiceId) {
      setShowCreateModal(true);
    }
  }, [loadData, initialVoiceId]);

  const handleDelete = async (id: string) => {
    if (playingId === id) {
      audioRefs.current[id]?.pause();
      setPlayingId(null);
    }
    try {
      await deleteDubbing(id);
      showToast("Dubbing deleted", "success");
      loadData(); // Refresh list
    } catch (err) {
      console.error("Failed to delete dubbing:", err);
      showToast("Failed to delete dubbing", "error");
    }
  };

  const togglePlay = (id: string, url: string) => {
    if (playingId === id) {
      audioRefs.current[id]?.pause();
      setPlayingId(null);
      return;
    }

    // Pause any other playing audio
    Object.values(audioRefs.current).forEach((audio) => audio?.pause());

    const audio = audioRefs.current[id] || new Audio(url);
    if (!audioRefs.current[id]) {
      audioRefs.current[id] = audio;
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => {
        showToast("Playback failed. Audio file may be missing or corrupt.", "error");
        setPlayingId(null);
      };
    }
    
    audio.play().catch(err => {
        console.error("Playback error:", err);
        showToast("Playback failed.", "error");
    });
    setPlayingId(id);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-gray-200 px-6 py-8 lg:px-10">
      <CreateDubbingModal
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
        onCreated={loadData}
        initialVoiceId={initialVoiceId}
      />

      <div className="mx-auto max-w-7xl">
        <header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-50">Dubbings</h1>
            <p className="mt-1.5 text-gray-400">
              Translate and dub your content into any language with your own voice.
            </p>
          </div>
          <Button
            onClick={() => setShowCreateModal(true)}
            className="gap-2 bg-gradient-to-r from-cyan-500 to-teal-400 text-white font-bold shadow-[0_4px_14px_rgba(0,242,234,0.2)] hover:opacity-90 transition-opacity"
          >
            <Plus className="size-4" />
            New Dubbing
          </Button>
        </header>

        {isLoading ? (
          <div className="text-center py-20 text-gray-500">
            <p>Loading dubbings...</p>
          </div>
        ) : dubbings.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/20 bg-white/5 p-16 text-center flex flex-col items-center">
            <div className="mb-6 flex size-20 items-center justify-center rounded-full bg-gradient-to-br from-cyan-900/50 to-purple-900/50">
              <Clapperboard className="size-10 text-cyan-300/70" />
            </div>
            <h2 className="text-2xl font-semibold text-gray-100 mb-3">No Dubbings Yet</h2>
            <p className="text-gray-400 mb-6 max-w-sm">
              Create your first dubbed audio or video file by clicking the button below.
            </p>
            <Button
              onClick={() => setShowCreateModal(true)}
              className="gap-2 bg-gradient-to-r from-cyan-500 to-teal-400 text-white font-bold shadow-[0_4px_14px_rgba(0,242,234,0.2)] hover:opacity-90 transition-opacity"
            >
              Start New Dubbing
            </Button>
          </div>
        ) : (
          <motion.div
            className="space-y-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ staggerChildren: 0.05 }}
          >
            {dubbings.map((dub) => (
              <motion.div
                key={dub.id}
                layout
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.3, ease: "circOut" }}
                className={cn(
                  "group rounded-xl border border-white/10 bg-white/[.03] p-4 backdrop-blur-xl transition-all duration-300",
                  "hover:border-cyan-400/50 hover:bg-white/[.05]"
                )}
              >
                <div className="flex items-center gap-4">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-10 rounded-full hover:bg-cyan-400/10 text-cyan-400 shrink-0"
                    onClick={() => togglePlay(dub.id, dub.previewUrl)}
                  >
                    {playingId === dub.id ? (
                      <Pause className="size-5" />
                    ) : (
                      <Play className="size-5" />
                    )}
                  </Button>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate text-gray-100">{dub.title || "Untitled Dub"}</h3>
                    <p className="text-sm text-gray-400 mt-0.5">
                      {dub.lang.toUpperCase()} &bull; {new Date(dub.createdAtMs).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="icon" variant="ghost" className="text-gray-400 hover:text-white" asChild>
                      <a href={dub.previewUrl} download={`${dub.title || "dubbing"}.wav`}>
                        <Download className="size-4" />
                      </a>
                    </Button>
                    <Button size="icon" variant="ghost" className="text-gray-400 hover:text-white" asChild>
                      <Link href={`/dubbings/detail?id=${dub.id}`}>
                        <FileText className="size-4" />
                      </Link>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="text-gray-400 hover:text-white">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="bg-[#1a1a1e] border-white/20 text-gray-200">
                        <DropdownMenuItem
                          className="text-red-400 focus:bg-red-900/50 focus:text-red-300"
                          onSelect={() => handleDelete(dub.id)}
                        >
                          <Trash2 className="mr-2 size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <audio ref={(el) => { audioRefs.current[dub.id] = el; }} src={dub.previewUrl} className="hidden" />
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}