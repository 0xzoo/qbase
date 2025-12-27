import React, { useState } from 'react';
import NoviceMode from './NoviceMode';
import ProMode from './ProMode';
import './QuizCreationLayout.css';

const QuizCreationLayout: React.FC = () => {
  const [mode, setMode] = useState<'novice' | 'pro'>('novice');

  return (
    <div className="quiz-creation-layout">
      <div className="mode-switcher">
        <button
          className={`mode-btn ${mode === 'novice' ? 'active' : ''}`}
          onClick={() => setMode('novice')}
        >
          Architect (Novice)
        </button>
        <button
          className={`mode-btn ${mode === 'pro' ? 'active' : ''}`}
          onClick={() => setMode('pro')}
        >
          Studio (Pro)
        </button>
      </div>

      <div className="mode-content">
        {mode === 'novice' ? <NoviceMode /> : <ProMode />}
      </div>
    </div>
  );
};

export default QuizCreationLayout;
