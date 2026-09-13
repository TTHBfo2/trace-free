import type { Metadata } from 'next';
import './globals.css';
import { SidebarFree } from '@/components/SidebarFree';
import { Providers } from '@/components/Providers';

export const metadata: Metadata = {
  title: 'Trimwares Trace',
  description: 'Token attribution and cost tracking for LLM applications.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="flex h-screen overflow-hidden bg-[#0a0a0a] text-white">
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
