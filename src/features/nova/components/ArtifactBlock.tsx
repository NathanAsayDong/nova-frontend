import { useState } from 'react'
import type { Artifact } from '../chatTypes'

const KIND_LABEL: Record<Artifact['kind'], string> = {
  diff: 'Edited',
  file: 'File',
  terminal: 'Terminal',
}

/** Colour diff lines by their leading marker, ignoring the @@ hunk headers. */
function DiffBody({ content }: { content: string }) {
  return (
    <pre className="artifactPre">
      {content.split('\n').map((line, index) => {
        let tone = ''
        if (line.startsWith('+') && !line.startsWith('+++')) {
          tone = 'added'
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          tone = 'removed'
        } else if (line.startsWith('@@')) {
          tone = 'hunk'
        } else if (line.startsWith('+++') || line.startsWith('---')) {
          tone = 'meta'
        }
        return (
          <span key={index} className={`diffLine ${tone}`}>
            {line || ' '}
          </span>
        )
      })}
    </pre>
  )
}

export function ArtifactBlock({ artifact }: { artifact: Artifact }) {
  // Long files start folded so a 400-line paste can't bury the conversation.
  const lineCount = artifact.content.split('\n').length
  const [isOpen, setIsOpen] = useState(lineCount <= 30)

  const failed = typeof artifact.exitCode === 'number' && artifact.exitCode !== 0

  return (
    <figure className={`artifact kind-${artifact.kind} ${failed ? 'failed' : ''}`}>
      <button
        type="button"
        className="artifactHeader"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
      >
        <span className="artifactKind">{KIND_LABEL[artifact.kind]}</span>
        <span className="artifactTitle" title={artifact.title}>
          {artifact.title || artifact.language || ''}
        </span>
        {failed ? <span className="artifactExit">exit {artifact.exitCode}</span> : null}
        <span className="artifactLines">{lineCount} lines</span>
        <span className="artifactChevron">{isOpen ? '▾' : '▸'}</span>
      </button>

      {isOpen ? (
        artifact.kind === 'diff' ? (
          <DiffBody content={artifact.content} />
        ) : (
          <pre className="artifactPre">
            <code>{artifact.content}</code>
          </pre>
        )
      ) : null}
    </figure>
  )
}
