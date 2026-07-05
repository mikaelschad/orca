// Why: a simplified monochrome mark (rounded tile outline + checkmark
// swoosh) stands in for YouTrack's branded logo so it renders consistently
// with Orca's other single-color provider icons via `currentColor`.
export function YouTrackIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4 0C1.791 0 0 1.791 0 4v16c0 2.209 1.791 4 4 4h16c2.209 0 4-1.791 4-4V4c0-2.209-1.791-4-4-4H4Zm1.5 2A3.5 3.5 0 0 0 2 5.5v13A3.5 3.5 0 0 0 5.5 22h13a3.5 3.5 0 0 0 3.5-3.5v-13A3.5 3.5 0 0 0 18.5 2h-13Z"
      />
      <path d="M6.288 12.045a1 1 0 0 1 1.414-.045l2.866 2.68 6.702-7.359a1 1 0 1 1 1.48 1.346l-7.396 8.121a1 1 0 0 1-1.427.03l-3.594-3.36a1 1 0 0 1-.045-1.413Z" />
    </svg>
  )
}
