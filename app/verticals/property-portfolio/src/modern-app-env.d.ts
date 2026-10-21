/// <reference types="@modern-js/app-tools/types" />

declare const ULTRAMODERN_SITE_URL: string;

// The embedded document preview imports PDF.js's untyped in-page worker.
declare module 'pdfjs-dist/build/pdf.worker.mjs';
