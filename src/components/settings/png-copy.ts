"use client";

// The PNG copy of an SVG or WebP upload, for email (Gmail and Outlook show
// neither): the browser draws the chosen file from a blob URL into a canvas
// at 2x (512px wide for logos, 256px for symbols) and exports a PNG.

import { pngCopyWidth, svgViewBoxSize } from "@/lib/branding-draft";

// Keeps a very tall image from producing a huge canvas.
const MAX_HEIGHT = 2048;

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The browser could not draw this image."));
    image.src = url;
  });
}

export async function renderPngCopy(file: File, slot: string): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = await load(url);
    let width = image.naturalWidth;
    let height = image.naturalHeight;
    if (!width || !height) {
      // An SVG without width and height attributes: size it by its viewBox.
      const size = file.type === "image/svg+xml" ? svgViewBoxSize(await file.text()) : null;
      if (!size) {
        throw new Error("The SVG has no size the browser can read. Give it a viewBox or width and height.");
      }
      width = size.width;
      height = size.height;
    }
    const target = pngCopyWidth(slot);
    const canvas = document.createElement("canvas");
    canvas.width = target;
    canvas.height = Math.min(MAX_HEIGHT, Math.max(1, Math.round((target * height) / width)));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("The browser could not draw this image.");
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new Error("The browser could not export the image as PNG.");
    }
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
