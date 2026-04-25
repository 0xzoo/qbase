import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import './FAB.css';

interface FABAction {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

interface FABProps {
  onClick?: () => void;
  onPollClick?: () => void;
  icon?: React.ReactNode;
}

const FAB: React.FC<FABProps> = ({ onClick, onPollClick, icon }) => {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);

  const toggle = () => setIsOpen(prev => !prev);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [isOpen]);

  const actions: FABAction[] = [
    {
      icon: '📝',
      label: 'Ask',
      onClick: () => {
        setIsOpen(false);
        onClick?.();
      },
    },
    {
      icon: '📊',
      label: 'Poll',
      onClick: () => {
        setIsOpen(false);
        if (onPollClick) {
          onPollClick();
        } else {
          navigate('/create-poll');
        }
      },
    },
  ];

  return (
    <div className="fab-container" ref={containerRef}>
      {/* Speed dial actions — positioned above the FAB via CSS */}
      <div className={`fab-actions ${isOpen ? 'fab-actions--open' : ''}`}>
        {actions.map((action, i) => (
          <button
            key={action.label}
            className="fab-action"
            onClick={action.onClick}
            style={{ transitionDelay: isOpen ? `${i * 50}ms` : '0ms' }}
          >
            <span className="fab-action__label">{action.label}</span>
            <span className="fab-action__icon">{action.icon}</span>
          </button>
        ))}
      </div>

      {/* Main FAB button */}
      <button className="fab" onClick={toggle}>
        <span className={`fab__icon ${isOpen ? 'fab__icon--open' : ''}`}>
          {icon || (isOpen ? '✕' : '?')}
        </span>
      </button>
    </div>
  );
};

export default FAB;
