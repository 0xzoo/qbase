import React from 'react';
import type { Answer } from '../lib/types';
import './OracleAnswerCard.css';

/** Map oracle answer_source to display names */
const MODEL_LABELS: Record<string, string> = {
  oracle_qlaude: 'qlaude',
  oracle_chatqpt: 'chatqpt',
  oracle_qemini: 'qemini',
};

/** Map oracle answer_source to full model provider display */
const MODEL_FULL_NAMES: Record<string, string> = {
  oracle_qlaude: 'Claude',
  oracle_chatqpt: 'ChatGPT',
  oracle_qemini: 'Gemini',
};

/** Map oracle answer_source to a hex accent color (purple/teal gradient) */
const MODEL_ACCENTS: Record<string, string> = {
  oracle_qlaude: '#8b5cf6',   // purple
  oracle_chatqpt: '#14b8a6',  // teal
  oracle_qemini: '#a78bfa',   // light purple
};

/** Simple SVG model icons (minimal) */
const ModelIcon: React.FC<{ source: string; size?: number }> = ({ source, size = 18 }) => {
  const color = MODEL_ACCENTS[source] || '#8b5cf6';
  const s = size;

  switch (source) {
    case 'oracle_qlaude':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case 'oracle_chatqpt':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'oracle_qemini':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      );
  }
};

/** Relative time helper (same as CompactAnswerCard) */
const getRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months}mo`;
  if (weeks > 0) return `${weeks}w`;
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
};

interface OracleAnswerCardProps {
  answer: Answer;
  /** Latency in ms (computed at display time if not stored on the answer) */
  latencyMs?: number;
  /** If true, render in compact mode for comparison view */
  compact?: boolean;
}

const OracleAnswerCard: React.FC<OracleAnswerCardProps> = ({ answer, latencyMs, compact = false }) => {
  const source = answer.answer_source || 'human';
  const accentColor = MODEL_ACCENTS[source] || '#8b5cf6';
  const modelLabel = MODEL_LABELS[source] || source;
  const modelFullName = MODEL_FULL_NAMES[source] || 'AI Model';
  const modelVersion = answer.oracle_model || '';
  const costQq = answer.oracle_cost_qq || '';
  const isRefused = answer.oracle_refused;

  const latencyDisplay = latencyMs !== undefined
    ? `${(latencyMs / 1000).toFixed(1)}s`
    : null;

  const relativeTime = typeof answer.created_at === 'number'
    ? getRelativeTime(answer.created_at)
    : '';

  return (
    <div
      className={`oracle-answer-card ${compact ? 'oracle-answer-card--compact' : ''}`}
      style={{ '--oracle-accent': accentColor } as React.CSSProperties}
    >
      {/* Header: model icon + name + metadata badge */}
      <div className="oracle-answer-header">
        <div className="oracle-answer-model">
          <ModelIcon source={source} size={compact ? 14 : 18} />
          <span className="oracle-model-name">{modelLabel}</span>
        </div>
        <div className="oracle-answer-badge">
          {modelVersion && (
            <span className="oracle-badge-item" title="Model version">
              {modelVersion.replace(/^claude-|^gpt-|^gemini-/i, '').substring(0, 12)}
            </span>
          )}
          {costQq && (
            <span className="oracle-badge-item oracle-badge-cost" title="$QQ cost">
              {costQq} $QQ
            </span>
          )}
          {latencyDisplay && (
            <span className="oracle-badge-item" title="Response time">
              {latencyDisplay}
            </span>
          )}
        </div>
      </div>

      {/* Sub-header: full model name + time */}
      {!compact && (
        <div className="oracle-answer-subheader">
          <span className="oracle-model-full">{modelFullName}</span>
          {relativeTime && <span className="oracle-answer-time">{relativeTime}</span>}
        </div>
      )}

      {/* Answer content */}
      <div className="oracle-answer-content">
        {isRefused ? (
          <span className="oracle-refused-message">
            This model couldn't answer this question.
          </span>
        ) : (
          answer.value
        )}
      </div>

      {/* No actions — oracle answers are measurements, not conversations */}
    </div>
  );
};

export default OracleAnswerCard;
