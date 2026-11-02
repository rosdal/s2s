import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Next.js pages fixture</h1>
      <ul>
        <li>
          <Link href="/about/">About</Link>
        </li>
        <li>
          <Link href="/blog/first-post/">First post</Link>
        </li>
      </ul>
    </main>
  );
}
