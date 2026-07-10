/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @cerberus/shared é um pacote workspace em TypeScript compilado para dist/.
  transpilePackages: ['@cerberus/shared'],
  // O lint é feito pelo ESLint flat config no CI (npm run lint), não pelo next build.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
