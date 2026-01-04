export default function Landing() {
  return (
    <main style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif", padding: 24, maxWidth: 980, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "#111", color: "#fff", display: "grid", placeItems: "center", fontWeight: 700 }}>
            T
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>ThankuMail</div>
            <div style={{ fontSize: 13, opacity: 0.75 }}>The easiest way to say thanks</div>
          </div>
        </div>
        <a href="/claim/test" style={{ fontSize: 13, textDecoration: "none", padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd" }}>
          Claim flow (test)
        </a>
      </header>

      <section style={{ marginTop: 28, padding: 22, border: "1px solid #eee", borderRadius: 16 }}>
        <h1 style={{ margin: 0, fontSize: 44, lineHeight: 1.05 }}>Send a little happiness.</h1>
        <p style={{ marginTop: 12, marginBottom: 0, fontSize: 16, opacity: 0.85 }}>
          Create a digital gift in seconds. Send money with a personal note to anyone, anywhere. No account required.
        </p>

        <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <a href="/claim/test" style={{ textDecoration: "none", padding: "12px 16px", borderRadius: 12, background: "#111", color: "#fff", fontWeight: 600 }}>
            Try the claim page
          </a>
          <a href="/__where" style={{ textDecoration: "none", padding: "12px 16px", borderRadius: 12, border: "1px solid #ddd", fontWeight: 600 }}>
            Health check
          </a>
        </div>
      </section>

      <section style={{ marginTop: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <div style={{ border: "1px solid #eee", borderRadius: 16, padding: 16 }}>
          <div style={{ fontWeight: 700 }}>Anonymous-friendly</div>
          <div style={{ marginTop: 6, fontSize: 14, opacity: 0.8 }}>Send appreciation without oversharing personal info.</div>
        </div>
        <div style={{ border: "1px solid #eee", borderRadius: 16, padding: 16 }}>
          <div style={{ fontWeight: 700 }}>Fast</div>
          <div style={{ marginTop: 6, fontSize: 14, opacity: 0.8 }}>A simple flow that works on any device.</div>
        </div>
        <div style={{ border: "1px solid #eee", borderRadius: 16, padding: 16 }}>
          <div style={{ fontWeight: 700 }}>Secure</div>
          <div style={{ marginTop: 6, fontSize: 14, opacity: 0.8 }}>Designed for clean handoffs and minimal data.</div>
        </div>
      </section>

      <footer style={{ marginTop: 28, paddingTop: 14, borderTop: "1px solid #eee", fontSize: 13, opacity: 0.75 }}>
        © {new Date().getFullYear()} ThankuMail
      </footer>
    </main>
  );
}
