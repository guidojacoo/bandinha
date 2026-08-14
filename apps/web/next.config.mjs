/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@h59/db", "@h59/scoring", "@h59/shared"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
