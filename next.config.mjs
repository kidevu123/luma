/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["pg", "postgres", "pg-boss", "argon2"],
  },
  serverExternalPackages: [
    "pg",
    "postgres",
    "pg-boss",
    "argon2",
    "@opentelemetry/sdk-node",
    "@opentelemetry/instrumentation-http",
    "@opentelemetry/instrumentation-pg",
  ],
};
export default nextConfig;
