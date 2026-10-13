import type { Metadata } from "next";
import Link from "next/link";
import "./style.css";

export const metadata: Metadata = { title: "Stratum Inspector", description: "Runtime history and optimizer playground" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>
    <header><Link href="/" className="brand"><span className="mark">≋</span> stratum <span>inspector</span></Link><nav className="app-nav" aria-label="Inspector tools"><Link href="/">Run history</Link><Link href="/playground">Optimizer playground</Link></nav></header>
    <main>{children}</main>
  </body></html>;
}
