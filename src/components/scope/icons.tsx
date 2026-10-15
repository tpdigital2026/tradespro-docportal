import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="sc-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
export const MicIcon = () => (
  <Svg>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);
export const UpIcon = () => (
  <Svg>
    <path d="M6 14l6-6 6 6" />
  </Svg>
);
export const DownIcon = () => (
  <Svg>
    <path d="M6 10l6 6 6-6" />
  </Svg>
);
export const TrashIcon = () => (
  <Svg>
    <path d="M4 7h16M10 7V4h4v3M7 7l1 13h8l1-13" />
  </Svg>
);
export const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const ChevronIcon = () => (
  <Svg>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
