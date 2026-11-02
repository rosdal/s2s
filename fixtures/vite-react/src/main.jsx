import { lazy, StrictMode, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";

// Only rendered at #/admin, which the capture never visits.
const Admin = lazy(() => import("./Admin.jsx"));
// Loaded once the footer scrolls into view.
const Footer = lazy(() => import("./Footer.jsx"));

function LazyOnScroll() {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="footer-slot">
      {visible && (
        <Suspense fallback={null}>
          <Footer />
        </Suspense>
      )}
    </div>
  );
}

function App() {
  const isAdmin = location.hash === "#/admin";
  return (
    <main>
      <h1>Vite React fixture</h1>
      {isAdmin ? (
        <Suspense fallback={null}>
          <Admin />
        </Suspense>
      ) : (
        <div className="tall">Scroll down</div>
      )}
      <LazyOnScroll />
    </main>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
