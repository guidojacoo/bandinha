/** A small rain cloud — the product is called Rainmaker. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 14.5a4 4 0 0 1 2.2-3.6 5 5 0 0 1 9.7-1.2A3.6 3.6 0 0 1 19 16.5H8.2A3.2 3.2 0 0 1 5 14.5Z"
        stroke="var(--text-muted)" strokeWidth="1.4" strokeLinejoin="round"
      />
      <path d="M9.5 19.2l-.8 1.6M13 19.2l-.8 1.6M16.5 19.2l-.8 1.6"
        stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
