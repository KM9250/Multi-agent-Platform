/// <reference types="vite/client" />
import React from 'react';
import { createRoot } from 'react-dom/client';
// This separate entry is served only by Vite dev and is not a production build input.
if (import.meta.env.DEV) {
  const { default: BrowserPocSandbox } = await import('./components/BrowserPocSandbox');
  createRoot(document.getElementById('root')!).render(<BrowserPocSandbox />);
}
