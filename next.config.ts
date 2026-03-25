import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

export default function nextConfig(phase: string): NextConfig {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;

  return {
    // Disable Turbopack (Webpack is needed for @ffmpeg/ffmpeg dynamic imports)
    experimental: {},

    // Static export should only be enabled for production builds.
    ...(isDev ? {} : { output: 'export' }),

    images: {
      remotePatterns: [
        { protocol: 'https', hostname: '**' },
        { protocol: 'http', hostname: '**' },
      ],
      unoptimized: true,
    },

    typescript: {
      ignoreBuildErrors: true,
    },

    transpilePackages: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],

    ...(isDev
      ? {
          async headers() {
            return [
              {
                source: '/(.*)',
                headers: [
                  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
                  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
                ],
              },
            ];
          },
        }
      : {}),

    webpack: (config) => {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
      return config;
    },
  };
}