"use client";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

export default function Refresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) router.refresh(); }, 10000);
    return () => clearInterval(timer);
  }, [router]);
  return <button disabled={pending} onClick={() => startTransition(() => router.refresh())}>{pending ? "Refreshing…" : "Refresh history"}</button>;
}
