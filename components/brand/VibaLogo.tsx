// VIBA wordmark: vector trace of the brand artwork. Each letter is split along
// its own rising diagonal, black above and a green gradient below.
// Generated from the logo PNG (potrace); edit the artwork, not these paths.

const LETTERS = [
  {
    "k": "V",
    "d": "M226 324.2C226.7 322.7 235.8 301.7 246.2 277.5C256.7 253.3 271.1 220 278.2 203.5C285.4 187 292.5 170.6 294 167C295.5 163.4 297.9 158 299.3 155C301.8 149.7 340.6 59.7 357 21.2L364.8 3L311.5 3L258.2 3L242.5 42.8C233.8 64.6 221.6 95.3 215.2 111C188.5 177 183.1 191.3 177.5 211.3C176.6 214.5 175.6 217 175.4 216.7C175.2 216.5 173.7 211 172 204.5C167.6 187 166.2 182.4 134.5 80C131 68.7 124.5 47.4 120 32.5C115.5 17.6 111.7 4.9 111.5 4.2C110.9 2.4 2 2.4 2 4.3C2 5.9 23.3 63.9 71.2 192.5C77.7 210.1 91.5 247.6 101.8 275.7L120.5 327L172.6 327L224.7 327L226 324.2Z",
    "line": [
      -50,
      264.5,
      1170,
      -126.8
    ]
  },
  {
    "k": "I",
    "d": "M463 164.5L463 2L416.5 2L370 2L370 164.5L370 327L416.5 327L463 327L463 164.5Z",
    "line": [
      -50,
      320.3,
      1170,
      -51.5
    ]
  },
  {
    "k": "B",
    "d": "M673 325.5C699.9 321.5 722.4 310.5 740 292.9C759.9 272.9 769.5 249.6 769.3 221.5C769 187.9 752.2 165.9 718.6 155.5L709.7 152.7L718.5 149.8C731.1 145.7 737.7 141.8 745.8 133.8C753.8 125.8 759.7 115.8 762.6 105C765.3 95.1 765.1 75.9 762.2 65.6C753.4 34.8 729.2 14.2 691 4.7L682.5 2.6L584.2 2.3L486 1.9L486 164.5L486 327L574.8 327C647 327 665.3 326.7 673 325.5ZM576 229.5L576 201L610.8 201C647.4 201 652.1 201.5 660.8 205.9C672 211.6 677.3 224.5 673.7 237.1C670.6 247.6 661.1 254.8 647.3 257C644.1 257.6 626.8 258 608.8 258L576 258L576 229.5ZM576 99.5L576 72L607.2 72C640.9 72 648.4 72.7 656.6 76.6C668.5 82.2 673.8 95 669.8 108.2C668.1 113.8 661.1 121.3 654.8 124.1L649.5 126.5L612.8 126.8L576 127.1L576 99.5Z",
    "line": [
      -50,
      383.3,
      1170,
      10.1
    ]
  },
  {
    "k": "A",
    "d": "M847.1 319.5C848.7 315.6 853.6 302.8 858 291C862.4 279.2 866.7 268 867.5 266.2L869 263L930.7 263L992.5 263L1004.5 295L1016.5 327L1067.2 327C1095.2 327 1118 326.8 1118 326.5C1118 325.6 1094.2 267.3 1078.2 229C1073.2 217.2 1066.4 200.8 1063 192.5C1059.5 184.2 1054.3 171.6 1051.2 164.5C1048.2 157.4 1042 142.3 1037.5 131C1033 119.7 1019.3 86.1 1007 56.2L984.7 2L930.6 2L876.5 2L869.1 20.3C865 30.3 846.1 76.3 827 122.5C807.9 168.7 788.6 215.5 784 226.5C779.5 237.5 773.1 253 769.8 261C766.5 269 759.3 286.5 753.8 300C748.3 313.5 743.6 325.1 743.3 325.8C742.9 326.8 753 327 793.6 326.8L844.4 326.5L847.1 319.5ZM893.6 189.8C893.9 188.5 895.7 183.7 897.5 179C922.1 114.1 929.4 95.3 930 94C930.7 92.8 931.1 93 931.8 95C932.4 96.4 937.8 110.5 944 126.5C956.6 159.1 961.9 172.9 966.1 184.2L968.9 192L930.9 192L892.9 192L893.6 189.8Z",
    "line": [
      -50,
      461.0,
      1170,
      88.3
    ]
  }
] as const;

export const LOGO_W = 1120;
export const LOGO_H = 329;

export default function VibaLogo({
  className,
  title = "VIBA",
  ink = "#141617",
  idSuffix = "",
}: {
  className?: string;
  title?: string;
  /** colour of the upper half (use a light colour on dark backgrounds) */
  ink?: string;
  /** keeps gradient/clip ids unique when the logo appears twice on a page */
  idSuffix?: string;
}) {
  const g = `viba-green${idSuffix}`;
  return (
    <svg viewBox={`0 0 ${LOGO_W} ${LOGO_H}`} className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={g} gradientUnits="userSpaceOnUse" x1="0" y1="128" x2="0" y2="326">
          <stop offset="0" stopColor="#4cc42a" />
          <stop offset="0.5" stopColor="#33a817" />
          <stop offset="1" stopColor="#1f8a0a" />
        </linearGradient>
        {LETTERS.map((l) => {
          const [ax, ay, bx, by] = l.line;
          return (
            <g key={l.k}>
              <clipPath id={`viba-top-${l.k}${idSuffix}`}>
                <polygon points={`${ax},-10 ${bx},-10 ${bx},${by + 0.6} ${ax},${ay + 0.6}`} />
              </clipPath>
              <clipPath id={`viba-bot-${l.k}${idSuffix}`}>
                <polygon points={`${ax},${ay} ${bx},${by} ${bx},${LOGO_H + 10} ${ax},${LOGO_H + 10}`} />
              </clipPath>
            </g>
          );
        })}
      </defs>
      {LETTERS.map((l) => (
        <g key={l.k} fillRule="evenodd">
          <path d={l.d} fill={ink} clipPath={`url(#viba-top-${l.k}${idSuffix})`} />
          <path d={l.d} fill={`url(#${g})`} clipPath={`url(#viba-bot-${l.k}${idSuffix})`} />
        </g>
      ))}
    </svg>
  );
}
