/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    // the app moved from /terminal to /app when the product became just "VIBA"
    return [{ source: "/terminal", destination: "/app", permanent: true }];
  },
};

module.exports = nextConfig;
