import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Share2, Heart, ChevronDown, ChevronUp } from 'lucide-react';
import type { Answer, AnswerWFname } from '../lib/types';
import { useTextMeasure } from '../hooks/useTextMeasure';
import './AnswerCard.css';

/** Max lines before truncation */
const MAX_COLLAPSED_LINES = 4;

/** Must match .answer-content CSS: font-size 1rem = 16px, line-height 1.5 = 24px */
const ANSWER_FONT = '400 16px Inter, system-ui, sans-serif';
const ANSWER_LINE_HEIGHT = 24;

interface AnswerCardPretextProps {
  answer: Answer | AnswerWFname;
  questionText?: string;
  showActions?: boolean;
}

/**
 * Enhanced AnswerCard with Pretext-powered text measurement.
 * - Accurate line-based truncation without DOM reflow
 * - "Show more/less" only appears when text actually exceeds MAX_COLLAPSED_LINES
 * - Container width measured once via ResizeObserver (not per-render)
 */
const AnswerCardPretext: React.FC<AnswerCardPretextProps> = ({ answer, questionText, showActions = true }) => {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const { measureHeight, truncateToLines } = useTextMeasure({
    font: ANSWER_FONT,
    lineHeight: ANSWER_LINE_HEIGHT,
  });

  // Measure container width once with ResizeObserver
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.action-button') || 
        (e.target as HTMLElement).closest('.expand-toggle')) {
      return;
    }
    navigate(`/answer/${answer.id}`);
  };

  const authorName: string = ('user_fname' in answer && answer.user_fname)
    ? (answer.user_fname as string)
    : '4n0n';

  const authorFid = 'user_fid' in answer ? (answer.user_fid as number) : undefined;
  const isAnonymous = authorName === '4n0n' || authorName === 'Anonymous' || !authorFid;

  const [pfpUrl, setPfpUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!authorFid || isAnonymous) return;
    const fetchPfp = async () => {
      try {
        // TODO(account-root): /api/user/:fid/avatar is Farcaster-keyed; qbase
        // answers pass user_fid (a person key after the cutover) here.
        const response = await fetch(`/api/user/${authorFid}/avatar`);
        if (response.ok) {
          const data = await response.json();
          if (data.avatarUrl) setPfpUrl(data.avatarUrl);
        }
      } catch (error) {
        console.error('Failed to fetch pfp:', error);
      }
    };
    fetchPfp();
  }, [authorFid, isAnonymous]);

  const finalAvatarUrl = pfpUrl || `/4n0n.png`;
  const answerText = answer.value;

  // Pretext measurement — pure arithmetic, no layout reflow
  const { lineCount } = containerWidth > 0
    ? measureHeight(answerText, containerWidth)
    : { lineCount: 0 };

  const needsTruncation = lineCount > MAX_COLLAPSED_LINES;
  const displayText = (!expanded && needsTruncation && containerWidth > 0)
    ? truncateToLines(answerText, containerWidth, MAX_COLLAPSED_LINES)
    : answerText;

  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(prev => !prev);
  }, []);

  return (
    <div className="answer-card" onClick={handleCardClick}>
      <div className="answer-header">
        <div className="answer-author">
          <img
            src={finalAvatarUrl}
            alt={authorName}
            className="author-avatar"
          />
          <span className="author-name">{authorName}</span>
        </div>
      </div>

      {questionText && (
        <div className="answer-question-context">
          {questionText}
        </div>
      )}

      <div className="answer-content" ref={contentRef}>
        {displayText}
      </div>

      {needsTruncation && (
        <button
          className="expand-toggle"
          onClick={handleToggleExpand}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            background: 'none',
            border: 'none',
            color: 'var(--qbase-accent)',
            cursor: 'pointer',
            fontSize: '0.85rem',
            padding: '0.25rem 0',
            marginTop: '0.25rem',
          }}
        >
          {expanded ? (
            <><ChevronUp size={14} /> Show less</>
          ) : (
            <><ChevronDown size={14} /> Show more ({lineCount} lines)</>
          )}
        </button>
      )}

      {showActions && (
        <div className="answer-footer">
          <div className="action-button">
            <Heart size={18} />
            <span>0</span>
          </div>
          <div className="action-button">
            <Share2 size={18} />
          </div>
        </div>
      )}
    </div>
  );
};

export default AnswerCardPretext;
