/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ["@prisma/client", ".prisma/client", "imapflow", "nodemailer", "mailparser"],
};
export default nextConfig;
