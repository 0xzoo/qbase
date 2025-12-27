import React from 'react';
import { HelpCircle } from 'lucide-react';
import './FAB.css';

interface FABProps {
  onClick?: () => void;
  icon?: React.ReactNode;
}

const FAB: React.FC<FABProps> = ({ onClick, icon }) => {
  return (
    <button className="fab" onClick={onClick}>
      {icon || <HelpCircle size={32} strokeWidth={2.5} color="#2b95d6" fill="white" />}
    </button>
  );
};

export default FAB;
