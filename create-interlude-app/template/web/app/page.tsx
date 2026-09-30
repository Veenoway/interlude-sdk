import { ClickerApp } from "@/components/clicker-app";

/**
 * A server component that renders one client component. Everything that touches the wallet,
 * the session key or the node lives behind `"use client"` in `components/clicker-app.tsx`.
 */
export default function Home() {
  return <ClickerApp />;
}
