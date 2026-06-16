import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // The shared seam package ships raw TypeScript (exports ./src/index.ts); Next must transpile it.
  transpilePackages: ["@linear-agent/contract"],
};

export default withWorkflow(nextConfig);
