import React, { useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import NoviceMode from './NoviceMode';
import ProMode from './ProMode';
import './QuizCreationLayout.css';

export type QuizFormat = 'quiz' | 'poll' | 'survey';

export const FORMAT_INFO: Record<QuizFormat, { label: string; description: string }> = {
  quiz: { label: 'Quiz', description: 'Answers are private' },
  poll: { label: 'Poll', description: 'Answers are anonymous' },
  survey: { label: 'Survey', description: 'Answers are allowlisted' },
};

const QuizCreationLayout: React.FC = () => {
  const [mode, setMode] = useState<'novice' | 'pro'>('novice');
  const [format, setFormat] = useState<QuizFormat>('quiz');
  const { user, loginWithPasskey } = useAuth();

  const handleFormatChange = useCallback(
    (fmt: QuizFormat) => {
      // Survey requires a Quil identity (passkeyAddress) for encryption.
      // If the user doesn't have one, prompt them to create it first.
      if (fmt === 'survey' && !user?.passkeyAddress) {
        loginWithPasskey();
        return;
      }
      setFormat(fmt);
    },
    [user?.passkeyAddress, loginWithPasskey]
  );

  return (
    <div className="quiz-creation-layout">
      <div className="format-picker">
        <span className="format-label">Format:</span>
        <div className="format-options">
          {(Object.keys(FORMAT_INFO) as QuizFormat[]).map((fmt) => (
            <button
              key={fmt}
              className={`format-btn ${format === fmt ? 'active' : ''}`}
              onClick={() => handleFormatChange(fmt)}
            >
              <span className="format-btn-label">{FORMAT_INFO[fmt].label}</span>
              <span className="format-btn-desc">{FORMAT_INFO[fmt].description}</span>
            </button>
          ))}
        </div>
      </div>

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
        {mode === 'novice' ? <NoviceMode format={format} /> : <ProMode format={format} />}
      </div>
    </div>
  );
};

export default QuizCreationLayout;
