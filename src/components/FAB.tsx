import React from 'react';
import './FAB.css';

interface FABProps {
  onClick?: () => void;
  icon?: React.ReactNode;
}

const FAB: React.FC<FABProps> = ({ onClick, icon }) => {
  return (
    <button className="fab" onClick={() => onClick?.()}>
      <span className="fab__icon">
        {icon || '+'}
      </span>
    </button>
  );
};

export default FAB;
