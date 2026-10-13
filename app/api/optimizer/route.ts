import { proxyOptimization } from "../../../lib/playground-proxy";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return proxyOptimization(request);
}
