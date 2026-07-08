import ReactMarkdown from 'react-markdown'

type MarkdownPanelProps = {
  isOpen: boolean
  isToolsPanelOpen: boolean
  markdown: string
  onToggleOpen: () => void
}

export function MarkdownPanel({
  isOpen,
  isToolsPanelOpen,
  markdown,
  onToggleOpen,
}: MarkdownPanelProps) {
  if (!markdown) {
    return null
  }

  const offsetClass = isToolsPanelOpen ? 'toolsOffset' : ''

  return (
    <>
      <button
        type="button"
        className={`markdownEdgeToggle ${isOpen ? 'open' : 'closed'} ${offsetClass}`}
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        aria-controls="nova-markdown-panel"
        aria-label={isOpen ? 'Hide response panel' : 'Show response panel'}
      >
        {isOpen ? '›' : '‹'}
      </button>

      <aside
        id="nova-markdown-panel"
        className={`markdownPanel ${isOpen ? 'open' : 'closed'} ${offsetClass}`}
      >
        <section className="markdownPanelContent">
          <h2>Response</h2>
          <div className="markdownBody">
            <ReactMarkdown>{markdown}</ReactMarkdown>
          </div>
        </section>
      </aside>
    </>
  )
}
