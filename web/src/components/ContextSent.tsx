import React, { useState } from 'react';
import type { ContextSentRecord } from '../types';
import { Modal } from './Modal';
import { MarkdownContent } from './MarkdownContent';
import { Button, Icon, Spinner, Tabs } from '../ui';
import { copyToClipboard } from '../toolDisplay';
import '../styles/context-sent.css';

type View = 'raw' | 'formatted';
/** A preview, before the switch is made, has nothing sent yet. */
export type ContextPreview = Omit<ContextSentRecord, 'reason'> & { reason: ContextSentRecord['reason'] | 'none' };

const HEADING: Record<ContextPreview['reason'], string> = {
  handoff: 'Context handed to a new agent session',
  'catch-up': 'Catch-up sent to the agent',
  fork: 'Handover to this session',
  compaction: 'History given to the agent to summarise',
  none: 'No conversation handed over',
};

/** Rough tokens: about four characters each. */
const roughTokens = (text: string) => {
  const n = Math.ceil(text.length / 4);
  return n >= 1000 ? `~${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k tokens` : `~${n} tokens`;
};

export function describeContext(c: ContextPreview): string {
  const parts: string[] = [c.mode === 'full' ? 'Full' : 'Compact'];
  if (c.reason === 'fork' && c.fromAgent) parts.push(`from ${c.fromAgent.replace(/ \(ACP\)$/, '')}`);
  if (c.includesSummary) parts.push('compaction summary');
  parts.push(`${c.turnCount} turn${c.turnCount === 1 ? '' : 's'}`);
  if (c.text) parts.push(roughTokens(c.text));
  return parts.join(' · ');
}

/** What CodePit handed an agent with a prompt (or, as a preview, would hand it), as sent and formatted. */
export const ContextSentModal: React.FC<{
  context?: ContextPreview;
  /** A preview: still loading, or failed. */
  loading?: boolean;
  error?: string | null;
  preview?: boolean;
  /** Shown above the text, e.g. what a preview leaves open. */
  note?: React.ReactNode;
  nested?: boolean;
  onClose: () => void;
}> = ({ context, loading, error, preview, note, nested, onClose }) => {
  const [view, setView] = useState<View>('raw');
  const heading = preview ? 'Context to hand over' : context ? HEADING[context.reason] : 'Context';
  return (
    <Modal
      onClose={onClose}
      heading={heading}
      description={context ? describeContext(context) : undefined}
      icon="layers"
      size="lg"
      nested={nested}
      className="ctx-sent-modal"
      bodyClassName="ctx-sent-body"
      headerActions={
        context?.text ? (
          <Button variant="ghost" size="sm" icon="copy" onClick={() => void copyToClipboard(context.text)}>
            Copy
          </Button>
        ) : undefined
      }
    >
      {note && (
        <p className="ctx-sent-note">
          <Icon name="info" size={13} />
          <span>{note}</span>
        </p>
      )}
      {loading ? (
        <div className="ctx-sent-empty">
          <Spinner size={14} /> Building the handover…
        </div>
      ) : error ? (
        <div className="ctx-sent-empty is-error">{error}</div>
      ) : !context?.text ? (
        <div className="ctx-sent-empty">The agent gets no earlier conversation, only the prompt.</div>
      ) : (
        <>
          <Tabs
            label="How to show the context"
            value={view}
            onChange={setView}
            items={[
              { id: 'raw', label: 'As sent' },
              { id: 'formatted', label: 'Formatted' },
            ]}
          />
          <div className="ctx-sent-text" role="region" aria-label="Context text" tabIndex={0}>
            {view === 'raw' ? <pre>{context.text}</pre> : <MarkdownContent content={context.text} />}
          </div>
        </>
      )}
    </Modal>
  );
};

/** A chip on a turn that carried context: opens what was sent. */
export const ContextSentChip: React.FC<{ context: ContextSentRecord; className?: string }> = ({ context, className }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`ui-badge tone-neutral ctx-sent-chip${className ? ` ${className}` : ''}`}
        title={`${HEADING[context.reason]}: ${describeContext(context)}. Click to see it.`}
        onClick={() => setOpen(true)}
      >
        <Icon name="layers" size={11} />
        {context.reason === 'compaction' ? 'History sent' : context.reason === 'catch-up' ? 'Catch-up sent' : 'Context sent'}
      </button>
      {open && <ContextSentModal context={context} onClose={() => setOpen(false)} />}
    </>
  );
};
