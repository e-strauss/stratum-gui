import Link from "next/link";
import { readRun, runsDirectory } from "../../../lib/runs";
import Inspector from "./inspector";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ view?: string }>;
}) {
  const { id } = await params;
  const directory = runsDirectory();
  let run;
  try { if (directory) run = await readRun(directory, id); } catch { /* Show a useful local error. */ }
  if (!run) return <section className="empty"><h1>Run unavailable</h1><p>The artifact could not be read, or uses an unsupported format.</p><Link href="/">Back to history</Link></section>;
  const { view } = await searchParams;
  return <><Link href="/" className="back">← Run history</Link><Inspector run={run} initialView={view === "hardware" ? "hardware" : "plan"} /></>;
}
