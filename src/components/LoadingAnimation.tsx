import React from 'react';
import './LoadingAnimation.css';

interface LoadingAnimationProps {
  variant?: 'full' | 'inline' | 'spinner';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Animated loading component with different variants:
 * - 'full': Full page centered animation with qbase branding
 * - 'inline': Inline skeleton-like pulse animation
 * - 'spinner': Simple spinning animation
 */
const LoadingAnimation: React.FC<LoadingAnimationProps> = ({
  variant = 'full',
  size = 'md',
  className = ''
}) => {
  if (variant === 'spinner') {
    return (
      <div className={`loading-spinner-anim ${size} ${className}`}>
        <div className="spinner-ring" />
      </div>
    );
  }

  if (variant === 'inline') {
    return (
      <div className={`loading-inline ${size} ${className}`}>
        <div className="pulse-bar" />
        <div className="pulse-bar short" />
      </div>
    );
  }

  // Full page loading
  return (
    <div className={`loading-full ${className}`}>
      <div className="loading-content">
        <div className="loading-logo">
          <svg 
            width="48" 
            height="48" 
            viewBox="0 0 100 100" 
            fill="none" 
            xmlns="http://www.w3.org/2000/svg"
            className="logo-svg"
          >
            <circle 
              cx="50" 
              cy="50" 
              r="45" 
              stroke="currentColor" 
              strokeWidth="6"
              strokeLinecap="round"
              className="logo-circle"
            />
            <text 
              x="50" 
              y="62" 
              textAnchor="middle" 
              fontSize="36" 
              fontWeight="700" 
              fill="currentColor"
              className="logo-text"
            >
              q
            </text>
          </svg>
        </div>
        <div className="loading-dots">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      </div>
    </div>
  );
};

export default LoadingAnimation;

