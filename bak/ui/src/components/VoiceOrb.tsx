// components/VoiceOrb.tsx
"use client";

import { cn } from "@/lib/utils";

interface VoiceOrbProps {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function VoiceOrb({ name, size = "md", className }: VoiceOrbProps) {
  const sizeMap = {
    sm: "size-10",
    md: "size-14",
    lg: "size-20",
  };

  return (
    <div
      className={cn(
        "relative rounded-full overflow-hidden border-2 border-border/30 shadow-md shrink-0",
        sizeMap[size],
        className
      )}
    >
      <div className="orb absolute inset-0 opacity-80" />
      <div className="absolute inset-1.5 rounded-full bg-background/75 flex items-center justify-center text-sm font-bold text-muted-foreground/70 tracking-wider">
        {name.slice(0, 2).toUpperCase()}
      </div>
    </div>
  );
}