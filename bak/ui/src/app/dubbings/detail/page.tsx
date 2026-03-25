"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Download, Loader2, Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getDubbing } from "@/lib/audioVoiceDb";
import { showToast } from "@/lib/toast";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

function DetailContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [dubbing, setDubbing] = useState<any>(null);
  const [audioUrl, setAudioUrl] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);

  const outputFileName = useMemo(() => {
    if (!dubbing?.outputPath) return "dubbed_output.wav";
    return dubbing.outputPath.split(/[\\/]/).pop() || "dubbed_output.wav";
  }, [dubbing]);

  useEffect(() => {
    if (!id) return;

    const loadDubbing = async () => {
      setIsLoading(true);
      try {
        const item = await getDubbing(id);
        if (!item) {
          showToast("Dubbing not found", "error");
          return;
        }

        setDubbing(item);

        // Try to get a served URL (better playback), fallback to local file
        try {
          const servedUrl = await invoke<string>("serve_audio_file", {
            path: item.outputPath,
          });
          setAudioUrl(servedUrl);
        } catch {
          setAudioUrl(convertFileSrc(item.outputPath));
        }
      } catch (err) {
        console.error(err);
        showToast("Failed to load dubbing", "error");
      } finally {
        setIsLoading(false);
      }
    };

    loadDubbing();
  }, [id]);

  const togglePlayback = () => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => {
        showToast("Playback failed – file may be missing or corrupted", "error");
      });
    }

    setIsPlaying(!isPlaying);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span>Loading dubbing...</span>
        </div>
      </div>
    );
  }

  if (!dubbing) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-center">
        <h1 className="text-2xl font-semibold mb-4">Dubbing not found</h1>
        <p className="text-muted-foreground mb-8 max-w-md">
          The requested dubbing could not be loaded or does not exist.
        </p>
        <Button asChild variant="outline">
          <Link href="/dubbings">Back to Dubbings</Link>
        </Button>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="min-h-screen bg-background px-6 py-10 lg:px-12"
    >
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-10 flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/dubbings">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {dubbing.title || "Untitled Dubbing"}
            </h1>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-sm text-muted-foreground uppercase tracking-wide">
                {dubbing.lang}
              </span>
              <span className="text-sm text-muted-foreground">
                • {new Date(dubbing.createdAtMs).toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Main content card */}
        <div className="rounded-2xl border border-border/50 bg-card/60 p-7 mb-10">
          <div className="grid gap-8 md:grid-cols-2">
            {/* Left: Info */}
            <div className="space-y-6">
              <div className="rounded-xl border border-border/40 bg-muted/30 p-5">
                <h3 className="text-lg font-semibold mb-3">Dubbing Details</h3>
                <dl className="space-y-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground mb-1">Target Language</dt>
                    <dd className="font-medium">{dubbing.lang.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground mb-1">Voice Prompt File</dt>
                    <dd className="font-mono break-all text-xs">
                      {dubbing.promptPath.split(/[\\/]/).pop() || dubbing.promptPath}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground mb-1">Output File</dt>
                    <dd className="font-mono break-all text-xs">{outputFileName}</dd>
                  </div>
                </dl>
              </div>
            </div>

            {/* Right: Audio player */}
            <div className="flex flex-col justify-center items-center">
              {audioUrl ? (
                <div className="w-full max-w-md">
                  <div className="rounded-xl overflow-hidden border border-border/50 bg-black/40 p-4 mb-4">
                    <audio
                      ref={audioRef}
                      src={audioUrl}
                      controls
                      className="w-full"
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                      onEnded={() => setIsPlaying(false)}
                    />
                  </div>

                  <div className="flex justify-center gap-4">
                    <Button
                      variant="outline"
                      size="lg"
                      className="gap-2"
                      onClick={togglePlayback}
                    >
                      {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
                      {isPlaying ? "Pause" : "Play"}
                    </Button>

                    <Button variant="outline" size="lg" asChild>
                      <a href={audioUrl} download={outputFileName}>
                        <Download className="size-4 mr-2" />
                        Download
                      </a>
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-center text-muted-foreground py-12">
                  <p className="text-lg mb-2">Audio preview not available</p>
                  <p className="text-sm">The output file may still be processing or inaccessible.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default function DubbingDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span>Loading dubbing details...</span>
          </div>
        </div>
      }
    >
      <DetailContent />
    </Suspense>
  );
}