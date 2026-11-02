import Link from "next/link";

export function getStaticPaths() {
  return {
    paths: [{ params: { slug: "first-post" } }, { params: { slug: "second-post" } }],
    fallback: false,
  };
}

export function getStaticProps({ params }) {
  return { props: { slug: params.slug } };
}

export default function Post({ slug }) {
  return (
    <main>
      <h1>Post: {slug}</h1>
      <Link href="/">Home</Link>
    </main>
  );
}
