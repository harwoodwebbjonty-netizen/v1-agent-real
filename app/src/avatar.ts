import { escapeHtml } from "./utils";

// A handful of colors pulled from the app's existing signal palette, so
// generated avatars feel native to the rest of the UI rather than random.
const FALLBACK_COLORS = ["#06b6d4", "#a78bfa", "#22c55e", "#f59e0b", "#ef4444", "#67e8f9"];

function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

function initialsForName(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
}

export interface AvatarSubject {
  name: string;
  avatar: string | null;
}

/** Renders a photo if set, otherwise a deterministic colored-initials circle. */
export function renderAvatarHtml(user: AvatarSubject, sizeClass: "avatar-sm" | "avatar-md" = "avatar-md"): string {
  if (user.avatar) {
    return `<img class="avatar ${sizeClass}" src="${escapeHtml(user.avatar)}" alt="${escapeHtml(user.name)}" />`;
  }
  const color = colorForName(user.name || "?");
  return `<span class="avatar ${sizeClass} avatar-fallback" style="background-color: ${color}">${escapeHtml(initialsForName(user.name || "?"))}</span>`;
}

/** Center-crops and downscales an image data URL to a square JPEG, so uploaded photos don't bloat the database. */
export function resizeImageDataUrl(dataUrl: string, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas not supported"));
        return;
      }
      const minSide = Math.min(img.width, img.height);
      const sx = (img.width - minSide) / 2;
      const sy = (img.height - minSide) / 2;
      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = dataUrl;
  });
}
