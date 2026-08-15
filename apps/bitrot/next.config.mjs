/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // The generated Prisma client ships native query-engine binaries; keep them
  // external so Next traces them as files instead of trying to bundle them.
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default nextConfig;
