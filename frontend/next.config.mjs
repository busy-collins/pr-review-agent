/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static HTML export for S3 + CloudFront deployment per PLAN.md
  output: 'export',
  // S3 serves files at predictable paths; trailing slashes keep nested routes
  // working without a Lambda@Edge rewrite layer.
  trailingSlash: true,
  // next/image's loader requires a server; static export needs unoptimized
  // images served directly from /public.
  images: { unoptimized: true },
};

export default nextConfig;
