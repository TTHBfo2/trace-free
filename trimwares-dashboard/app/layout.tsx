import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { SidebarFree } from '@/components/SidebarFree';
import { Providers } from '@/components/Providers';

// Fonts are downloaded once at BUILD time and self-hosted inside the static
// export (_next/static/media). The dashboard used to @import them from
// fonts.googleapis.com at runtime — a third-party network request on every
// page load from a tool whose whole pitch is "nothing leaves your machine",
// and a broken layout offline. Now: zero runtime requests, works air-gapped.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Trimwares Trace',
  description: 'Token attribution and cost tracking for LLM applications.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="flex h-screen overflow-hidden bg-[#0a0a0a] text-white font-sans">
        <Providers>
          <SidebarFree />
          <main className="flex-1 overflow-y-auto">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
