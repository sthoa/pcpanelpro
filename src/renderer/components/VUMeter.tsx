import React from 'react';

const VU_BAR_COUNT = 8;
// Bottom-to-top segment colors: 4 green, 2 yellow, 1 orange, 1 red
const VU_COLORS = [
  'rgb(51, 199, 102)', 'rgb(51, 199, 102)', 'rgb(51, 199, 102)', 'rgb(51, 199, 102)',
  'rgb(242, 191, 51)', 'rgb(242, 191, 51)',
  'rgb(242, 128, 51)',
  'rgb(230, 64, 64)',
];

export function VUMeter({ level, muted }: { level: number; muted: boolean }) {
  const lit = Math.round(Math.min(1, level) * VU_BAR_COUNT);
  return (
    <div className="vu" aria-hidden="true">
      {VU_COLORS.map((color, i) => {
        const isLit = !muted && i < lit;
        return (
          <span
            key={i}
            className="vu-bar"
            style={{ background: isLit ? color : 'rgba(255, 255, 255, 0.15)' }}
          />
        );
      })}
    </div>
  );
}

// Filled speaker in the SF-symbol style: rounded driver body merged with the
// cone, soft round-capped waves, and a bold X when muted. Drawn 1:1 on an
// 18px grid so strokes sit on device pixels and stay crisp.
export function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M8.6 3 5.3 5.9H3.2C2.3 5.9 1.6 6.6 1.6 7.5v3c0 .9.7 1.6 1.6 1.6h2.1L8.6 15c.65.57 1.55.12 1.55-.72V3.72C10.15 2.88 9.25 2.43 8.6 3Z"
        fill="currentColor"
      />
      {muted ? (
        <path
          d="M12.4 6.7 16.6 11.3 M16.6 6.7 12.4 11.3"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        />
      ) : (
        <>
          <path d="M12.2 6.4a3.6 3.6 0 0 1 0 5.2" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" />
          <path d="M14.4 4.3a6.6 6.6 0 0 1 0 9.4" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" opacity="0.55" />
        </>
      )}
    </svg>
  );
}
