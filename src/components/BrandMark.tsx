import type { CSSProperties } from 'react';

// The wave mark from public/logo-bw.png (black on transparent), tinted to any
// colour via a CSS mask, so a dark surface can show it in the accent while a
// light one shows it in ink. The default was an amber left over from a palette
// the site no longer has; it is the ink of src/index.css now, which is the
// Workspace's own background colour.
// Pass label="" where the mark is decoration inside something already named —
// a bot avatar beside the bot's own name, say — so it is skipped rather than
// read out twice.
export default function BrandMark({
  className,
  tint = '#1c2028',
  label = 'Agentic Cloud Computer logo',
}: {
  className?: string;
  tint?: string;
  label?: string;
}) {
  const mask: CSSProperties = {
    backgroundColor: tint,
    maskImage: 'url(/logo-bw.png)',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    maskSize: 'contain',
    WebkitMaskImage: 'url(/logo-bw.png)',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    WebkitMaskSize: 'contain',
  };
  if (!label) {
    return <span className={`inline-block ${className ?? ''}`} style={mask} aria-hidden="true" />;
  }
  return <span className={`inline-block ${className ?? ''}`} style={mask} role="img" aria-label={label} />;
}
