import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next 16 otherwise writes agent-instruction files into the project on `next dev`. Your repo,
  // your call: set it to true (or delete the line) if you want them.
  agentRules: false,
};

export default nextConfig;
