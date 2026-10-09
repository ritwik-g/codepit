import React from 'react';
import { Modal } from './Modal';
import { Button } from '../ui';
import { copyToClipboard, diffLines } from '../toolDisplay';
import '../styles/content-viewer.css';

export interface ContentViewerDiff {
  path?: string;
  oldText?: string | null;
  newText: string;
}

interface ContentViewerProps {
  path?: string;
  text?: string;
  diff?: ContentViewerDiff;
  onClose: () => void;
}

const languageFor = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase();
  const names: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript',
    py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', swift: 'Swift',
    css: 'CSS', html: 'HTML', json: 'JSON', md: 'Markdown', sh: 'Shell', yaml: 'YAML', yml: 'YAML',
  };
  return (ext && names[ext]) || (ext ? ext.toUpperCase() : 'Text');
};

export const ContentViewer: React.FC<ContentViewerProps> = ({ path, text, diff, onClose }) => {
  const titlePath = diff?.path || path;
  const title = titlePath?.split('/').filter(Boolean).slice(-3).join('/') || (diff ? 'Changes' : 'Content');
  const isDiff = Boolean(diff);
  const lines = diff ? diffLines(diff.oldText || '', diff.newText) : (text || '').split('\n').map((line) => ({ type: 'context' as const, text: line }));
  const added = lines.filter((line) => line.type === 'add').length;
  const removed = lines.filter((line) => line.type === 'del').length;

  return (
    <Modal
      onClose={onClose}
      heading={title}
      description={isDiff ? `${added} additions · ${removed} removals` : languageFor(titlePath || '')}
      icon={isDiff ? 'diff' : 'file'}
      size="lg"
      className="content-viewer-modal"
      bodyClassName="content-viewer-modal-body"
      headerActions={<Button variant="ghost" size="sm" icon="copy" onClick={() => void copyToClipboard(isDiff ? lines.map((line) => `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.text}`).join('\n') : text || '')}>Copy</Button>}
    >
      <div className={`content-viewer${isDiff ? ' is-diff' : ''}`} role="region" aria-label={isDiff ? `Diff for ${title}` : `Code from ${title}`}>
        <pre className="content-viewer-code">
          {lines.map((line, index) => (
            <span className={`content-viewer-line is-${line.type}`} key={index}>
              <span className="content-viewer-number" aria-hidden="true">{index + 1}</span>
              {isDiff && <span className="content-viewer-sign" aria-hidden="true">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>}
              <span className="content-viewer-text">{line.text || ' '}</span>
            </span>
          ))}
        </pre>
      </div>
    </Modal>
  );
};
