export const metadata = {
  title: "PE Intelligence",
  description: "The Investor Bible, kept current, and mandate ranking that says why",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body style={{
        margin: 0, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        background: "#fafaf9", color: "#1c1917",
      }}>
        {children}
      </body>
    </html>
  );
}
