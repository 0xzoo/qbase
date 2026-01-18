import React from 'react';
import { Link } from 'react-router-dom';
import './TopicTag.css';

export interface TopicTagProps {
  /** Topic name to display */
  name: string;
  /** Topic ID for linking (optional - if not provided, uses name in URL) */
  topicId?: number;
  /** Size variant */
  size?: 'small' | 'medium';
  /** Whether to show the # prefix */
  showHash?: boolean;
  /** Optional click handler (if provided, overrides default navigation) */
  onClick?: (e: React.MouseEvent) => void;
  /** Whether the tag is clickable */
  clickable?: boolean;
  /** Additional CSS class */
  className?: string;
}

/**
 * TopicTag - A pill-shaped tag for displaying topic names
 * 
 * Used in:
 * - QuestionCard (to show question topics)
 * - TopicCard (for related topics)
 * - Search filters (for active topic filters)
 */
export const TopicTag: React.FC<TopicTagProps> = ({
  name,
  topicId,
  size = 'small',
  showHash = true,
  onClick,
  clickable = true,
  className = '',
}) => {
  const displayName = showHash ? `#${name}` : name;
  const topicUrl = `/topics/${encodeURIComponent(name.toLowerCase())}`;

  const handleClick = (e: React.MouseEvent) => {
    if (onClick) {
      e.preventDefault();
      e.stopPropagation();
      onClick(e);
    } else {
      // Stop propagation so clicking topic doesn't trigger parent card click
      e.stopPropagation();
    }
  };

  const tagClass = `topic-tag topic-tag--${size} ${clickable ? 'topic-tag--clickable' : ''} ${className}`.trim();

  if (!clickable) {
    return (
      <span className={tagClass}>
        {displayName}
      </span>
    );
  }

  return (
    <Link
      to={topicUrl}
      className={tagClass}
      onClick={handleClick}
    >
      {displayName}
    </Link>
  );
};

export default TopicTag;
