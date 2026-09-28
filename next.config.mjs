/** @type {import('next').NextConfig} */
const nextConfig = {
  // Hides the circular "N" badge Next.js overlays at the bottom-left of the
  // page under `npm run dev`. It is a dev-only tool, never part of the app's
  // own UI, and production (`npm run start`) does not show it anyway.
  devIndicators: false,

  // The uploaded CSV is posted to /api/run as multipart form data. The default
  // body-size cap for Server Actions does not apply to Route Handlers, but the
  // route enforces its own MAX_CSV_BYTES limit (see lib/config.js).
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },
  },
};

export default nextConfig;
