"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";

interface TutorialCardProps {
    id: string;                      // unique key per card, e.g. "transcribe-welcome-1"
    title: string;
    description: string;
    imageSrc: string;                // path to image (public/ or /images/...)
    buttonText?: string;             // default: "Next"
    onFinish?: () => void;           // optional callback when closed
}

export default function TutorialCard({
    id,
    title,
    description,
    imageSrc,
    buttonText = "Next",
    onFinish,
}: TutorialCardProps) {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        // Only show if user hasn't seen this specific card before
        const seenKey = `tutorial_seen_${id}`;
        const seen = localStorage.getItem(seenKey);
        if (!seen) {
            setIsVisible(true);
        }
    }, [id]);

    const handleClose = () => {
        const seenKey = `tutorial_seen_${id}`;
        localStorage.setItem(seenKey, "true");
        setIsVisible(false);
        if (onFinish) onFinish();
    };

    if (!isVisible) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0, scale: 0.92, y: 30 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.92, y: 30 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
            >
                <div className="relative w-full max-w-4xl bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col md:flex-row">
                    {/* Left side – text */}
                    <div className="flex-1 p-10 md:p-14 flex flex-col justify-between">
                        <div>
                            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-5 leading-tight">
                                {title}
                            </h2>
                            <p className="text-lg md:text-xl text-gray-600 leading-relaxed">
                                {description}
                            </p>
                        </div>

                        {/* Buttons */}
                        <div className="mt-10 flex items-center gap-4">
                            <button
                                onClick={handleClose}
                                className="px-8 py-4 bg-[#d30094] hover:bg-[#000000] text-white font-medium rounded-2xl text-lg transition-all shadow-md"              >
                                {buttonText}
                            </button>

                            <button
                                onClick={handleClose}
                                className="text-gray-500 hover:text-gray-700 font-medium transition-colors"
                            >
                                Skip
                            </button>
                        </div>
                    </div>

                    {/* Right side – image */}
                    <div className="flex-1 bg-gradient-to-br from-blue-50 to-indigo-50 p-8 md:p-12 flex items-center justify-center">
                        <img
                            src={imageSrc}
                            alt={title}
                            className="w-full max-h-[500px] object-contain rounded-2xl shadow-lg"
                        />
                    </div>

                    {/* Close button */}
                    <button
                        onClick={handleClose}
                        className="absolute top-5 right-5 p-3 rounded-full bg-white/80 hover:bg-white text-gray-600 hover:text-gray-900 transition-colors shadow-md"
                    >
                        <X size={24} />
                    </button>
                </div>
            </motion.div>
        </AnimatePresence>
    );
}