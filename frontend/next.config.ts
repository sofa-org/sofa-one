import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
