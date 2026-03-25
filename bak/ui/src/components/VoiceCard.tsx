"use client";

import { Play, Pause, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { VoiceOrb } from "./VoiceOrb";
import type { VoiceRecord } from "@/lib/audioVoiceDb"; // ← use the unified db file

interface VoiceCardProps {
  voice: VoiceRecord;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onUse?: () => void;
}

export default function VoiceCard({
  voice,
  isPlaying,
  onTogglePlay,
  onUse,
}: VoiceCardProps) {
  return (
    <div
      className={cn(
        "group relative rounded-2xl border border-border/50 bg-card/60 p-6 transition-all duration-300",
        "hover:border-primary/40 hover:bg-card/80 hover:shadow-[0_10px_30px_-10px_rgba(34,197,94,0.15)]",
        "glow-hover"
      )}
    >
      <div className="flex items-start gap-5">
        <VoiceOrb name={voice.name} size="lg" className="shrink-0" />

        <div className="flex-1 min-w-0 space-y-2">
          <h3 className="font-semibold text-lg tracking-tight leading-tight">
            {voice.name}
          </h3>

          <p className="text-sm text-muted-foreground line-clamp-2">
            {voice.description || "No description provided"}
          </p>

          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge variant="outline" className="text-xs px-2.5 py-0.5">
              {voice.language}
            </Badge>

            {voice.accent && (
              <Badge variant="outline" className="text-xs px-2.5 py-0.5">
                {voice.accent}
              </Badge>
            )}

            {voice.tags.slice(0, 3).map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="text-xs px-2.5 py-0.5 bg-muted/50"
              >
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button
          size="icon"
          variant="ghost"
          className="size-10 rounded-full hover:bg-primary/10"
          onClick={onTogglePlay}
        >
          {isPlaying ? (
            <Pause className="size-5" />
          ) : (
            <Play className="size-5" />
          )}
        </Button>

        {onUse && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 border-primary/30 text-primary hover:bg-primary/5 hover:border-primary/50 transition-colors"
            onClick={onUse}
          >
            Use this voice
            <ArrowRight className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}