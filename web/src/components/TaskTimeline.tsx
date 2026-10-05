import React from 'react';
import type { ToolCallRecord, TurnSegment } from '../types';
import { MarkdownContent } from './MarkdownContent';
import { SubagentCard, ThoughtRow, ToolRow } from './AgentTurn';
import { isActive } from '../toolDisplay';

/** Renders a task's segments: messages as prose, runs of calls and reasoning as a compact list. */
export const Timeline: React.FC<{ segments: TurnSegment[]; calls: Map<string, ToolCallRecord>; taskRunning: boolean }> = ({
  segments,
  calls,
  taskRunning,
}) => {
  const blocks: Array<{ key: string; text?: string; items?: TurnSegment[]; subagent?: ToolCallRecord }> = [];
  for (const seg of segments) {
    if (seg.kind === 'text') {
      if (seg.text.trim()) blocks.push({ key: seg.id, text: seg.text });
      continue;
    }
    const call = seg.kind === 'tool' ? calls.get(seg.toolCallId) : undefined;
    if (seg.kind === 'tool' && !call) continue;
    if (call?.isSubagent) {
      blocks.push({ key: seg.id, subagent: call });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.items) last.items.push(seg);
    else blocks.push({ key: seg.id, items: [seg] });
  }
  const childrenOf = (id: string) => [...calls.values()].filter((c) => c.parentToolUseId === id);

  return (
    <div className="turn-timeline">
      {blocks.map((b) => {
        if (b.text != null) {
          return (
            <div key={b.key} className="timeline-message">
              <MarkdownContent content={b.text} />
            </div>
          );
        }
        if (b.subagent) return <SubagentCard key={b.key} call={b.subagent} childCalls={childrenOf(b.subagent.id)} />;
        return (
          <div key={b.key} className="activity-items">
            {b.items!.map((seg) => {
              if (seg.kind === 'thought') return <ThoughtRow key={seg.id} text={seg.text} live={false} />;
              const call = calls.get((seg as Extract<TurnSegment, { kind: 'tool' }>).toolCallId)!;
              // A call still marked as going in a task that has ended was cut off
              return <ToolRow key={seg.id} call={call} interrupted={!taskRunning && isActive(call)} />;
            })}
          </div>
        );
      })}
    </div>
  );
};
