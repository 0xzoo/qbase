import React from 'react';
import './FAB.css';

interface FABProps {
  onClick?: () => void;
  icon?: React.ReactNode;
}

const FAB: React.FC<FABProps> = ({ onClick, icon }) => {
  return (
    <button className="fab" onClick={onClick}>
      {icon || <span>?</span>}
    </button>
  );
};

export default FAB;
