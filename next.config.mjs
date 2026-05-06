/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["pg", "postgres", "pg-boss", "argon2", "sql.js"],
  },
  serverExternalPackages: [
    "pg",
    "postgres",
    "pg-boss",
    "argon2",
    "sql.js",
    "@opentelemetry/sdk-node",
    "@opentelemetry/instrumentation-http",
    "@opentelemetry/instrumentation-pg",
  ],
};
export default nextConfig;
