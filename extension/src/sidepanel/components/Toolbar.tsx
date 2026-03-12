interface ToolbarProps {
  hasImage: boolean;
  hasSelection: boolean;
  onCapture: () => void;
  onClearImage: () => void;
  onCopyImage: () => void;
  onDeleteSelected: () => void;
  onDuplicateToNewPage: () => void;
  copyStatus: 'idle' | 'copied' | 'error';
}

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const XCircleIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="15" y1="9" x2="9" y2="15" />
    <line x1="9" y1="9" x2="15" y2="15" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const DeleteIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const DuplicateIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

export function Toolbar({
  hasImage,
  hasSelection,
  onCapture,
  onClearImage,
  onCopyImage,
  onDeleteSelected,
  onDuplicateToNewPage,
  copyStatus,
}: ToolbarProps) {
  const getCopyContent = () => {
    if (copyStatus === 'copied') return { icon: <CheckIcon />, label: 'Copied', className: 'toolbar-btn success' };
    if (copyStatus === 'error') return { icon: <XCircleIcon />, label: 'Failed', className: 'toolbar-btn danger' };
    return { icon: <CopyIcon />, label: 'Copy', className: 'toolbar-btn' };
  };

  const copy = getCopyContent();

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={onCapture}
          title="Capture current tab screenshot"
        >
          <CameraIcon />
          <span>Capture</span>
        </button>

        {hasSelection && (
          <>
            <button
              className="toolbar-btn danger"
              onClick={onDeleteSelected}
              title="Delete selected (Del)"
            >
              <DeleteIcon />
              <span>Delete</span>
            </button>

            <button
              className="toolbar-btn accent"
              onClick={onDuplicateToNewPage}
              title="Duplicate selected to new page"
            >
              <DuplicateIcon />
              <span>Duplicate</span>
            </button>
          </>
        )}

        {hasImage && (
          <>
            <button
              className={copy.className}
              onClick={onCopyImage}
              title="Copy annotated image to clipboard"
            >
              {copy.icon}
              <span>{copy.label}</span>
            </button>

            <button
              className="toolbar-btn danger"
              onClick={onClearImage}
              title="Clear all"
            >
              <TrashIcon />
            </button>
          </>
        )}
      </div>

      <div className="toolbar-spacer" />
    </div>
  );
}
