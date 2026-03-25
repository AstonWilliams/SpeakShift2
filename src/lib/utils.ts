import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function extractYouTubeId(url: string): string | null {
    if (!url || typeof url !== "string") return null;

    // Common patterns — order matters somewhat (more specific first)
    const patterns = [
        // youtu.be short link
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/i,

        // Classic watch?v= (with or without www, https, extra params)
        /(?:youtube(?:-nocookie)?\.com\/watch(?:\.php)?\?.*?v=)([a-zA-Z0-9_-]{11})/i,

        // embed, v/, shorts/, live/, e/
        /(?:youtube(?:-nocookie)?\.com\/)(?:embed\/|v\/|shorts\/|live\/|e\/)([a-zA-Z0-9_-]{11})/i,

        // Rare /user/.../v/ style or other paths
        /(?:youtube(?:-nocookie)?\.com\/[^#?]*\/)([a-zA-Z0-9_-]{11})(?:[#?]|$)/i,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1].length === 11) {
            return match[1];
        }
    }

    return null;
}