import React from 'react';
import { Sparkles } from 'lucide-react';

const QuizzesFeed: React.FC = () => {
  return (
    <div className="feed-placeholder" style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '4rem 2rem',
      textAlign: 'center',
      color: 'var(--qbase-text-secondary)'
    }}>
      <Sparkles size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
      <h3>Coming Soon</h3>
      <p>Quizzes are currently under development.</p>
    </div>
  );
};

export default QuizzesFeed;
