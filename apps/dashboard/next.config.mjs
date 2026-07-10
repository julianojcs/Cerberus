/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @cerberus/shared é um pacote workspace em TypeScript compilado para dist/.
  transpilePackages: ['@cerberus/shared'],
};

export default nextConfig;
