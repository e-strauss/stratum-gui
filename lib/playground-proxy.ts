const limit = 64 * 1024;

export async function proxyOptimization(request: Request, send: typeof fetch = fetch) {
  const origin = request.headers.get("origin");
  // Next.js may normalize request.url to localhost even for 127.0.0.1 clients.
  // Validate the actual HTTP Host, restricting it to loopback addresses.
  const url = new URL(request.url);
  let local: URL;
  try { local = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`); }
  catch { return Response.json({ message: "Invalid inspector host." }, { status: 403 }); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(local.hostname) ||
      (origin && origin !== local.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ message: "Submit code from the inspector's own page." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Response.json({ message: "Expected application/json." }, { status: 415 });
  }
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ message: "Provide Python code." }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return Response.json({ message: "Code request exceeds 64 KiB." }, { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const text = new TextDecoder().decode(bytes);
  try { JSON.parse(text); }
  catch { return Response.json({ message: "Invalid JSON request." }, { status: 400 }); }
  try {
    const backend = new URL(process.env.STRATUM_OPTIMIZER_URL ?? "http://127.0.0.1:3101");
    if (backend.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname)) {
      throw new Error("The optimizer backend must use a loopback HTTP address.");
    }
    const upstream = await send(new URL("/optimize", backend), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: text,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(100_000)]), cache: "no-store",
    });
    return new Response(upstream.body, { status: upstream.status, headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
    } });
  } catch {
    return Response.json({ message: "Optimizer backend unavailable. Start it with: uv run python -m backend.server" }, { status: 503 });
  }
}
