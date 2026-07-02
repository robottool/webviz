/**
 * Monochrome line-icon set. Hand-rolled inline SVGs (no icon dependency, in
 * keeping with the repo's lean ethos) that inherit `currentColor`, so every
 * icon picks up the surrounding text/accent/per-tab-hue colour automatically —
 * unlike the emoji they replace, which carried their own palette and clashed
 * with the themes (especially the light "industry" one).
 *
 * Shared geometry: a 24×24 viewBox, 1.75 stroke, round caps/joins. Add a `name`
 * to PATHS and it's usable as <Icon name="…" />.
 */

import type { ReactNode } from 'react';

export type IconName =
  | 'cube'
  | 'camera'
  | 'chart'
  | 'map'
  | 'search'
  | 'list'
  | 'gear'
  | 'save'
  | 'folder'
  | 'record'
  | 'plug'
  | 'broadcast'
  | 'clock'
  | 'pin'
  | 'newfile';

const PATHS: Record<IconName, ReactNode> = {
  // Tab types
  cube: (
    <>
      <path d="M12 2 21 7v10l-9 5-9-5V7z" />
      <path d="M12 12 21 7M12 12v10M12 12 3 7" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7l1.5-2h3L15 7" />
      <circle cx="12" cy="13.5" r="3.2" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4v16h16" />
      <path d="M7 14l3-4 3 2 4-6" />
    </>
  ),
  map: (
    <>
      <path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.3-4.3" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // Top bar / status
  // Outline cogwheel (teeth + centre circle) — reads as ⚙ but stays line-style
  // at the shared 1.75 stroke, so it matches save/folder/etc. in weight.
  gear: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  save: (
    <>
      <path d="M5 3h11l3 3v15H5z" />
      <path d="M8 3v5h7V3" />
      <rect x="8" y="13" width="8" height="5" />
    </>
  ),
  folder: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v1H3z" />
      <path d="M3 10h18l-2 9H5z" />
    </>
  ),
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  plug: (
    <>
      <path d="M9 2v6M15 2v6" />
      <path d="M7 8h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 16v6" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M7.5 7.5a6 6 0 0 0 0 9M16.5 7.5a6 6 0 0 1 0 9" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  pin: (
    <>
      <path d="M9 3h6l-1 6 3 3H7l3-3z" />
      <path d="M12 15v6" />
    </>
  ),
  newfile: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M12 11v6M9 14h6" />
    </>
  ),
};

export function Icon({
  name,
  size = 14,
  className,
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
