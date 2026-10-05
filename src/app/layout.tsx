import type { Metadata, Viewport } from "next";
import { Sora, Red_Hat_Display, Red_Hat_Mono } from "next/font/google";
import { APP_NAME } from "@/lib/brand";
import { APP_ICON_APPLE } from "@/lib/brand-assets";
import { DEFAULT_DARK_PALETTE, DEFAULT_LIGHT_PALETTE } from "@/lib/brand-theme";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
});

const redHatDisplay = Red_Hat_Display({
  subsets: ["latin"],
  variable: "--font-red-hat-display",
});

const redHatMono = Red_Hat_Mono({
  subsets: ["latin"],
  variable: "--font-red-hat-mono",
});

// The installable app: the manifest and the iPhone home screen icon are
// the same paths on every host, and their routes answer for the host they
// are asked on (src/server/pwa/manifest.ts). No apple-mobile-web-app-title:
// iPhone then takes the name from the host's manifest.
export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
  manifest: "/site.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default" },
  icons: { apple: APP_ICON_APPLE },
};

// The browser and installed-app chrome follow the default surfaces.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: DEFAULT_LIGHT_PALETTE.surface },
    { media: "(prefers-color-scheme: dark)", color: DEFAULT_DARK_PALETTE.surface },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // suppressHydrationWarning: theme-init.js may set data-theme on <html>
  // before React hydrates. The next/font variables sit on <html> so the
  // :root font defaults in globals.css (--font-heading, --font-body) can
  // reference them.
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sora.variable} ${redHatDisplay.variable} ${redHatMono.variable}`}
    >
      <head>
        {/*
          A plain blocking script on purpose, so the stored theme lands before
          first paint. next/script's beforeInteractive does not do that in the
          App Router: it queues the file for Next's client bootstrap, which
          runs after the async framework chunks (and so possibly after first
          paint). See node_modules/next/dist/client/script.js.
        */}
        <script src="/theme-init.js" />
      </head>
      <body className="min-h-dvh bg-bg font-sans text-ink">
        {children}
      </body>
    </html>
  );
}
