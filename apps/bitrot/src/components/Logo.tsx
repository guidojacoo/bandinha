/** Brand mark: a package cube with a bite taken out of the corner. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Z"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M3.5 7 12 11.7 20.5 7M12 11.7v9.8" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="17.6" cy="15.4" r="2.6" fill="var(--bg)" />
      <circle cx="17.6" cy="15.4" r="1.5" fill="var(--grade-f)" opacity="0.85" />
    </svg>
  );
}
