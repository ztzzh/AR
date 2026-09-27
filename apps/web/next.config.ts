import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "192.168.2.50",
    "*.loca.lt",
  ],
};

export default nextConfig;
