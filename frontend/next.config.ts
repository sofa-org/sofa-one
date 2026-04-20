import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  // Tell Next.js the monorepo root so it doesn't warn about multiple lockfiles
  outputFileTracingRoot: path.join(__dirname, '..'),

  // Proxy API requests to the NestJS backend in dev
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/:path*`,
      },
    ];
  },
};

export default nextConfig;
