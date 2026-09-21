/** @type {import('next').NextConfig} */
const nextConfig = {
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
