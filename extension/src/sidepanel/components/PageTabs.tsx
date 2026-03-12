import type { TLPageId } from 'tldraw';

interface PageInfo {
  id: TLPageId;
  name: string;
}

interface PageTabsProps {
  pages: PageInfo[];
  currentPageId: TLPageId;
  onPageSelect: (pageId: TLPageId) => void;
}

export function PageTabs({ pages, currentPageId, onPageSelect }: PageTabsProps) {
  if (pages.length <= 1) return null;

  return (
    <div className="page-tabs">
      {pages.map((page) => (
        <button
          key={page.id}
          className={`page-tab ${page.id === currentPageId ? 'active' : ''}`}
          onClick={() => onPageSelect(page.id)}
        >
          {page.name}
        </button>
      ))}
    </div>
  );
}
